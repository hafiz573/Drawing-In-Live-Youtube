'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const store = require('./db');
const google = require('./google');
const membership = require('./membership');
const auth = require('./auth');
const { attachSockets } = require('./rooms');

const PORT = Number(process.env.PORT) || 3000;
const VIEWS = path.join(__dirname, '..', 'views');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(auth.attachIdentities);
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

const page = (name) => (_req, res) => res.sendFile(path.join(VIEWS, name));

/**
 * Public origin used to build the shareable draw/overlay links.
 * PUBLIC_ORIGIN wins when set — behind a CDN or tunnel the forwarded headers
 * can point at an internal hostname, and a wrong link here is one a creator
 * would paste into OBS.
 */
function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.sendFile(path.join(VIEWS, 'landing.html'));
});
app.get('/login', (req, res) => {
  if (req.user && !req.query.next) return res.redirect('/dashboard');
  res.sendFile(path.join(VIEWS, 'login.html'));
});
// Publicly reachable without a session — Google's OAuth verification review
// fetches both of these directly.
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.get('/dashboard', auth.requireUser, page('dashboard.html'));
app.get('/join', page('join.html'));
app.get('/draw/:roomCode', page('draw.html'));
app.get('/overlay/:token', page('overlay.html'));

// ---------------------------------------------------------------------------
// Google OAuth
//
// role=creator -> signs in a YouTuber and creates/opens their room
// role=viewer  -> verifies a viewer's public YouTube identity for members-only rooms
// role=members -> incremental consent for the optional membership-read scope
// ---------------------------------------------------------------------------
function safeNext(raw, fallback) {
  const value = String(raw || '');
  // Only same-origin paths; never an absolute URL or a protocol-relative one.
  return /^\/(?!\/)[\w\-./?=&%#]*$/.test(value) ? value : fallback;
}

app.get('/auth/google', (req, res) => {
  if (!google.isConfigured()) {
    return res.status(503).sendFile(path.join(VIEWS, 'oauth-missing.html'));
  }

  const role = ['creator', 'viewer', 'members'].includes(req.query.role) ? req.query.role : 'creator';
  if (role === 'members' && !req.user) return res.redirect('/login');

  const next = safeNext(req.query.next, role === 'creator' ? '/dashboard' : '/');
  const scopes = role === 'members'
    ? [...google.BASE_SCOPES, google.MEMBERS_SCOPE]
    : google.BASE_SCOPES;

  const state = auth.beginOAuth(res, { role, next });
  res.redirect(google.buildAuthUrl({
    req,
    state,
    scopes,
    // A refresh token is only needed for the background member-list reads.
    offline: role === 'members',
    prompt: role === 'members' ? 'consent' : undefined,
  }));
});

app.get('/auth/google/callback', async (req, res) => {
  const flow = auth.completeOAuth(req, res, req.query.state);
  if (!flow) return res.redirect('/login?error=state');
  if (req.query.error) return res.redirect(`/login?error=${encodeURIComponent(req.query.error)}`);
  if (!req.query.code) return res.redirect('/login?error=nocode');

  try {
    const tokens = await google.exchangeCode(req, String(req.query.code));
    const scopes = String(tokens.scope || '').split(' ').filter(Boolean);
    const [profile, channel] = await Promise.all([
      google.fetchOpenIdProfile(tokens.access_token),
      google.fetchOwnChannel(tokens.access_token),
    ]);

    if (flow.role === 'viewer') {
      auth.setViewerSession(res, {
        googleSub: profile.googleSub,
        channelId: channel?.channelId || null,
        name: channel?.channelTitle || profile.displayName,
        avatar: channel?.channelAvatar || profile.avatarUrl,
      });
      return res.redirect(safeNext(flow.next, '/'));
    }

    const user = await store.upsertFromGoogle({
      ...profile,
      ...(channel || {}),
      scopes,
      refreshToken: tokens.refresh_token || null,
    });

    // A creator is also a viewer of their own room — give them both cookies.
    auth.setCreatorSession(res, user);
    auth.setViewerSession(res, {
      googleSub: profile.googleSub,
      channelId: user.channelId,
      name: user.channelTitle,
      avatar: user.channelAvatar,
    });

    if (flow.role === 'members') {
      membership.invalidate(user.id);
      return res.redirect('/dashboard?members=connected');
    }
    return res.redirect(safeNext(flow.next, '/dashboard'));
  } catch (err) {
    console.error('[oauth] callback failed:', err.message);
    return res.redirect('/login?error=exchange');
  }
});

app.post('/api/logout', (req, res) => {
  auth.clearAllSessions(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function publicUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    channelId: user.channelId,
    channelTitle: user.channelTitle,
    channelAvatar: user.channelAvatar,
    roomCode: user.roomCode,
    overlayToken: user.overlayToken,
    settings: user.settings,
    membersScopeGranted: user.grantedScopes.includes(google.MEMBERS_SCOPE) && user.hasRefreshToken,
  };
}

app.get('/api/session', (req, res) => {
  res.json({
    googleConfigured: google.isConfigured(),
    creator: req.user ? publicUser(req.user) : null,
    viewer: req.viewer || null,
  });
});

app.get('/api/me', auth.requireUser, (req, res) => {
  const origin = originOf(req);
  res.json({
    ...publicUser(req.user),
    drawUrl: `${origin}/draw/${req.user.roomCode}`,
    overlayUrl: `${origin}/overlay/${req.user.overlayToken}`,
  });
});

app.post('/api/settings', auth.requireUser, async (req, res) => {
  const body = req.body || {};
  const current = req.user.settings;
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };

  const settings = await store.saveSettings(req.user.id, {
    ...current,
    accessMode: body.accessMode === 'members' ? 'members' : 'public',
    membershipSource: ['auto', 'api', 'allowlist'].includes(body.membershipSource)
      ? body.membershipSource : current.membershipSource,
    locked: Boolean(body.locked),
    requireApproval: Boolean(body.requireApproval),
    showNames: Boolean(body.showNames),
    allowEraser: Boolean(body.allowEraser),
    canvasWidth: num(body.canvasWidth, current.canvasWidth, 320, 3840),
    canvasHeight: num(body.canvasHeight, current.canvasHeight, 180, 2160),
    maxBrush: num(body.maxBrush, current.maxBrush, 2, 120),
    cooldownMs: num(body.cooldownMs, current.cooldownMs, 0, 60000),
    strokeBudget: num(body.strokeBudget, current.strokeBudget, 0, 500),
    fadeSeconds: num(body.fadeSeconds, current.fadeSeconds, 0, 600),
    overlayBackground: typeof body.overlayBackground === 'string'
      ? body.overlayBackground.slice(0, 32) : current.overlayBackground,
  });

  res.json({ ok: true, settings });
});

app.post('/api/rotate/:what', auth.requireUser, async (req, res) => {
  const origin = originOf(req);
  if (req.params.what === 'overlay') {
    const token = await store.rotateOverlayToken(req.user.id);
    return res.json({ ok: true, overlayToken: token, overlayUrl: `${origin}/overlay/${token}` });
  }
  if (req.params.what === 'room') {
    const code = await store.rotateRoomCode(req.user.id);
    return res.json({ ok: true, roomCode: code, drawUrl: `${origin}/draw/${code}` });
  }
  res.status(400).json({ error: 'Target rotate tidak dikenal.' });
});

// --- members-only helpers ---------------------------------------------------
app.get('/api/members/status', auth.requireUser, async (req, res) => {
  const [status, allowlist] = await Promise.all([
    membership.apiStatus(req.user, { force: req.query.refresh === '1' }),
    store.listAllowedMembers(req.user.id),
  ]);
  res.json({ ...status, allowlist });
});

app.post('/api/members/allow', auth.requireUser, async (req, res) => {
  const channelId = String(req.body?.channelId || '').trim();
  if (!/^UC[\w-]{20,24}$/.test(channelId)) {
    return res.status(400).json({ error: 'Channel ID harus format UC… (24 karakter), bukan nama channel.' });
  }
  await store.addAllowedMember(req.user.id, channelId, String(req.body?.label || '').slice(0, 60));
  membership.invalidate(req.user.id);
  res.json({ ok: true, allowlist: await store.listAllowedMembers(req.user.id) });
});

app.delete('/api/members/allow/:channelId', auth.requireUser, async (req, res) => {
  await store.removeAllowedMember(req.user.id, req.params.channelId);
  membership.invalidate(req.user.id);
  res.json({ ok: true, allowlist: await store.listAllowedMembers(req.user.id) });
});

// --- viewer-facing room metadata (no auth; used by the join screen) ---------
app.get('/api/room/:code', async (req, res) => {
  const owner = await store.findByRoomCode(req.params.code);
  if (!owner) return res.status(404).json({ error: 'Room tidak ditemukan.' });

  const access = await membership.checkAccess(owner, req.viewer);
  res.json({
    roomCode: owner.roomCode,
    channelTitle: owner.channelTitle,
    channelAvatar: owner.channelAvatar,
    accessMode: owner.settings.accessMode,
    locked: owner.settings.locked,
    requireApproval: owner.settings.requireApproval,
    canvas: { width: owner.settings.canvasWidth, height: owner.settings.canvasHeight },
    maxBrush: owner.settings.maxBrush,
    allowEraser: owner.settings.allowEraser,
    access: { allowed: access.allowed, code: access.code, message: access.message },
    viewer: req.viewer ? { name: req.viewer.name, avatar: req.viewer.avatar, verified: Boolean(req.viewer.channelId) } : null,
  });
});

/** Compose health-check target. Reports unhealthy if Postgres is unreachable. */
app.get('/healthz', async (_req, res) => {
  try {
    await store.query('SELECT 1');
    res.json({ ok: true, db: 'up', uptime: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(VIEWS, '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Ada yang error di server.' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e5,
  pingInterval: 20000,
  pingTimeout: 25000,
});
attachSockets(io);

async function start() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('\n  ✕ DATABASE_URL belum diisi.\n');
    console.error('    Buat database Postgres gratis di neon.tech atau supabase.com,');
    console.error('    salin connection string-nya ke DATABASE_URL di file .env,');
    console.error('    lalu jalankan lagi. Detailnya ada di README.md bagian "Database".\n');
    process.exit(1);
  }

  await store.waitForDatabase();
  await store.migrate();
  console.log('[db] Postgres tersambung, skema siap.');

  // A port clash is the most common startup failure; an unhandled 'error' event
  // would otherwise dump a stack trace that buries the actual cause.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✕ Port ${PORT} sudah dipakai proses lain.\n`);
      console.error('    Kemungkinan server ini masih jalan di terminal lain.');
      console.error('    Tutup dengan Ctrl+C di terminal itu, atau cari & hentikan prosesnya:\n');
      console.error(`      Windows : netstat -ano | findstr :${PORT}   lalu   taskkill /PID <pid> /F`);
      console.error(`      macOS   : lsof -ti :${PORT} | xargs kill\n`);
      console.error(`    Atau jalankan di port lain:  PORT=3001 npm start`);
      console.error(`    (PowerShell:  $env:PORT="3001"; npm start)\n`);
    } else {
      console.error('\n[app] server error:', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Drawing In Live  →  http://localhost:${PORT}`);
    if (!google.isConfigured()) {
      console.log('  ⚠  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diisi — login Google nonaktif.');
      console.log('     Ikuti langkah di README.md bagian "Setup Google OAuth".\n');
    } else {
      console.log(`  Redirect URI: ${process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`}\n`);
    }
  });
}

function shutdown(signal) {
  console.log(`\n[app] ${signal} diterima, menutup koneksi…`);
  io.close();
  server.close(() => {
    store.pool.end().finally(() => process.exit(0));
  });
  // Don't let a stuck socket hold the container hostage.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('[app] gagal start:', err.message);
  process.exit(1);
});
