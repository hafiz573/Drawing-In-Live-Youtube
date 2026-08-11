/* Creator dashboard: live preview, moderation, room settings, members gate. */

(function () {
  'use strict';

  const { $, $$, toast, api, wireCopyButtons } = UI;

  let board = null;
  let live = null;
  let me = null;
  let settings = null;
  let viewers = [];

  const connEl = $('#conn');
  const setConn = (state, label) => {
    connEl.dataset.state = state;
    connEl.innerHTML = `<span>${label}</span>`;
  };

  // ---------------------------------------------------------------------------
  // Settings form <-> object
  // ---------------------------------------------------------------------------
  const NUMBER_FIELDS = ['canvasWidth', 'canvasHeight', 'maxBrush', 'cooldownMs', 'strokeBudget', 'fadeSeconds'];
  const BOOL_FIELDS = ['requireApproval', 'locked', 'showNames', 'allowEraser'];

  function fillForm(next) {
    settings = next;
    for (const key of NUMBER_FIELDS) $(`#${key}`).value = next[key];
    for (const key of BOOL_FIELDS) $(`#${key}`).checked = Boolean(next[key]);
    $('#overlayBackground').value = next.overlayBackground;
    $('#membershipSource').value = next.membershipSource;

    const mode = next.accessMode === 'members' ? 'members' : 'public';
    $(`input[name="accessMode"][value="${mode}"]`).checked = true;
    $('#membersPane').classList.toggle('hidden', mode !== 'members');

    $('#statMode').textContent = mode === 'members' ? 'Member' : 'Publik';
    $('#freezeBtn').textContent = next.locked ? 'Cairkan kanvas' : 'Bekukan kanvas';
    $('#liveBadge').className = next.locked ? 'badge badge--warn' : 'badge badge--live';
    $('#liveBadge').innerHTML = next.locked
      ? 'Dibekukan'
      : '<span class="tally-dot" style="width:6px;height:6px"></span> On air';

    $('#previewFrame').style.setProperty('--canvas-ratio', `${next.canvasWidth} / ${next.canvasHeight}`);
    board.setOptions({
      width: next.canvasWidth,
      height: next.canvasHeight,
      showNames: next.showNames,
      fadeSeconds: next.fadeSeconds,
    });
  }

  function readForm() {
    const out = {
      accessMode: $('input[name="accessMode"]:checked').value,
      membershipSource: $('#membershipSource').value,
      overlayBackground: $('#overlayBackground').value,
    };
    for (const key of NUMBER_FIELDS) out[key] = Number($(`#${key}`).value);
    for (const key of BOOL_FIELDS) out[key] = $(`#${key}`).checked;
    return out;
  }

  /** Persist and broadcast so every viewer/overlay picks it up on their next poll. */
  async function pushSettings(patch, { silent = false } = {}) {
    const next = { ...settings, ...patch };
    fillForm(next);   // optimistic: the form should never feel laggy
    try {
      const res = await live.owner('settings', { settings: next });
      if (res.settings) fillForm(res.settings);
      if (!silent) toast('Setelan diterapkan.', 'good');
    } catch (err) {
      toast(`Gagal menyimpan setelan: ${err.message}`, 'bad');
    }
  }

  // ---------------------------------------------------------------------------
  // Viewers
  // ---------------------------------------------------------------------------
  function renderViewers(list) {
    viewers = list;
    const online = list.filter((v) => v.online).length;
    $('#statOnline').textContent = String(online);
    $('#viewerCount').textContent = `${list.length} orang`;
    $('#viewersEmpty').classList.toggle('hidden', list.length > 0);

    const ul = $('#viewers');
    ul.innerHTML = '';

    for (const viewer of list) {
      const li = document.createElement('li');
      if (!viewer.online) li.className = 'offline';

      const dot = document.createElement('span');
      dot.className = 'swatch-dot';
      dot.style.background = viewer.color;

      const box = document.createElement('div');
      box.className = 'grow';
      box.style.minWidth = '0';

      const name = document.createElement('div');
      name.className = 'vname';
      name.append(document.createTextNode(viewer.name));
      if (viewer.verified) {
        const check = document.createElement('span');
        check.className = 'check';
        check.textContent = '✓';
        check.title = 'Identitas YouTube terverifikasi';
        name.appendChild(check);
      }

      const meta = document.createElement('div');
      meta.className = 'vmeta';
      const bits = [`${viewer.strokeCount} goresan`];
      if (!viewer.online) bits.push('offline');
      if (viewer.accessVia === 'allowlist') bits.push('daftar manual');
      if (viewer.accessVia === 'member') bits.push('member');
      if (!viewer.approved) bits.push('menunggu izin');
      meta.textContent = bits.join(' · ');

      box.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'viewer-actions';

      if (settings?.requireApproval) {
        const approve = document.createElement('button');
        approve.className = `btn btn--sm${viewer.approved ? '' : ' btn--amber'}`;
        approve.textContent = viewer.approved ? 'Cabut' : 'Izinkan';
        approve.addEventListener('click', () =>
          live.owner('approve', { viewerId: viewer.id, approved: !viewer.approved }).catch(() => {}));
        actions.appendChild(approve);
      }

      const wipe = document.createElement('button');
      wipe.className = 'btn btn--sm';
      wipe.textContent = 'Hapus gambar';
      wipe.addEventListener('click', () => live.owner('clearViewer', { viewerId: viewer.id }).catch(() => {}));

      const kick = document.createElement('button');
      kick.className = 'btn btn--sm btn--danger';
      kick.textContent = 'Tendang';
      kick.addEventListener('click', () => {
        const ban = confirm(`Tendang ${viewer.name}?\n\nOK = blokir permanen (tidak bisa masuk lagi)\nBatal = tendang saja`);
        live.owner('kick', { viewerId: viewer.id, ban }).catch(() => {});
      });

      actions.append(wipe, kick);
      li.append(dot, box, actions);
      ul.appendChild(li);
    }
  }

  const refreshStrokeCount = () => {
    const count = board.strokes.length;
    $('#statStrokes').textContent = String(count);
    $('#previewEmpty').classList.toggle('hidden', count > 0);
  };

  // ---------------------------------------------------------------------------
  // Optional YouTube identity
  // ---------------------------------------------------------------------------
  function renderYouTubePanel() {
    const panel = $('#ytPanel');
    panel.classList.remove('hidden');

    const linked = Boolean(me.youtubeLinked);
    const badge = $('#ytBadge');
    badge.className = linked ? 'badge badge--ok' : 'badge badge--warn';
    badge.textContent = linked ? 'Terhubung' : 'Belum terhubung';

    $('#ytName').textContent = me.channelTitle || me.displayName || '—';
    $('#ytConnect').textContent = linked ? 'Perbarui dari YouTube' : 'Hubungkan channel YouTube';

    if (linked) {
      $('#ytHint').textContent =
        'Penonton melihat nama dan foto channel ini di halaman menggambar. Perbarui kalau kamu '
        + 'baru mengganti nama atau foto channel.';
    }

    if (me.channelAvatar) {
      const img = $('#ytAvatar');
      img.src = me.channelAvatar;
      img.onerror = () => { img.src = '/static/img/avatar-fallback.svg'; };
    }
  }

  // ---------------------------------------------------------------------------
  // Members-only pane
  // ---------------------------------------------------------------------------
  function renderAllowlist(entries) {
    const ul = $('#allowList');
    ul.innerHTML = '';
    for (const entry of entries) {
      const li = document.createElement('li');
      const box = document.createElement('div');
      box.className = 'grow';
      box.style.minWidth = '0';
      const label = document.createElement('div');
      label.textContent = entry.label || 'Member manual';
      const cid = document.createElement('div');
      cid.className = 'cid';
      cid.textContent = entry.channel_id;
      box.append(label, cid);

      const del = document.createElement('button');
      del.className = 'btn btn--sm btn--danger';
      del.textContent = 'Hapus';
      del.addEventListener('click', async () => {
        const data = await api(`/api/members/allow/${encodeURIComponent(entry.channel_id)}`, { method: 'DELETE' });
        renderAllowlist(data.allowlist);
        toast('Dihapus dari daftar member.', 'good');
      });

      li.append(box, del);
      ul.appendChild(li);
    }
  }

  async function loadMemberStatus({ force = false } = {}) {
    const box = $('#memberStatus');
    const text = $('#memberStatusText');
    try {
      const data = await api(`/api/members/status${force ? '?refresh=1' : ''}`);
      renderAllowlist(data.allowlist);
      $('#connectMembers').textContent = data.connected ? 'Hubungkan ulang' : 'Hubungkan cek member';

      if (data.ok) {
        box.className = 'member-status ok';
        text.innerHTML = `Members API tersambung. <strong>${data.count}</strong> member terbaca dari YouTube.`;
      } else if (data.connected) {
        box.className = 'member-status bad';
        text.textContent = data.error || 'Members API tidak bisa dibaca.';
      } else {
        box.className = 'member-status warn';
        text.innerHTML = 'Cek member otomatis belum dihubungkan. '
          + 'Klik <strong>Hubungkan cek member</strong>, atau isi daftar member manual di bawah.';
      }
    } catch (err) {
      box.className = 'member-status bad';
      text.textContent = `Gagal memuat status member: ${err.message}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function wireControls() {
    $('#freezeBtn').addEventListener('click', () => pushSettings({ locked: !settings.locked }, { silent: true }));

    $('#undoLastBtn').addEventListener('click', () => live.owner('undo').catch(() => {}));

    $('#clearAllBtn').addEventListener('click', () => {
      if (confirm('Hapus seluruh isi kanvas untuk semua orang?')) live.owner('clear').catch(() => {});
    });

    $('#saveBtn').addEventListener('click', () => pushSettings(readForm()));

    $$('input[name="accessMode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const mode = radio.value;
        $('#membersPane').classList.toggle('hidden', mode !== 'members');
        if (mode === 'members') loadMemberStatus();
        pushSettings({ accessMode: mode }, { silent: true });
        toast(mode === 'members'
          ? 'Room sekarang khusus member. Penonton non-member dikeluarkan.'
          : 'Room dibuka untuk publik.', 'good');
      });
    });

    // Toggles that should take effect the moment they're flipped.
    for (const key of ['locked', 'requireApproval', 'showNames', 'allowEraser']) {
      $(`#${key}`).addEventListener('change', (e) => pushSettings({ [key]: e.target.checked }, { silent: true }));
    }
    $('#membershipSource').addEventListener('change', (e) => pushSettings({ membershipSource: e.target.value }, { silent: true }));
    $('#overlayBackground').addEventListener('change', (e) => pushSettings({ overlayBackground: e.target.value }, { silent: true }));

    $('#refreshMembers').addEventListener('click', () => loadMemberStatus({ force: true }));

    $('#allowForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#allowChannelId');
      const channelId = input.value.trim();
      if (!channelId) return;
      try {
        const data = await api('/api/members/allow', { method: 'POST', body: { channelId } });
        renderAllowlist(data.allowlist);
        input.value = '';
        toast('Member ditambahkan.', 'good');
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    $('#rotateOverlay').addEventListener('click', async () => {
      if (!confirm('Reset URL overlay?\n\nURL lama langsung mati — kamu harus menempel URL baru di OBS.')) return;
      const data = await api('/api/rotate/overlay', { method: 'POST' });
      $('#overlayUrl').value = data.overlayUrl;
      $('#openOverlayBtn').href = data.overlayUrl;
      toast('URL overlay diganti. Perbarui Browser Source di OBS.', 'good');
    });

    $('#rotateRoom').addEventListener('click', async () => {
      if (!confirm('Ganti kode room?\n\nLink lama tidak berlaku lagi dan penonton harus masuk ulang.')) return;
      const data = await api('/api/rotate/room', { method: 'POST' });
      $('#roomCode').textContent = data.roomCode;
      $('#emptyCode').textContent = data.roomCode;
      $('#drawUrl').value = data.drawUrl;
      toast('Kode room diganti.', 'good');
    });

    $('#logoutBtn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      location.href = '/';
    });

    wireCopyButtons();
  }

  function connect() {
    setConn('idle', 'Menyinkronkan');
    live = new LiveRoom({ roomCode: me.roomCode, role: 'owner' });

    live.on('joined', (data) => {
      fillForm(data.settings);
      board.setStrokes(data.strokes);
      if (data.viewers) renderViewers(data.viewers);
      refreshStrokeCount();
      setConn('live', 'Live');
    });

    live.on('resync', (data) => {
      fillForm(data.settings);
      board.setStrokes(data.strokes);
      refreshStrokeCount();
    });

    live.on('settings', (next) => fillForm(next));
    live.on('viewers', renderViewers);

    live.on('stroke', (d) => {
      if (!board.index.get(d.id)) board.addStroke({ ...d, pts: d.pts.slice(), done: d.done });
      else {
        board.appendPoints(d.id, d.pts);
        if (d.done) board.endStroke(d.id);
      }
      refreshStrokeCount();
    });
    live.on('remove', (d) => { board.removeStrokes(d.ids); refreshStrokeCount(); });
    live.on('clear', () => { board.clear(); refreshStrokeCount(); });

    live.on('denied', (d) => {
      setConn('off', 'Sesi habis');
      toast(d.message, 'bad');
      if (d.status === 401 || d.code === 'forbidden') setTimeout(() => { location.href = '/login'; }, 1800);
    });

    live.on('offline', () => setConn('off', 'Terputus'));
    live.on('reconnected', () => setConn('live', 'Live'));

    live.start();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async function boot() {
    board = new Board($('#preview'), {
      width: 1280, height: 720, fit: 'stretch', showNames: true,
      onExpire: refreshStrokeCount,
    });

    try {
      me = await api('/api/me');
    } catch {
      location.href = '/login';
      return;
    }

    $('#meName').textContent = me.channelTitle;
    $('#meSub').textContent = me.channelId ? 'channel terhubung' : 'akun google';
    if (me.channelAvatar) {
      const img = $('#meAvatar');
      img.src = me.channelAvatar;
      img.onerror = () => { img.src = '/static/img/avatar-fallback.svg'; };
    }

    $('#roomCode').textContent = me.roomCode;
    $('#emptyCode').textContent = me.roomCode;
    $('#drawUrl').value = me.drawUrl;
    $('#overlayUrl').value = me.overlayUrl;
    $('#openOverlayBtn').href = me.overlayUrl;

    renderYouTubePanel();
    fillForm(me.settings);
    wireControls();
    connect();

    if (me.settings.accessMode === 'members') loadMemberStatus();

    // Returning from one of the incremental consent screens.
    const params = new URLSearchParams(location.search);
    if (params.get('members') === 'connected') {
      toast('Izin cek member tersambung.', 'good');
      history.replaceState(null, '', '/dashboard');
      loadMemberStatus({ force: true });
    }
    const yt = params.get('youtube');
    if (yt) {
      // Each failure needs its own instruction — "no channel" sent people
      // looking at their YouTube account when the fault was elsewhere.
      const YT_MESSAGES = {
        connected: ['Channel YouTube tersambung.', 'good'],
        nochannel: ['Akun Google itu memang belum punya channel YouTube.', 'bad'],
        apidisabled: ['YouTube Data API v3 belum aktif di project Google Cloud kamu. Aktifkan di API Library, lalu coba lagi.', 'bad'],
        noscope: ['Izin baca channel tidak diberikan. Coba lagi dan setujui akses YouTube-nya.', 'bad'],
        quota: ['Kuota YouTube API habis untuk hari ini. Coba lagi besok.', 'bad'],
        failed: ['Gagal membaca channel dari YouTube. Coba lagi sebentar lagi.', 'bad'],
      };
      const [message, kind] = YT_MESSAGES[yt] || YT_MESSAGES.failed;
      toast(message, kind);
      history.replaceState(null, '', '/dashboard');
    }

    setInterval(refreshStrokeCount, 1000);
  })();
})();
