'use strict';

/**
 * Where this app believes it lives.
 *
 * This has to be *stable*, not merely correct for the current request. Vercel
 * serves the same deployment under several hostnames — the production alias,
 * a per-deployment URL, and a branch alias — so deriving the origin from the
 * incoming Host header makes the OAuth redirect_uri change depending on which
 * link the visitor happened to open. Google requires an exact match against a
 * registered URI, so that shows up as an intermittent
 * `Error 400: redirect_uri_mismatch` — working from one URL, failing from
 * another, with nothing in the app having changed.
 *
 * Resolution order, most explicit first:
 *   1. PUBLIC_ORIGIN                       — set it, and nothing else matters
 *   2. VERCEL_PROJECT_PRODUCTION_URL       — the stable production alias
 *   3. RENDER_EXTERNAL_URL                 — Render's equivalent
 *   4. the request's own host              — local dev, and a last resort
 */

function fromEnv() {
  if (process.env.PUBLIC_ORIGIN) {
    return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  }
  return null;
}

function originOf(req) {
  const stable = fromEnv();
  if (stable) return stable;
  const proto = req?.get?.('x-forwarded-proto')?.split(',')[0].trim() || req?.protocol || 'http';
  const host = req?.get?.('host') || `localhost:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}

/** The exact string that must be registered in the Google Cloud console. */
function redirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI.trim();
  return `${originOf(req)}/auth/google/callback`;
}

/** True when the origin is pinned by config rather than sniffed per request. */
const isPinned = () => Boolean(process.env.OAUTH_REDIRECT_URI || fromEnv());

module.exports = { originOf, redirectUri, isPinned };
