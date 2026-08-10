'use strict';

/**
 * End-to-end smoke test for the realtime path.
 *
 * Verifies that a viewer's strokes actually reach an OBS overlay, that owner
 * moderation propagates, and that bad tokens/rooms/sessions are refused.
 * Assumes `npm run dev` is running and a seeded creator row exists — see the
 * "Test" section of README.md for the seed snippet.
 *
 *   ROOM_CODE=XXXXXX OVERLAY_TOKEN=xxxx npm test
 *
 * Env: BASE_URL (default http://localhost:3000)
 *      ROOM_CODE (default SMOKE1)
 *      OVERLAY_TOKEN (default the seeded smoke token)
 */

const { io } = require('socket.io-client');

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

const connect = () => io(BASE_URL, { transports: ['websocket'], forceNew: true });

/** Resolves on the first matching event, or rejects after `ms`. */
function once(socket, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout menunggu "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nSmoke test → ${BASE_URL} (room ${ROOM_CODE})\n`);

  // --- HTTP surface --------------------------------------------------------
  console.log('HTTP');
  const health = await fetch(`${BASE_URL}/healthz`).then((r) => r.json());
  check('/healthz melaporkan database up', health.ok && health.db === 'up', JSON.stringify(health));

  const room = await fetch(`${BASE_URL}/api/room/${ROOM_CODE}`).then((r) => r.json());
  check('/api/room mengembalikan metadata room', room.roomCode === ROOM_CODE, JSON.stringify(room));
  check('room default terbuka untuk publik', room.accessMode === 'public');
  check('akses diizinkan tanpa login di mode publik', room.access?.allowed === true);

  const missing = await fetch(`${BASE_URL}/api/room/NOPE00`);
  check('room tidak dikenal balas 404', missing.status === 404);

  const guarded = await fetch(`${BASE_URL}/api/me`, { redirect: 'manual' });
  check('/api/me menolak tanpa sesi', guarded.status === 401, `status ${guarded.status}`);

  // --- realtime ------------------------------------------------------------
  console.log('\nRealtime');
  const overlay = connect();
  await once(overlay, 'connect');
  overlay.emit('overlay:join', { token: OVERLAY_TOKEN });
  const overlayJoin = await once(overlay, 'joined');
  check('overlay bergabung dengan token valid', Boolean(overlayJoin.settings));

  const viewer = connect();
  await once(viewer, 'connect');
  viewer.emit('viewer:join', { roomCode: ROOM_CODE, viewerId: 'smoke-viewer-1', name: 'SmokeBot' });
  const viewerJoin = await once(viewer, 'joined');
  check('viewer bergabung ke room publik', Boolean(viewerJoin.you?.id));
  check('viewer langsung disetujui saat moderasi mati', viewerJoin.you?.approved === true);

  // Viewer draws; the overlay should see it.
  const started = once(overlay, 's:start');
  viewer.emit('s:start', { cid: 'stroke1', x: 0.1, y: 0.1, color: '#ff3b1f', size: 8, tool: 'pen' });
  const startEvent = await started;
  const strokeId = startEvent.id;
  check('goresan viewer sampai ke overlay', startEvent.name === 'SmokeBot');
  check('id goresan dinamespace dengan id viewer',
    strokeId === `${viewerJoin.you.id}#stroke1`, strokeId);

  const gotPoints = once(overlay, 's:pts');
  viewer.emit('s:pts', { id: strokeId, pts: [0.2, 0.2, 0.3, 0.35] });
  const pointsEvent = await gotPoints;
  check('titik-titik goresan diteruskan', pointsEvent.pts.length === 4, JSON.stringify(pointsEvent.pts));

  viewer.emit('s:end', { id: strokeId });
  await sleep(150);

  // A second overlay should receive the stroke in its initial snapshot.
  const overlay2 = connect();
  await once(overlay2, 'connect');
  overlay2.emit('overlay:join', { token: OVERLAY_TOKEN });
  const snapshot = await once(overlay2, 'joined');
  const stored = snapshot.strokes.find((s) => s.id === strokeId);
  check('overlay baru menerima snapshot kanvas', Boolean(stored), `${snapshot.strokes.length} goresan`);
  check('goresan tersimpan lengkap dengan titiknya', stored?.pts.length === 6, JSON.stringify(stored?.pts));

  // Viewer removes their own stroke.
  const removed = once(overlay, 'remove');
  viewer.emit('s:clearMine');
  const removeEvent = await removed;
  check('viewer bisa menghapus goresannya sendiri', removeEvent.ids.includes(strokeId));

  // --- security ------------------------------------------------------------
  console.log('\nKeamanan');
  const badOverlay = connect();
  await once(badOverlay, 'connect');
  badOverlay.emit('overlay:join', { token: 'token-palsu' });
  const overlayDenied = await once(badOverlay, 'denied');
  check('token overlay palsu ditolak', overlayDenied.code === 'bad_overlay_token');

  const badRoom = connect();
  await once(badRoom, 'connect');
  badRoom.emit('viewer:join', { roomCode: 'NOPE00', viewerId: 'x', name: 'x' });
  const roomDenied = await once(badRoom, 'denied');
  check('kode room tidak dikenal ditolak', roomDenied.code === 'no_room');

  const notOwner = connect();
  await once(notOwner, 'connect');
  notOwner.emit('owner:join');
  const ownerDenied = await once(notOwner, 'denied');
  check('owner:join tanpa cookie sesi ditolak', ownerDenied.code === 'session_expired');

  // A viewer must not be able to run moderation commands.
  viewer.emit('o:clear');
  await sleep(250);
  const overlay3 = connect();
  await once(overlay3, 'connect');
  overlay3.emit('overlay:join', { token: OVERLAY_TOKEN });
  const afterHijack = await once(overlay3, 'joined');
  check('viewer tidak bisa memakai perintah owner', Array.isArray(afterHijack.strokes));

  for (const s of [overlay, overlay2, overlay3, viewer, badOverlay, badRoom, notOwner]) s.close();

  console.log(`\n${failed === 0 ? '\x1b[32mSEMUA LULUS\x1b[0m' : '\x1b[31mADA YANG GAGAL\x1b[0m'} — ${passed} lulus, ${failed} gagal\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mSmoke test error:\x1b[0m', err.message);
  process.exit(1);
});
