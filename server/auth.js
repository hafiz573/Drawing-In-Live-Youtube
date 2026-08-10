'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const store = require('./db');

const CREATOR_COOKIE = 'dil_creator';
const VIEWER_COOKIE = 'dil_viewer';
const OAUTH_COOKIE = 'dil_oauth';

const CREATOR_DAYS = 14;
const VIEWER_DAYS = 30;

const SECRET = (() => {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 16) return configured;
  console.warn('[auth] SESSION_SECRET belum diisi — memakai secret sementara. Sesi akan hilang tiap restart.');
  return crypto.randomBytes(32).toString('hex');
})();

const baseCookie = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
});

// ---------------------------------------------------------------------------
// Creator session
// ---------------------------------------------------------------------------
function setCreatorSession(res, user) {
  const token = jwt.sign({ sub: user.id }, SECRET, { expiresIn: `${CREATOR_DAYS}d` });
  res.cookie(CREATOR_COOKIE, token, { ...baseCookie(), maxAge: CREATOR_DAYS * 864e5 });
}

async function creatorFromToken(token) {
  if (!token) return null;
  let sub;
  try {
    sub = jwt.verify(token, SECRET).sub;
  } catch {
    return null;
  }
  try {
    return await store.findById(sub);
  } catch (err) {
    console.error('[auth] gagal memuat creator:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Viewer identity
//
// A viewer who signs in with Google gets their *public* YouTube identity baked
// into a signed cookie. We never write it to the database — the cookie is the
// only place it lives, and it expires on its own.
// ---------------------------------------------------------------------------
function setViewerSession(res, identity) {
  const token = jwt.sign(
    { cid: identity.channelId || null, n: identity.name, a: identity.avatar || null, sub: identity.googleSub },
    SECRET,
    { expiresIn: `${VIEWER_DAYS}d` },
  );
  res.cookie(VIEWER_COOKIE, token, { ...baseCookie(), maxAge: VIEWER_DAYS * 864e5 });
}

function viewerFromToken(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, SECRET);
    return { channelId: p.cid || null, name: p.n, avatar: p.a || null, googleSub: p.sub };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth state — a nonce we hand to Google and verify on the way back, so a
// third party can't replay a callback at us.
// ---------------------------------------------------------------------------
function beginOAuth(res, payload) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign({ ...payload, nonce }, SECRET, { expiresIn: '10m' });
  res.cookie(OAUTH_COOKIE, token, { ...baseCookie(), maxAge: 10 * 60 * 1000 });
  return Buffer.from(JSON.stringify({ nonce })).toString('base64url');
}

function completeOAuth(req, res, state) {
  res.clearCookie(OAUTH_COOKIE, baseCookie());
  let claimed;
  try {
    claimed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  let stored;
  try {
    stored = jwt.verify(req.cookies?.[OAUTH_COOKIE], SECRET);
  } catch {
    return null;
  }
  // Constant-time compare so a mismatched nonce leaks nothing by timing.
  const a = Buffer.from(String(claimed?.nonce || ''));
  const b = Buffer.from(String(stored?.nonce || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return stored;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
async function attachIdentities(req, _res, next) {
  try {
    req.user = await creatorFromToken(req.cookies?.[CREATOR_COOKIE]);
    req.viewer = viewerFromToken(req.cookies?.[VIEWER_COOKIE]);
    next();
  } catch (err) {
    next(err);
  }
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Kamu harus login dulu.' });
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function clearAllSessions(res) {
  res.clearCookie(CREATOR_COOKIE, baseCookie());
  res.clearCookie(VIEWER_COOKIE, baseCookie());
}

module.exports = {
  CREATOR_COOKIE,
  VIEWER_COOKIE,
  setCreatorSession,
  setViewerSession,
  beginOAuth,
  completeOAuth,
  attachIdentities,
  requireUser,
  clearAllSessions,
};
