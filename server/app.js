'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./db');
const google = require('./google');
const membership = require('./membership');
const auth = require('./auth');
const live = require('./live');

const VIEWS = path.join(__dirname, '..', 'views');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Schema bootstrap
//
// A serverless instance has no startup hook, so the first request on a cold
// instance runs the migration. It is idempotent (CREATE TABLE IF NOT EXISTS)
// and memoised, so the cost is one round trip per instance, not per request.
// ---------------------------------------------------------------------------
let schemaReady = null;
app.use(async (_req, res, next) => {
  if (!schemaReady) {
    schemaReady = store.migrate().catch((err) => {
      schemaReady = null; // let the next request retry rather than wedge forever
      throw err;
    });
  }
  try {
    await schemaReady;
    next();
  } catch (err) {
    console.error('[db] migrasi gagal:', err.message);
    res.status(503).json({ error: 'Database belum siap. Coba lagi sebentar lagi.' });
  }
});

app.use(auth.attachIdentities);

// ---------------------------------------------------------------------------
// Asset versioning
//
// Pages reference `/static/...` by plain path. Cached aggressively, a browser
// would keep running yesterday's client code against today's server after a
// deploy — a genuinely nasty class of bug, because it only bites returning
// visitors. So every asset URL carries a version stamp that changes when the
// code does, which lets the files themselves be cached effectively forever
// while the HTML that names them is never cached.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ASSET_VERSION = (() => {
  const fromPlatform = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID;
  if (fromPlatform) return fromPlatform.slice(0, 12);
  // Locally, the newest mtime under public/ changes whenever you edit a file.
  try {
    const fs = require('fs');
    let newest = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    };
    walk(PUBLIC_DIR);
    return Math.round(newest).toString(36);
  } catch {
    return String(Date.now());
  }
})();

app.use('/static', express.static(PUBLIC_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '365d' : 0,
  etag: true,
}));

/** Rendered pages, with `?v=` stamped onto every asset reference. */
const pageCache = new Map();

function renderPage(name) {
  if (process.env.NODE_ENV === 'production' && pageCache.has(name)) return pageCache.get(name);
  const fs = require('fs');
  const html = fs.readFileSync(path.join(VIEWS, name), 'utf8')
    .replace(/(["'])(\/static\/[^"'?]+)\1/g, `$1$2?v=${ASSET_VERSION}$1`);
  pageCache.set(name, html);
  return html;
}

function sendPage(res, name) {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(renderPage(name));
}

const page = (name) => (_req, res) => sendPage(res, name);

// Shared with the OAuth layer so the links a creator copies and the redirect
// URI Google is handed can never disagree.
const { originOf, redirectUri, isPinned } = require('./origin');

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  sendPage(res, 'landing.html');
});
app.get('/login', (req, res) => {
  if (req.user && !req.query.next) return res.redirect('/dashboard');
  sendPage(res, 'login.html');
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
    return sendPage(res.status(503), 'oauth-missing.html');
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

app.post('/api/logout', (_req, res) => {
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
    // Public by definition — it travels in the authorisation URL anyway — and
    // showing it turns redirect_uri_mismatch from a guessing game into a
    // copy-paste fix.
    oauth: {
      redirectUri: redirectUri(req),
      pinned: isPinned(),
      requestHost: req.get('host'),
    },
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
    channelId: owner.channelId,
    channelTitle: owner.channelTitle,
    channelAvatar: owner.channelAvatar,
    accessMode: owner.settings.accessMode,
    locked: owner.settings.locked,
    requireApproval: owner.settings.requireApproval,
    canvas: { width: owner.settings.canvasWidth, height: owner.settings.canvasHeight },
    maxBrush: owner.settings.maxBrush,
    allowEraser: owner.settings.allowEraser,
    access: { allowed: access.allowed, code: access.code, message: access.message },
    viewer: req.viewer
      ? { name: req.viewer.name, avatar: req.viewer.avatar, verified: Boolean(req.viewer.channelId) }
      : null,
  });
});

// --- realtime (long-polling) -----------------------------------------------
live.mount(app, auth);

// --- health ----------------------------------------------------------------
app.get('/healthz', async (_req, res) => {
  try {
    await store.query('SELECT 1');
    res.json({ ok: true, db: 'up', uptime: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

// ---------------------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  sendPage(res.status(404), '404.html');
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Ada yang error di server.' });
});

module.exports = app;
