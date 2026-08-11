'use strict';

/**
 * Decides whether a given viewer may draw in a given creator's room.
 *
 * Members-only mode has two possible sources of truth, in this order:
 *
 *   1. The YouTube Members API (`members.list`). Authoritative, but it requires
 *      the creator's channel to be in the YouTube Partner Program *and* the
 *      creator to have granted the optional memberships scope.
 *   2. A manual allowlist of channel ids the creator maintains by hand. Always
 *      available, and the automatic fallback whenever (1) is not usable.
 *
 * Results from (1) are cached in memory so a busy room does not hammer the API.
 */

const store = require('./db');
const google = require('./google');

const CACHE_TTL_MS = 5 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

/** userId -> { ids:Set<string>, fetchedAt:number, error:string|null } */
const cache = new Map();

function cachedEntry(userId) {
  const entry = cache.get(userId);
  if (!entry) return null;
  const ttl = entry.error ? ERROR_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.fetchedAt > ttl) return null;
  return entry;
}

function humanReason(err) {
  switch (err.reason) {
    case 'channelMembershipsNotEnabled':
    case 'notPartner':
      return 'Channel ini belum memenuhi syarat Members API — butuh YouTube Partner Program '
        + 'dengan fitur membership aktif. Pakai daftar member manual di bawah.';

    // `forbidden` is what members.list actually returns for a channel that is
    // simply not eligible, which is by far the common case. Treating it as a
    // missing permission sent creators to re-grant a scope they already had.
    case 'forbidden':
      return 'YouTube menolak permintaan daftar member. Paling sering ini berarti channelmu belum '
        + 'memenuhi syarat membership (perlu YouTube Partner Program dengan fitur membership aktif). '
        + 'Pakai daftar member manual di bawah.';

    case 'insufficientPermissions':
    case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
      return 'Izin membership belum diberikan. Klik "Hubungkan cek member" di dashboard.';

    case 'accessNotConfigured':
    case 'SERVICE_DISABLED':
      return 'YouTube Data API v3 belum aktif di project Google Cloud kamu. Aktifkan di API Library.';

    case 'quotaExceeded':
      return 'Kuota YouTube API habis untuk hari ini. Sementara pakai daftar member manual.';

    default:
      return err.message || 'Tidak bisa membaca daftar member dari YouTube.';
  }
}

/**
 * Fetches (and caches) the creator's live member list.
 * @returns {Promise<{ids:Set<string>|null, error:string|null}>}
 */
async function loadMemberIds(user, { force = false } = {}) {
  if (!force) {
    const hit = cachedEntry(user.id);
    if (hit) return { ids: hit.ids, error: hit.error };
  }

  if (!google.isConfigured()) {
    return { ids: null, error: 'Google OAuth belum dikonfigurasi di server.' };
  }
  if (!user.grantedScopes.includes(google.MEMBERS_SCOPE)) {
    return { ids: null, error: 'Izin membership belum diberikan. Klik "Hubungkan cek member" di dashboard.' };
  }

  const refreshToken = await store.getRefreshToken(user.id);
  if (!refreshToken) {
    return { ids: null, error: 'Sesi Google untuk cek member sudah kedaluwarsa. Hubungkan ulang di dashboard.' };
  }

  try {
    const { access_token: accessToken } = await google.refreshAccessToken(refreshToken);
    const ids = await google.listMemberChannelIds(accessToken);
    cache.set(user.id, { ids, fetchedAt: Date.now(), error: null });
    return { ids, error: null };
  } catch (err) {
    // A dead refresh token is worth clearing so the UI can prompt a reconnect.
    if (err.details?.error === 'invalid_grant') {
      await store.clearRefreshToken(user.id).catch(() => {});
    }
    const message = humanReason(err);
    cache.set(user.id, { ids: null, fetchedAt: Date.now(), error: message });
    console.warn('[membership] gagal membaca members untuk', user.id, '-', message);
    return { ids: null, error: message };
  }
}

/**
 * @param {object} user      creator record
 * @param {object|null} viewer  { channelId, name } from the viewer's signed cookie
 * @returns {Promise<{allowed:boolean, code:string, message:string, via?:string}>}
 */
async function checkAccess(user, viewer) {
  const settings = user.settings;
  if (settings.accessMode !== 'members') {
    return { allowed: true, code: 'public', message: '', via: 'public' };
  }

  if (!viewer) {
    return {
      allowed: false,
      code: 'login_required',
      message: 'Room ini khusus member. Login dengan Google dulu supaya kami bisa cek status membership kamu.',
    };
  }
  if (!viewer.channelId) {
    return {
      allowed: false,
      code: 'no_channel',
      message: 'Akun Google kamu belum punya channel YouTube, jadi status member tidak bisa dicek.',
    };
  }

  // The creator themselves is always allowed into their own room.
  if (user.channelId && viewer.channelId === user.channelId) {
    return { allowed: true, code: 'owner', message: '', via: 'owner' };
  }

  const source = settings.membershipSource || 'auto';

  if (source !== 'api' && await store.isAllowlisted(user.id, viewer.channelId)) {
    return { allowed: true, code: 'allowlist', message: '', via: 'allowlist' };
  }

  if (source === 'allowlist') {
    return {
      allowed: false,
      code: 'not_member',
      message: 'Channel kamu belum ada di daftar member yang diizinkan host.',
    };
  }

  const { ids, error } = await loadMemberIds(user);
  if (ids) {
    if (ids.has(viewer.channelId)) return { allowed: true, code: 'member', message: '', via: 'api' };
    return {
      allowed: false,
      code: 'not_member',
      message: 'Kamu belum jadi member channel ini. Join membership dulu, lalu refresh halaman ini.',
    };
  }

  // API unavailable. In 'auto' we already tried the allowlist above and missed.
  return {
    allowed: false,
    code: source === 'api' ? 'check_failed' : 'not_member',
    message: source === 'api'
      ? `Cek membership gagal: ${error}`
      : 'Kamu belum jadi member channel ini (atau belum ada di daftar manual host).',
  };
}

/** Dashboard diagnostics: is the live API path usable right now? */
async function apiStatus(user, { force = false } = {}) {
  if (!user.grantedScopes.includes(google.MEMBERS_SCOPE)) {
    return { connected: false, ok: false, count: 0, error: 'Izin cek member belum dihubungkan.' };
  }
  const { ids, error } = await loadMemberIds(user, { force });
  return { connected: true, ok: Boolean(ids), count: ids ? ids.size : 0, error };
}

function invalidate(userId) {
  cache.delete(userId);
}

module.exports = { checkAccess, apiStatus, invalidate };
