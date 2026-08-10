'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Connection
//
// Points at a managed Postgres (Neon, Supabase, Railway, RDS…) via DATABASE_URL.
// Falls back to discrete PG* variables so a local Postgres still works.
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || '';

/**
 * Managed Postgres almost always requires TLS; a database on localhost almost
 * never offers it. Decide from the URL unless DB_SSL says otherwise.
 *
 * `rejectUnauthorized: false` is what Neon/Supabase pooler endpoints expect,
 * because their certificates are issued for the pooler host rather than the
 * per-project hostname in the connection string. Set DB_SSL=strict once you
 * have the provider's CA in the trust store to verify the chain properly.
 */
function sslConfig() {
  const mode = String(process.env.DB_SSL || '').toLowerCase();
  if (mode === 'false' || mode === 'disable') return false;
  if (mode === 'strict') return { rejectUnauthorized: true };
  if (mode === 'true' || mode === 'require') return { rejectUnauthorized: false };

  if (!DATABASE_URL) return false;
  if (/sslmode=disable/i.test(DATABASE_URL)) return false;

  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(DATABASE_URL);
  return isLocal ? false : { rejectUnauthorized: false };
}

/**
 * We configure TLS through the `ssl` option, so `sslmode` in the URL is
 * redundant — and pg 9 / pg-connection-string 3 will change what those aliases
 * mean. Dropping the parameter keeps behaviour stable across that upgrade and
 * silences the deprecation warning.
 */
function connectionStringWithoutSslMode(url) {
  return url.replace(/([?&])sslmode=[^&]*&?/gi, (_m, sep) => (sep === '?' ? '?' : '&'))
    .replace(/[?&]$/, '');
}

const pool = new Pool({
  ...(DATABASE_URL
    ? { connectionString: connectionStringWithoutSslMode(DATABASE_URL) }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'drawinglive',
      }),
  ssl: sslConfig(),
  // On a serverless host every concurrent invocation carries its own pool, so a
  // large `max` multiplies into hundreds of database connections. Stay tiny
  // there and rely on the provider's connection pooler.
  max: Number(process.env.PGPOOL_MAX) || (process.env.VERCEL ? 2 : 8),
  idleTimeoutMillis: process.env.VERCEL ? 8000 : 20000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
});

// Neon hands out two endpoints. The direct one caps out quickly under
// serverless fan-out; the `-pooler` one is built for it.
if (process.env.VERCEL && /neon\.tech/.test(DATABASE_URL) && !/-pooler\./.test(DATABASE_URL)) {
  console.warn('[db] DATABASE_URL memakai endpoint Neon langsung. Di Vercel, pakai connection string yang ada "-pooler" agar tidak kehabisan koneksi.');
}

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const query = (text, params) => pool.query(text, params);

/**
 * Waits for Postgres to accept connections. Serverless providers suspend idle
 * databases, so the first connection after a while can take several seconds —
 * retrying beats crash-looping on a cold start.
 */
async function waitForDatabase({ attempts = 20, delayMs = 1500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      if (i === 1 || i % 5 === 0) {
        console.log(`[db] menunggu Postgres… (percobaan ${i}/${attempts}) — ${err.code || err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
//
// We deliberately store the bare minimum about a creator: the Google account id
// we authenticate against, and the *public* YouTube channel title/avatar we show
// on their dashboard and overlay. No passwords (Google handles that), and no
// viewer rows at all — a viewer's identity lives only in their own signed cookie.
// ---------------------------------------------------------------------------
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id             UUID PRIMARY KEY,
      google_sub     TEXT NOT NULL UNIQUE,
      email          TEXT,
      display_name   TEXT NOT NULL,
      avatar_url     TEXT,
      yt_channel_id  TEXT,
      yt_title       TEXT,
      yt_avatar_url  TEXT,
      refresh_token  TEXT,
      granted_scopes TEXT NOT NULL DEFAULT '',
      room_code      TEXT NOT NULL UNIQUE,
      overlay_token  TEXT NOT NULL UNIQUE,
      settings       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at     BIGINT NOT NULL,
      last_login_at  BIGINT NOT NULL
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_users_room ON users(room_code)');
  await query('CREATE INDEX IF NOT EXISTS idx_users_overlay ON users(overlay_token)');

  // Manual member allowlist. Used when the YouTube Members API is unavailable
  // for a channel (it requires Partner status), or when a creator simply wants
  // to hand-pick who gets to draw.
  await query(`
    CREATE TABLE IF NOT EXISTS member_allow (
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      added_at   BIGINT NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );
  `);

  // -------------------------------------------------------------------------
  // Live room state.
  //
  // On a serverless host there is no process to hold a room in memory, so the
  // canvas, the people in it, and the change log all live here. Clients follow
  // `room_events` by sequence number instead of a socket.
  // -------------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS room_events (
      seq        BIGSERIAL PRIMARY KEY,
      room_code  TEXT NOT NULL,
      kind       TEXT NOT NULL,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_events_room ON room_events(room_code, seq)');
  await query('CREATE INDEX IF NOT EXISTS idx_events_age ON room_events(created_at)');

  await query(`
    CREATE TABLE IF NOT EXISTS strokes (
      room_code  TEXT NOT NULL,
      stroke_id  TEXT NOT NULL,
      viewer_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      size       REAL NOT NULL,
      tool       TEXT NOT NULL,
      pts        JSONB NOT NULL DEFAULT '[]'::jsonb,
      done       BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL,
      ord        BIGSERIAL,
      PRIMARY KEY (room_code, stroke_id)
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_strokes_room ON strokes(room_code, ord)');
  await query('CREATE INDEX IF NOT EXISTS idx_strokes_viewer ON strokes(room_code, viewer_id, ord)');

  await query(`
    CREATE TABLE IF NOT EXISTS room_viewers (
      room_code  TEXT NOT NULL,
      viewer_id  TEXT NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      avatar     TEXT,
      channel_id TEXT,
      access_via TEXT NOT NULL DEFAULT 'public',
      approved   BOOLEAN NOT NULL DEFAULT true,
      banned     BOOLEAN NOT NULL DEFAULT false,
      joined_at  BIGINT NOT NULL,
      last_seen  BIGINT NOT NULL,
      PRIMARY KEY (room_code, viewer_id)
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_viewers_room ON room_viewers(room_code, last_seen)');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  // --- access ---
  accessMode: 'public',     // 'public' = siapa saja, 'members' = member YouTube saja
  membershipSource: 'auto', // 'auto' = API dulu lalu allowlist, 'api', 'allowlist'
  locked: false,            // true = kanvas dibekukan, tidak ada yang bisa menggambar
  requireApproval: false,   // owner harus menyetujui tiap viewer sebelum bisa menggambar

  // --- canvas ---
  canvasWidth: 1280,
  canvasHeight: 720,
  overlayBackground: 'transparent', // 'transparent' atau warna CSS untuk source OBS
  showNames: true,
  fadeSeconds: 0,           // stroke memudar setelah N detik (0 = tidak pernah)

  // --- brush / anti-spam ---
  maxBrush: 28,
  allowEraser: true,
  cooldownMs: 0,            // jeda paksa antar stroke per viewer
  strokeBudget: 40,         // maksimum stroke per viewer di kanvas (0 = tanpa batas)
};

/** Alphabet without look-alikes (0/O, 1/I/l) so codes are safe to read out loud on stream. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

async function uniqueRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = randomCode(6);
    const { rowCount } = await query('SELECT 1 FROM users WHERE room_code = $1', [code]);
    if (!rowCount) return code;
  }
  throw new Error('Could not allocate a unique room code');
}

const newOverlayToken = () => crypto.randomBytes(24).toString('hex');

function shapeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    googleSub: row.google_sub,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    channelId: row.yt_channel_id,
    channelTitle: row.yt_title || row.display_name,
    channelAvatar: row.yt_avatar_url || row.avatar_url,
    hasRefreshToken: Boolean(row.refresh_token),
    grantedScopes: String(row.granted_scopes || '').split(' ').filter(Boolean),
    roomCode: row.room_code,
    overlayToken: row.overlay_token,
    settings: { ...DEFAULT_SETTINGS, ...(row.settings || {}) },
    createdAt: Number(row.created_at),
    lastLoginAt: Number(row.last_login_at),
  };
}

async function one(sql, params) {
  const { rows } = await query(sql, params);
  return shapeUser(rows[0]);
}

module.exports = {
  pool,
  query,
  migrate,
  waitForDatabase,
  DEFAULT_SETTINGS,
  uniqueRoomCode,
  newOverlayToken,

  /**
   * Creates the account on first Google sign-in, or refreshes the cached public
   * profile on every subsequent one. `profile.refreshToken` is only written when
   * Google actually hands us one (i.e. on consent) — COALESCE keeps the stored
   * one alive when it doesn't.
   */
  async upsertFromGoogle(profile) {
    const now = Date.now();
    const scopes = (profile.scopes || []).join(' ');
    const { rows } = await query(`
      INSERT INTO users (id, google_sub, email, display_name, avatar_url, yt_channel_id, yt_title,
                         yt_avatar_url, refresh_token, granted_scopes, room_code, overlay_token,
                         settings, created_at, last_login_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '{}'::jsonb, $13, $13)
      ON CONFLICT (google_sub) DO UPDATE SET
        email          = COALESCE(EXCLUDED.email, users.email),
        display_name   = COALESCE(EXCLUDED.display_name, users.display_name),
        avatar_url     = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
        yt_channel_id  = COALESCE(EXCLUDED.yt_channel_id, users.yt_channel_id),
        yt_title       = COALESCE(EXCLUDED.yt_title, users.yt_title),
        yt_avatar_url  = COALESCE(EXCLUDED.yt_avatar_url, users.yt_avatar_url),
        refresh_token  = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
        granted_scopes = CASE WHEN EXCLUDED.granted_scopes = '' THEN users.granted_scopes
                              ELSE EXCLUDED.granted_scopes END,
        last_login_at  = EXCLUDED.last_login_at
      RETURNING *;
    `, [
      crypto.randomUUID(),
      profile.googleSub,
      profile.email || null,
      profile.displayName || 'Creator',
      profile.avatarUrl || null,
      profile.channelId || null,
      profile.channelTitle || null,
      profile.channelAvatar || null,
      profile.refreshToken || null,
      scopes,
      await uniqueRoomCode(),
      newOverlayToken(),
      now,
    ]);
    return shapeUser(rows[0]);
  },

  findById: (id) => one('SELECT * FROM users WHERE id = $1', [id]),
  findByRoomCode: (code) => one('SELECT * FROM users WHERE room_code = $1', [String(code || '').toUpperCase()]),
  findByOverlayToken: (token) => one('SELECT * FROM users WHERE overlay_token = $1', [String(token || '')]),

  async getRefreshToken(userId) {
    const { rows } = await query('SELECT refresh_token FROM users WHERE id = $1', [userId]);
    return rows[0]?.refresh_token || null;
  },

  async clearRefreshToken(userId) {
    await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [userId]);
  },

  async saveSettings(userId, settings) {
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    await query('UPDATE users SET settings = $1::jsonb WHERE id = $2', [JSON.stringify(merged), userId]);
    return merged;
  },

  async rotateOverlayToken(userId) {
    const token = newOverlayToken();
    await query('UPDATE users SET overlay_token = $1 WHERE id = $2', [token, userId]);
    return token;
  },

  async rotateRoomCode(userId) {
    const code = await uniqueRoomCode();
    await query('UPDATE users SET room_code = $1 WHERE id = $2', [code, userId]);
    return code;
  },

  // --- manual member allowlist ---
  async listAllowedMembers(userId) {
    const { rows } = await query(
      'SELECT channel_id, label, added_at FROM member_allow WHERE user_id = $1 ORDER BY added_at DESC',
      [userId],
    );
    return rows.map((r) => ({ channel_id: r.channel_id, label: r.label, added_at: Number(r.added_at) }));
  },

  async addAllowedMember(userId, channelId, label = '') {
    await query(`
      INSERT INTO member_allow (user_id, channel_id, label, added_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, channel_id) DO UPDATE SET label = EXCLUDED.label
    `, [userId, channelId, label, Date.now()]);
  },

  async removeAllowedMember(userId, channelId) {
    await query('DELETE FROM member_allow WHERE user_id = $1 AND channel_id = $2', [userId, channelId]);
  },

  async isAllowlisted(userId, channelId) {
    if (!channelId) return false;
    const { rowCount } = await query(
      'SELECT 1 FROM member_allow WHERE user_id = $1 AND channel_id = $2',
      [userId, channelId],
    );
    return rowCount > 0;
  },
};
