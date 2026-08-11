'use strict';

/**
 * Thin wrapper around Google OAuth 2.0 + the bits of the YouTube Data API we
 * need. Uses global fetch (Node 18+) instead of the googleapis SDK to keep the
 * dependency surface — and therefore the trust surface — small.
 *
 * Permission policy (surfaced verbatim on the login page):
 *   - We request READ-ONLY scopes only.
 *   - `youtube.readonly` is used for one thing: reading the signed-in account's
 *     own public channel title + avatar so we can show it on the dashboard,
 *     the overlay and the drawing room.
 *   - No passwords ever touch this server (Google handles authentication).
 *   - The optional membership scope is only ever requested if a creator
 *     explicitly turns on members-only mode, and can be revoked at any time.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * What an ordinary sign-in asks for. All three are non-sensitive, which means
 * Google requires no verification for them and shows no "unverified app"
 * interstitial — sign-in is simply clean.
 */
const BASE_SCOPES = ['openid', 'email', 'profile'];

/**
 * Read-only access to the signed-in account's own YouTube channel, used solely
 * to read its public title and thumbnail.
 *
 * Sensitive, therefore deliberately NOT part of a normal sign-in. It is asked
 * for separately, through incremental consent, and only when someone actually
 * needs it: a creator who wants their channel identity shown instead of their
 * Google account name, or a viewer whose membership must be checked before
 * they may draw in a members-only room.
 */
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/**
 * Only requested via incremental consent when a creator enables members-only
 * mode. Also read-only — it lists the creator's own channel members.
 */
const MEMBERS_SCOPE = 'https://www.googleapis.com/auth/youtube.channel-memberships.creator';

/** Did this grant actually include permission to read the YouTube channel? */
const grantedYouTube = (scopes = []) => scopes.includes(YOUTUBE_SCOPE);

function clientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}
function clientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || '';
}
function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

const { redirectUri } = require('./origin');

function buildAuthUrl({ req, state, scopes, offline = false, prompt }) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    include_granted_scopes: 'true',
  });
  if (offline) params.set('access_type', 'offline');
  if (prompt) params.set('prompt', prompt);
  return `${AUTH_ENDPOINT}?${params}`;
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: 'invalid_response', raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Google returned ${res.status}`);
    err.status = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

async function exchangeCode(req, code) {
  return postForm(TOKEN_ENDPOINT, {
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });
}

async function refreshAccessToken(refreshToken) {
  return postForm(TOKEN_ENDPOINT, {
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'refresh_token',
  });
}

async function revokeToken(token) {
  try {
    await postForm(REVOKE_ENDPOINT, { token });
  } catch {
    /* Best effort — a token that is already dead is fine. */
  }
}

async function apiGet(url, accessToken) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || json?.error?.status || `http_${res.status}`;
    const err = new Error(json?.error?.message || `YouTube API error (${res.status})`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return json;
}

/** Basic OpenID profile: name, email, picture. */
async function fetchOpenIdProfile(accessToken) {
  const info = await apiGet(USERINFO_ENDPOINT, accessToken);
  return {
    googleSub: info.sub,
    email: info.email || null,
    displayName: info.name || info.given_name || 'Creator',
    avatarUrl: info.picture || null,
  };
}

/**
 * The signed-in account's own YouTube channel. Public data only (title +
 * thumbnail). Returns null when the account has no channel — plenty of Google
 * accounts don't, and that must not break sign-in.
 */
async function fetchOwnChannel(accessToken) {
  try {
    const data = await apiGet(`${YT_API}/channels?part=snippet&mine=true&maxResults=1`, accessToken);
    const item = data.items?.[0];
    // An empty list really does mean this Google account has no channel.
    if (!item) return { ok: false, reason: 'nochannel', channel: null };

    const thumbs = item.snippet?.thumbnails || {};
    return {
      ok: true,
      reason: null,
      channel: {
        channelId: item.id,
        channelTitle: item.snippet?.title || null,
        channelAvatar: thumbs.medium?.url || thumbs.default?.url || null,
        customUrl: item.snippet?.customUrl || null,
      },
    };
  } catch (err) {
    // Distinguish the failure modes. Collapsing them all into "no channel" sends
    // people hunting for a problem with their YouTube account when the actual
    // fault is a disabled API or a scope that was never granted.
    const blob = `${err.reason || ''} ${err.message || ''}`.toLowerCase();
    let reason = 'failed';
    if (/accessnotconfigured|has not been used in project|service_disabled|is disabled/.test(blob)) {
      reason = 'apidisabled';
    } else if (/insufficient|forbidden|scope|unauthorized|401/.test(blob)) {
      reason = 'noscope';
    } else if (/quota/.test(blob)) {
      reason = 'quota';
    }
    console.warn(`[google] channels.list gagal (${reason}):`, err.reason || err.message);
    return { ok: false, reason, channel: null };
  }
}

/**
 * Every channel id that currently holds a paid membership on the caller's
 * channel. Requires MEMBERS_SCOPE *and* a channel eligible for the Members API
 * (YouTube Partner Program). Throws with a `.reason` the caller can show.
 */
async function listMemberChannelIds(accessToken) {
  const ids = new Set();
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = `${YT_API}/members?part=snippet&maxResults=1000&mode=all_current` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await apiGet(url, accessToken);
    for (const item of data.items || []) {
      const id = item.snippet?.memberDetails?.channelId;
      if (id) ids.add(id);
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return ids;
}

module.exports = {
  BASE_SCOPES,
  YOUTUBE_SCOPE,
  MEMBERS_SCOPE,
  grantedYouTube,
  isConfigured,
  redirectUri,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  fetchOpenIdProfile,
  fetchOwnChannel,
  listMemberChannelIds,
};
