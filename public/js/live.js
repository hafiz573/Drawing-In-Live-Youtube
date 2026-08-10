/* Client transport for the long-polling realtime layer.
   Exposes an on()/emit()-shaped API so the pages read the same as they did on
   sockets, but underneath it is plain fetch: one held GET that returns as soon
   as the room changes, plus small POSTs for anything this client does. */

(function (global) {
  'use strict';

  const BACKOFF_START = 1000;
  const BACKOFF_MAX = 15000;

  class LiveRoom {
    /**
     * @param {object} opts
     * @param {string} opts.roomCode
     * @param {'viewer'|'overlay'|'owner'} opts.role
     * @param {string} [opts.viewerId]     required for role 'viewer'
     * @param {string} [opts.overlayToken] required for role 'overlay'
     */
    constructor(opts) {
      this.roomCode = opts.roomCode;
      this.role = opts.role;
      this.viewerId = opts.viewerId || null;
      this.overlayToken = opts.overlayToken || null;

      this.cursor = 0;
      this.connected = false;
      this.stopped = false;
      this.backoff = BACKOFF_START;
      this.handlers = new Map();
      this._abort = null;
    }

    on(event, fn) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(fn);
      return this;
    }

    _fire(event, payload) {
      for (const fn of this.handlers.get(event) || []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[live] handler ${event} error:`, err);
        }
      }
    }

    async _request(url, options = {}) {
      const res = await fetch(url, {
        credentials: 'same-origin',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { status: res.status, data });
      return data;
    }

    /** Joins (viewer) or opens (overlay/owner), then starts following the log. */
    async start(joinBody = {}) {
      this.stopped = false;
      try {
        let snapshot;
        if (this.role === 'viewer') {
          snapshot = await this._request(`/api/live/${this.roomCode}/join`, {
            method: 'POST',
            body: { viewerId: this.viewerId, ...joinBody },
          });
          // The server namespaces our id ("anon:…" or "yt:…"). Every later call
          // must use that form, not the raw local-storage value we sent.
          if (snapshot.you?.id) this.viewerId = snapshot.you.id;
        } else if (this.role === 'overlay') {
          snapshot = await this._request(`/api/live/overlay/${this.overlayToken}/open`);
          this.roomCode = snapshot.roomCode;
        } else {
          snapshot = await this._request(`/api/live/${this.roomCode}/open`);
        }

        this.cursor = snapshot.cursor || 0;
        this.connected = true;
        this.backoff = BACKOFF_START;
        this._fire('joined', snapshot);
        this._loop();
      } catch (err) {
        this.connected = false;
        this._fire('denied', err.data || { code: 'error', message: err.message });
      }
    }

    stop() {
      this.stopped = true;
      this.connected = false;
      this._abort?.abort();
    }

    _pollUrl() {
      const params = new URLSearchParams({ cursor: String(this.cursor) });
      if (this.viewerId) params.set('viewerId', this.viewerId);
      if (this.overlayToken) params.set('overlayToken', this.overlayToken);
      return `/api/live/${this.roomCode}/poll?${params}`;
    }

    async _loop() {
      while (!this.stopped) {
        this._abort = new AbortController();
        try {
          const data = await this._request(this._pollUrl(), { signal: this._abort.signal });

          if (!this.connected) {
            this.connected = true;
            this._fire('reconnected');
          }
          this.backoff = BACKOFF_START;

          // The client fell behind the retained history — take a fresh snapshot
          // rather than replay a stream with a hole in it.
          if (data.resync) {
            this.cursor = data.cursor || 0;
            this._fire('resync', data);
            if (data.viewers) this._fire('viewers', data.viewers);
            continue;
          }

          this.cursor = data.cursor ?? this.cursor;
          for (const event of data.events || []) this._dispatch(event, data);
          if (data.viewers) this._fire('viewers', data.viewers);
          if (data.settings) this._fire('settings', data.settings);
        } catch (err) {
          if (this.stopped) return;
          if (err.name === 'AbortError') continue;

          // A 403 means we are no longer a member of this room — kicked, banned,
          // or the host switched to members-only. Stop instead of hammering.
          if (err.status === 403) {
            this.connected = false;
            this.stop();
            return this._fire('denied', err.data || { code: 'denied', message: err.message });
          }

          this.connected = false;
          this._fire('offline', { message: err.message });
          await new Promise((r) => setTimeout(r, this.backoff));
          this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
        }
      }
    }

    _dispatch(event) {
      const { kind, data } = event;
      switch (kind) {
        case 's': this._fire('stroke', data); break;
        case 'remove': this._fire('remove', data); break;
        case 'clear': this._fire('clear', data); break;
        case 'approval':
          if (!this.viewerId || data.viewerId === this.viewerId) this._fire('approval', data);
          break;
        case 'kick':
          if (this.viewerId && data.viewerId === this.viewerId) {
            this.stop();
            this._fire('kicked', data);
          }
          break;
        case 'settings': break;  // surfaced via data.settings on the response
        case 'viewers': break;   // surfaced via data.viewers on the response
        default: this._fire(kind, data);
      }
    }

    // -- outbound ----------------------------------------------------------
    sendStroke(body) {
      return this._request(`/api/live/${this.roomCode}/stroke`, {
        method: 'POST',
        body: { viewerId: this.viewerId, ...body },
      });
    }

    act(action) {
      return this._request(`/api/live/${this.roomCode}/act`, {
        method: 'POST',
        body: { viewerId: this.viewerId, action },
      });
    }

    owner(action, extra = {}) {
      return this._request(`/api/live/${this.roomCode}/owner`, {
        method: 'POST',
        body: { action, ...extra },
      });
    }
  }

  global.LiveRoom = LiveRoom;
})(window);
