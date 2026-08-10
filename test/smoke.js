'use strict';

/**
 * End-to-end smoke test for the long-polling realtime layer.
 *
 * Verifies that a viewer's strokes reach an OBS overlay, that the event log
 * replays correctly for a late joiner, and that bad tokens/rooms/sessions are
 * refused. Assumes the server is running and a seeded creator row exists — see
 * the "Test" section of README.md for the seed snippet.
 *
 *   ROOM_CODE=XXXXXX OVERLAY_TOKEN=xxxx npm test
 *
 * Env: BASE_URL (default http://localhost:3000)
 *      ROOM_CODE (default SMOKE1)
 *      OVERLAY_TOKEN (default the seeded smoke token)
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ROOM_CODE = process.env.ROOM_CODE || 'SMOKE1';
const OVERLAY_TOKEN = process.env.OVERLAY_TOKEN || 'smoketoken0123456789abcdef0123456789abcdef';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✕\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/** Drains the log from `cursor`, returning every event seen within `ms`. */
async function collect(pollPath, cursor, ms = 4000) {
  const events = [];
  const deadline = Date.now() + ms;
  let at = cursor;
  while (Date.now() < deadline) {
    const sep = pollPath.includes('?') ? '&' : '?';
    const res = await api(`${pollPath}${sep}cursor=${at}`);
    if (!res.ok) break;
    at = res.data.cursor ?? at;
    if (res.data.events?.length) {
      events.push(...res.data.events);
      break; // one non-empty batch is enough for the assertions below
    }
  }
  return { events, cursor: at };
}

async function main() {
  console.log(`\nSmoke test → ${BASE_URL} (room ${ROOM_CODE})\n`);

  // --- HTTP surface --------------------------------------------------------
  console.log('HTTP');
  const health = await api('/healthz');
  check('/healthz melaporkan database up', health.data.ok && health.data.db === 'up', JSON.stringify(health.data));

  const room = await api(`/api/room/${ROOM_CODE}`);
  check('/api/room mengembalikan metadata room', room.data.roomCode === ROOM_CODE, JSON.stringify(room.data));
  check('room default terbuka untuk publik', room.data.accessMode === 'public');
  check('akses diizinkan tanpa login di mode publik', room.data.access?.allowed === true);

  const missing = await api('/api/room/NOPE00');
  check('room tidak dikenal balas 404', missing.status === 404);

  const guarded = await api('/api/me');
  check('/api/me menolak tanpa sesi', guarded.status === 401, `status ${guarded.status}`);

  for (const path of ['/', '/privacy', '/terms', '/join', '/login']) {
    const page = await fetch(`${BASE_URL}${path}`);
    check(`halaman ${path} tampil`, page.status === 200, `status ${page.status}`);
  }

  // --- realtime ------------------------------------------------------------
  console.log('\nRealtime');
  const overlay = await api(`/api/live/overlay/${OVERLAY_TOKEN}/open`);
  check('overlay terbuka dengan token valid', overlay.ok && Boolean(overlay.data.settings), JSON.stringify(overlay.data).slice(0, 90));
  const overlayPoll = `/api/live/${ROOM_CODE}/poll?overlayToken=${OVERLAY_TOKEN}`;

  const join = await api(`/api/live/${ROOM_CODE}/join`, {
    method: 'POST',
    body: { viewerId: 'smoke-viewer-1', name: 'SmokeBot' },
  });
  check('viewer bergabung ke room publik', join.ok && Boolean(join.data.you?.id), JSON.stringify(join.data).slice(0, 90));
  check('viewer langsung disetujui saat moderasi mati', join.data.you?.approved === true);

  const viewerId = join.data.you.id;
  const strokeId = `${viewerId}#stroke1`;

  // Viewer draws; the overlay should see it in the log.
  const cursorBefore = overlay.data.cursor;
  const sent = await api(`/api/live/${ROOM_CODE}/stroke`, {
    method: 'POST',
    body: { viewerId, cid: 'stroke1', pts: [0.1, 0.1, 0.2, 0.2], color: '#ff3b1f', size: 8, tool: 'pen' },
  });
  check('goresan diterima server', sent.ok && sent.data.id === strokeId, JSON.stringify(sent.data));

  const seen = await collect(overlayPoll, cursorBefore);
  const strokeEvent = seen.events.find((e) => e.kind === 's');
  check('goresan sampai ke overlay lewat event log', Boolean(strokeEvent), `${seen.events.length} event`);
  check('id goresan dinamespace dengan id viewer', strokeEvent?.data.id === strokeId, strokeEvent?.data.id);
  check('titik-titik goresan diteruskan', strokeEvent?.data.pts.length === 4, JSON.stringify(strokeEvent?.data.pts));
  check('nama penggambar ikut terkirim', strokeEvent?.data.name === 'SmokeBot');

  // Second batch must append, not replace.
  await api(`/api/live/${ROOM_CODE}/stroke`, {
    method: 'POST',
    body: { viewerId, cid: 'stroke1', pts: [0.3, 0.35], done: true },
  });

  const late = await api(`/api/live/overlay/${OVERLAY_TOKEN}/open`);
  const stored = late.data.strokes?.find((s) => s.id === strokeId);
  check('overlay baru menerima snapshot kanvas', Boolean(stored), `${late.data.strokes?.length} goresan`);
  check('batch kedua menyambung, bukan menimpa', stored?.pts.length === 6, JSON.stringify(stored?.pts));
  check('goresan ditandai selesai', stored?.done === true);

  // Viewer removes their own work.
  const cleared = await api(`/api/live/${ROOM_CODE}/act`, {
    method: 'POST',
    body: { viewerId, action: 'clearMine' },
  });
  check('viewer bisa menghapus goresannya sendiri', cleared.ok && cleared.data.removed?.includes(strokeId), JSON.stringify(cleared.data));

  // Only this viewer's work should disappear — anything drawn by others in the
  // same room must survive, so assert on ownership rather than an empty canvas.
  const after = await api(`/api/live/overlay/${OVERLAY_TOKEN}/open`);
  const mineLeft = (after.data.strokes || []).filter((s) => s.viewerId === viewerId);
  check('goresan milik sendiri hilang dari kanvas', mineLeft.length === 0, `${mineLeft.length} tersisa`);

  // --- the long poll itself ------------------------------------------------
  // The whole design rests on a held request waking the moment something
  // happens. Prove both halves: it waits when idle, and it fires fast when not.
  console.log('\nLong-polling');
  const base = await api(`/api/live/overlay/${OVERLAY_TOKEN}/open`);
  const from = base.data.cursor;

  const idleStart = Date.now();
  const idle = await api(`${overlayPoll}&cursor=${from}`);
  const idleMs = Date.now() - idleStart;
  check('poll menahan koneksi saat tidak ada perubahan', idleMs > 3000, `balas setelah ${idleMs} ms`);
  check('poll idle balas tanpa event', (idle.data.events || []).length === 0);

  const waiting = api(`${overlayPoll}&cursor=${from}`);
  const wakeStart = Date.now();
  await new Promise((r) => setTimeout(r, 400));
  await api(`/api/live/${ROOM_CODE}/stroke`, {
    method: 'POST',
    body: { viewerId, cid: 'wake1', pts: [0.4, 0.4], done: true },
  });
  const woke = await waiting;
  const wakeMs = Date.now() - wakeStart;
  check('poll langsung bangun saat ada goresan baru', wakeMs < 2500, `bangun setelah ${wakeMs} ms`);
  check('event goresan ikut terbawa', (woke.data.events || []).some((e) => e.kind === 's'));

  await api(`/api/live/${ROOM_CODE}/act`, { method: 'POST', body: { viewerId, action: 'clearMine' } });

  // --- security ------------------------------------------------------------
  console.log('\nKeamanan');
  const badOverlay = await api('/api/live/overlay/token-palsu/open');
  check('token overlay palsu ditolak', badOverlay.status === 404 && badOverlay.data.code === 'bad_overlay_token');

  const badRoom = await api('/api/live/NOPE00/join', { method: 'POST', body: { viewerId: 'x', name: 'x' } });
  check('kode room tidak dikenal ditolak', badRoom.status === 404 && badRoom.data.code === 'no_room');

  const notOwner = await api(`/api/live/${ROOM_CODE}/owner`, { method: 'POST', body: { action: 'clear' } });
  check('perintah host ditolak tanpa sesi', notOwner.status === 401, `status ${notOwner.status}`);

  const notOwnerOpen = await api(`/api/live/${ROOM_CODE}/open`);
  check('dashboard room ditolak tanpa sesi', notOwnerOpen.status === 401, `status ${notOwnerOpen.status}`);

  const strangerPoll = await api(`/api/live/${ROOM_CODE}/poll?viewerId=belum-gabung&cursor=0`);
  check('polling ditolak untuk yang belum bergabung', strangerPoll.status === 403 && strangerPoll.data.code === 'not_joined');

  const forged = await api(`/api/live/${ROOM_CODE}/stroke`, {
    method: 'POST',
    body: { viewerId: 'anon:penyusup', cid: 'x', pts: [0.5, 0.5] },
  });
  check('menggambar ditolak untuk yang belum bergabung', forged.status === 403, `status ${forged.status}`);

  console.log(`\n${failed === 0 ? '\x1b[32mSEMUA LULUS\x1b[0m' : '\x1b[31mADA YANG GAGAL\x1b[0m'} — ${passed} lulus, ${failed} gagal\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mSmoke test error:\x1b[0m', err.message);
  process.exit(1);
});
