/* Viewer drawing room.
   Renders optimistically (your own strokes appear instantly, before the server
   echoes them back) and reconciles against the server for everything else. */

(function () {
  'use strict';

  const { $, toast, api, anonId } = UI;

  const PALETTE = [
    '#ff3b1f', '#ffb020', '#ffe66d', '#8ce563', '#4de2c2',
    '#3ba7ff', '#b07cff', '#ff6fb5', '#f4efe4', '#0a0908',
  ];

  const roomCode = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();

  const stage = $('#stage');
  const frameEl = $('#frame');
  const gate = $('#gate');
  const connEl = $('#conn');

  let board = null;
  let socket = null;
  let me = null;
  let settings = null;
  let roomInfo = null;

  let tool = 'pen';
  let color = localStorage.getItem('dil.color') || PALETTE[0];
  let size = Number(localStorage.getItem('dil.size')) || 6;
  let nickname = localStorage.getItem('dil.nickname') || '';

  let active = null;      // { id, buffer: [] } for the stroke under the pointer
  let flushQueued = false;
  let strokeSeq = 0;

  // ---------------------------------------------------------------------------
  // Gate — the blocking card for every "you can't draw right now" state
  // ---------------------------------------------------------------------------
  function showGate({ title, body, actions = [], icon }) {
    $('#gateTitle').textContent = title;
    $('#gateBody').textContent = body;
    if (icon) $('#gateIcon').innerHTML = icon;

    const bar = $('#gateActions');
    bar.innerHTML = '';
    for (const action of actions) {
      const el = document.createElement(action.href ? 'a' : 'button');
      el.className = `btn ${action.variant || ''}`.trim();
      el.textContent = action.label;
      if (action.href) el.href = action.href;
      else el.addEventListener('click', action.onClick);
      bar.appendChild(el);
    }
    gate.classList.remove('hidden');
  }

  const hideGate = () => gate.classList.add('hidden');

  const ICONS = {
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4.5" y="10" width="15" height="10.5" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m12 3.5 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.9l6.1-.8Z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/></svg>',
  };

  function gateForDenial({ code, message }) {
    const next = encodeURIComponent(location.pathname);
    switch (code) {
      case 'login_required':
        return showGate({
          icon: ICONS.user,
          title: 'Room khusus member',
          body: message || 'Login dengan Google dulu supaya kami bisa cek status membership kamu.',
          actions: [
            { label: 'Login dengan Google', href: `/auth/google?role=viewer&next=${next}`, variant: 'btn--google' },
            { label: 'Kembali', href: '/join' },
          ],
        });
      case 'not_member': {
        const joinUrl = roomInfo?.channelId ? `https://www.youtube.com/channel/${roomInfo.channelId}/join` : null;
        const actions = [{ label: 'Cek ulang', onClick: () => location.reload() }];
        if (joinUrl) actions.unshift({ label: 'Jadi member', href: joinUrl, variant: 'btn--amber' });
        return showGate({ icon: ICONS.star, title: 'Belum jadi member', body: message, actions });
      }
      case 'no_channel':
        return showGate({
          icon: ICONS.user,
          title: 'Channel tidak ditemukan',
          body: message || 'Akun Google kamu belum punya channel YouTube.',
          actions: [
            { label: 'Ganti akun Google', href: `/auth/google?role=viewer&next=${next}`, variant: 'btn--google' },
          ],
        });
      case 'banned':
        return showGate({ icon: ICONS.ban, title: 'Kamu diblokir', body: message, actions: [{ label: 'Kembali', href: '/join' }] });
      case 'no_room':
        return showGate({
          icon: ICONS.ban, title: 'Room tidak ada',
          body: `Tidak ada room dengan kode ${roomCode}.`,
          actions: [{ label: 'Coba kode lain', href: '/join', variant: 'btn--primary' }],
        });
      default:
        return showGate({
          icon: ICONS.lock,
          title: 'Tidak bisa masuk',
          body: message || 'Ada masalah saat mengecek akses kamu.',
          actions: [{ label: 'Coba lagi', onClick: () => location.reload() }],
        });
    }
  }

  function askNickname() {
    showGate({
      icon: ICONS.user,
      title: 'Pakai nama apa?',
      body: 'Nama ini muncul di sebelah goresan kamu di layar host.',
      actions: [],
    });
    const bar = $('#gateActions');
    bar.style.flexDirection = 'column';
    bar.innerHTML = `
      <input id="nickInput" type="text" maxlength="18" placeholder="Nama panggilan" autocomplete="nickname" style="text-align:center">
      <button class="btn btn--primary btn--block" id="nickGo">Mulai menggambar →</button>`;

    const input = $('#nickInput');
    const go = () => {
      const value = input.value.trim().slice(0, 18);
      if (!value) return toast('Isi nama dulu ya.', 'bad');
      nickname = value;
      localStorage.setItem('dil.nickname', nickname);
      bar.style.flexDirection = '';
      hideGate();
      connect();
    };
    $('#nickGo').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.focus();
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  function buildSwatches() {
    const wrap = $('#swatches');
    wrap.innerHTML = '';
    for (const hex of PALETTE) {
      const btn = document.createElement('button');
      btn.className = 'swatch';
      btn.type = 'button';
      btn.style.background = hex;
      btn.title = hex;
      btn.setAttribute('aria-label', `Warna ${hex}`);
      btn.setAttribute('aria-pressed', String(hex === color));
      btn.addEventListener('click', () => {
        color = hex;
        localStorage.setItem('dil.color', hex);
        setTool('pen');
        [...wrap.children].forEach((el) => el.setAttribute('aria-pressed', String(el.style.background === btn.style.background)));
        paintSizeDot();
      });
      wrap.appendChild(btn);
    }
  }

  function paintSizeDot() {
    const dot = $('#sizeDot');
    const px = Math.max(6, Math.min(size, 26));
    dot.style.width = `${px}px`;
    dot.style.height = `${px}px`;
    dot.style.color = tool === 'eraser' ? 'var(--paper-mute)' : color;
  }

  function setTool(next) {
    tool = next;
    $('#penBtn').setAttribute('aria-pressed', String(next === 'pen'));
    $('#eraserBtn').setAttribute('aria-pressed', String(next === 'eraser'));
    paintSizeDot();
  }

  function wireToolbar() {
    buildSwatches();

    const sizeInput = $('#size');
    sizeInput.value = size;
    sizeInput.addEventListener('input', () => {
      size = Number(sizeInput.value);
      localStorage.setItem('dil.size', String(size));
      paintSizeDot();
    });

    $('#penBtn').addEventListener('click', () => setTool('pen'));
    $('#eraserBtn').addEventListener('click', () => setTool('eraser'));
    $('#undoBtn').addEventListener('click', () => socket?.emit('s:undo'));
    $('#clearBtn').addEventListener('click', () => {
      if (confirm('Hapus semua gambar kamu di kanvas ini?')) socket?.emit('s:clearMine');
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); socket?.emit('s:undo'); }
      else if (e.key.toLowerCase() === 'e') setTool(tool === 'eraser' ? 'pen' : 'eraser');
      else if (e.key === '[') { size = Math.max(2, size - 2); $('#size').value = size; paintSizeDot(); }
      else if (e.key === ']') { size = Math.min(Number($('#size').max), size + 2); $('#size').value = size; paintSizeDot(); }
    });

    paintSizeDot();
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function canDraw() {
    return Boolean(socket?.connected && me && me.approved && settings && !settings.locked);
  }

  function flush() {
    flushQueued = false;
    if (!active || !active.buffer.length) return;
    socket.emit('s:pts', { id: active.id, pts: active.buffer });
    active.buffer = [];
  }

  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flush);
  }

  function onDown(event) {
    if (!canDraw() || active) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (!board.isInside(event.clientX, event.clientY)) return;

    const { x, y } = board.toNormalised(event.clientX, event.clientY);
    const cid = `${Date.now().toString(36)}${(strokeSeq++).toString(36)}`;
    // The server namespaces this with our viewer id — so we can predict the
    // final id and start painting before the round trip completes.
    const id = `${me.id}#${cid}`;

    active = { id, buffer: [], lastX: x, lastY: y };
    board.addStroke({
      id, viewerId: me.id, name: me.name, color, size, tool,
      pts: [x, y], t: Date.now(), done: false,
    });
    socket.emit('s:start', { cid, x, y, color, size, tool });
    board.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onMove(event) {
    if (!active) return;

    // Coalesced events give us the full high-frequency path on a 120Hz screen.
    const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    for (const point of events) {
      const { x, y } = board.toNormalised(point.clientX, point.clientY);
      // Drop sub-pixel jitter: it costs bandwidth and changes nothing visually.
      if (Math.abs(x - active.lastX) < 0.0015 && Math.abs(y - active.lastY) < 0.0015) continue;
      active.lastX = x;
      active.lastY = y;
      active.buffer.push(x, y);
      board.appendPoints(active.id, [x, y]);
    }
    queueFlush();
    event.preventDefault();
  }

  function onUp() {
    if (!active) return;
    flush();
    board.endStroke(active.id);
    socket.emit('s:end', { id: active.id });
    active = null;
  }

  function wireCanvas() {
    const el = board.canvas;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onUp);
    window.addEventListener('blur', onUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------------------------------------------------------------------------
  // Frame outline — shows exactly what the host's overlay captures
  // ---------------------------------------------------------------------------
  function syncFrame() {
    if (!board) return;
    const { x, y, w, h } = board.rect;
    frameEl.style.left = `${x}px`;
    frameEl.style.top = `${y}px`;
    frameEl.style.width = `${w}px`;
    frameEl.style.height = `${h}px`;
    frameEl.classList.remove('hidden');
    requestAnimationFrame(syncFrame);
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------
  function setConn(stateName, label) {
    connEl.dataset.state = stateName;
    connEl.innerHTML = `<span>${label}</span>`;
  }

  function applySettings(next) {
    settings = next;
    board.setOptions({
      width: next.canvasWidth,
      height: next.canvasHeight,
      showNames: next.showNames,
      fadeSeconds: next.fadeSeconds,
    });

    const sizeInput = $('#size');
    sizeInput.max = String(next.maxBrush);
    if (size > next.maxBrush) {
      size = next.maxBrush;
      sizeInput.value = size;
      paintSizeDot();
    }

    $('#eraserBtn').disabled = !next.allowEraser;
    if (!next.allowEraser && tool === 'eraser') setTool('pen');

    stage.classList.toggle('is-locked', Boolean(next.locked));
    const badge = $('#modeBadge');
    if (next.locked) {
      badge.className = 'badge badge--warn';
      badge.textContent = 'Kanvas dibekukan';
    } else if (next.accessMode === 'members') {
      badge.className = 'badge badge--ok';
      badge.textContent = 'Member';
    } else {
      badge.className = 'badge hidden';
    }
  }

  function connect() {
    socket = io({ withCredentials: true });

    socket.on('connect', () => {
      setConn('idle', 'Bergabung…');
      socket.emit('viewer:join', { roomCode, viewerId: anonId(), name: nickname });
    });

    socket.on('joined', (data) => {
      me = data.you;
      hideGate();
      applySettings(data.settings);
      board.setStrokes(data.strokes);
      setConn('live', 'Terhubung');
      if (!me.approved) {
        showGate({
          icon: ICONS.clock,
          title: 'Menunggu persetujuan',
          body: 'Host mengaktifkan moderasi. Begitu kamu disetujui, kamu langsung bisa menggambar.',
          actions: [],
        });
      }
    });

    socket.on('settings', applySettings);

    socket.on('s:start', (data) => {
      if (me && data.viewerId === me.id) return; // our own echo — already on screen
      board.addStroke({ ...data, pts: [data.x, data.y], done: false });
    });
    socket.on('s:pts', (data) => board.appendPoints(data.id, data.pts));
    socket.on('s:end', (data) => board.endStroke(data.id));
    socket.on('remove', (data) => board.removeStrokes(data.ids));
    socket.on('clear', () => board.clear());

    socket.on('approval', ({ approved }) => {
      if (!me) return;
      me.approved = approved;
      if (approved) {
        hideGate();
        toast('Kamu disetujui host. Silakan menggambar!', 'good');
      } else {
        showGate({
          icon: ICONS.clock,
          title: 'Menunggu persetujuan',
          body: 'Host mencabut izin menggambar kamu untuk sementara.',
          actions: [],
        });
      }
    });

    socket.on('cooldown', ({ until }) => {
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      toast(`Tunggu ${seconds} detik sebelum menggambar lagi.`, 'bad');
    });

    socket.on('denied', (data) => {
      setConn('off', 'Ditolak');
      gateForDenial(data);
    });

    socket.on('kicked', (data) => {
      setConn('off', 'Dikeluarkan');
      showGate({
        icon: ICONS.ban,
        title: 'Kamu dikeluarkan',
        body: data.message || 'Host mengeluarkan kamu dari room ini.',
        actions: [{ label: 'Kembali', href: '/join', variant: 'btn--primary' }],
      });
    });

    socket.on('disconnect', (reason) => {
      onUp();
      // An explicit kick already showed its own card; don't stomp on it.
      if (reason !== 'io server disconnect') setConn('off', 'Terputus — menyambung ulang');
    });

    socket.io.on('reconnect', () => setConn('idle', 'Bergabung…'));
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async function boot() {
    board = new Board($('#board'), { width: 1280, height: 720, fit: 'contain', showNames: true });
    wireToolbar();
    wireCanvas();
    requestAnimationFrame(syncFrame);

    $('#roomCode').textContent = roomCode;

    try {
      roomInfo = await api(`/api/room/${roomCode}`);
    } catch (err) {
      return gateForDenial({ code: err.status === 404 ? 'no_room' : 'check_failed', message: err.message });
    }

    $('#hostName').textContent = roomInfo.channelTitle;
    $('#hostSub').innerHTML = `room <span class="mint">${roomCode}</span>`;
    document.title = `${roomInfo.channelTitle} — Drawing In Live`;
    if (roomInfo.channelAvatar) {
      const img = $('#hostAvatar');
      img.src = roomInfo.channelAvatar;
      img.onerror = () => { img.src = '/static/img/avatar-fallback.svg'; };
    }
    board.setLogicalSize(roomInfo.canvas.width, roomInfo.canvas.height);

    if (!roomInfo.access.allowed) return gateForDenial(roomInfo.access);

    // Verified viewers already have a name from YouTube; anonymous ones pick one.
    if (roomInfo.viewer?.verified) {
      nickname = roomInfo.viewer.name;
      connect();
    } else if (nickname) {
      connect();
    } else {
      askNickname();
    }
  })();
})();
