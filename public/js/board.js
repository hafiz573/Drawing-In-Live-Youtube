/* Shared canvas engine used by the viewer, the dashboard preview and the OBS overlay.
   Stroke coordinates travel the wire normalised to 0..1, so every surface can render
   the same room at whatever size it happens to be. */

(function (global) {
  'use strict';

  const FADE_TAIL_MS = 1400; // how long a stroke spends dissolving before it's gone

  class Board {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} opts
     * @param {number} opts.width   logical canvas width (aspect source)
     * @param {number} opts.height  logical canvas height
     * @param {'contain'|'stretch'} opts.fit
     * @param {boolean} opts.showNames
     * @param {number} opts.fadeSeconds
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.logical = { w: opts.width || 1280, h: opts.height || 720 };
      this.fit = opts.fit || 'contain';
      this.showNames = opts.showNames !== false;
      this.fadeSeconds = Number(opts.fadeSeconds) || 0;
      this.onExpire = opts.onExpire || null;

      this.strokes = [];
      this.index = new Map();
      this.dirty = true;
      this.rect = { x: 0, y: 0, w: 1, h: 1 };

      this._resize = this._resize.bind(this);
      this._frame = this._frame.bind(this);

      this._observer = new ResizeObserver(this._resize);
      this._observer.observe(canvas.parentElement || canvas);
      window.addEventListener('orientationchange', this._resize);

      this._resize();
      this._raf = requestAnimationFrame(this._frame);
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this._observer.disconnect();
      window.removeEventListener('orientationchange', this._resize);
    }

    // -- geometry ----------------------------------------------------------
    _resize() {
      const parent = this.canvas.parentElement || this.canvas;
      const cssW = Math.max(1, parent.clientWidth);
      const cssH = Math.max(1, parent.clientHeight);
      const dpr = Math.min(global.devicePixelRatio || 1, 2);

      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (this.fit === 'stretch') {
        this.rect = { x: 0, y: 0, w: cssW, h: cssH };
      } else {
        const scale = Math.min(cssW / this.logical.w, cssH / this.logical.h);
        const w = this.logical.w * scale;
        const h = this.logical.h * scale;
        this.rect = { x: (cssW - w) / 2, y: (cssH - h) / 2, w, h };
      }
      this.dirty = true;
    }

    setLogicalSize(width, height) {
      this.logical = { w: width || this.logical.w, h: height || this.logical.h };
      this._resize();
    }

    /** Client (pointer) coordinates -> normalised 0..1 inside the drawing rect. */
    toNormalised(clientX, clientY) {
      const box = this.canvas.getBoundingClientRect();
      const x = (clientX - box.left - this.rect.x) / this.rect.w;
      const y = (clientY - box.top - this.rect.y) / this.rect.h;
      return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
    }

    /** True when a pointer position falls inside the visible drawing rect. */
    isInside(clientX, clientY) {
      const box = this.canvas.getBoundingClientRect();
      const x = clientX - box.left;
      const y = clientY - box.top;
      return x >= this.rect.x && x <= this.rect.x + this.rect.w
        && y >= this.rect.y && y <= this.rect.y + this.rect.h;
    }

    // -- stroke bookkeeping -------------------------------------------------
    setStrokes(list) {
      this.strokes = (list || []).map((s) => ({ ...s, pts: s.pts.slice() }));
      this.index = new Map(this.strokes.map((s) => [s.id, s]));
      this.dirty = true;
    }

    addStroke(stroke) {
      const record = { ...stroke, pts: stroke.pts ? stroke.pts.slice() : [stroke.x, stroke.y] };
      this.strokes.push(record);
      this.index.set(record.id, record);
      this.dirty = true;
      return record;
    }

    appendPoints(id, pts) {
      const stroke = this.index.get(id);
      if (!stroke) return;
      for (const value of pts) stroke.pts.push(value);
      this.dirty = true;
    }

    endStroke(id) {
      const stroke = this.index.get(id);
      if (stroke) stroke.done = true;
      this.dirty = true;
    }

    removeStrokes(ids) {
      const gone = new Set(ids);
      this.strokes = this.strokes.filter((s) => !gone.has(s.id));
      for (const id of gone) this.index.delete(id);
      this.dirty = true;
    }

    clear() {
      this.strokes = [];
      this.index.clear();
      this.dirty = true;
    }

    setOptions(opts = {}) {
      if (opts.showNames !== undefined) this.showNames = Boolean(opts.showNames);
      if (opts.fadeSeconds !== undefined) this.fadeSeconds = Number(opts.fadeSeconds) || 0;
      if (opts.width || opts.height) this.setLogicalSize(opts.width, opts.height);
      this.dirty = true;
    }

    // -- painting -----------------------------------------------------------
    _frame() {
      // With fading on we must repaint every frame; otherwise only on change.
      if (this.fadeSeconds > 0) {
        this._expire();
        this.dirty = true;
      }
      if (this.dirty) {
        this._paint();
        this.dirty = false;
      }
      this._raf = requestAnimationFrame(this._frame);
    }

    _expire() {
      if (!this.fadeSeconds) return;
      const deadline = Date.now() - (this.fadeSeconds * 1000 + FADE_TAIL_MS);
      if (!this.strokes.some((s) => s.t < deadline)) return;
      const expired = this.strokes.filter((s) => s.t < deadline).map((s) => s.id);
      this.removeStrokes(expired);
      if (this.onExpire) this.onExpire(expired);
    }

    _alphaFor(stroke, now) {
      if (!this.fadeSeconds) return 1;
      const age = now - stroke.t;
      const solidFor = this.fadeSeconds * 1000;
      if (age <= solidFor) return 1;
      return Math.max(0, 1 - (age - solidFor) / FADE_TAIL_MS);
    }

    _paint() {
      const { ctx } = this;
      const cssW = this.canvas.clientWidth;
      const cssH = this.canvas.clientHeight;
      const now = Date.now();

      ctx.clearRect(0, 0, cssW, cssH);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const { x: ox, y: oy, w, h } = this.rect;
      const scale = w / this.logical.w; // brush sizes are authored in logical px

      for (const stroke of this.strokes) {
        const alpha = this._alphaFor(stroke, now);
        if (alpha <= 0) continue;

        const pts = stroke.pts;
        if (pts.length < 2) continue;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = Math.max(1, stroke.size * scale);

        const px = (i) => ox + pts[i * 2] * w;
        const py = (i) => oy + pts[i * 2 + 1] * h;
        const count = pts.length / 2;

        if (count === 1) {
          // A tap: render it as a dot so single clicks still show up.
          ctx.beginPath();
          ctx.fillStyle = stroke.color;
          ctx.arc(px(0), py(0), ctx.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Quadratic through midpoints — cheap smoothing, no visible kinks.
          ctx.beginPath();
          ctx.moveTo(px(0), py(0));
          for (let i = 1; i < count - 1; i++) {
            const mx = (px(i) + px(i + 1)) / 2;
            const my = (py(i) + py(i + 1)) / 2;
            ctx.quadraticCurveTo(px(i), py(i), mx, my);
          }
          ctx.lineTo(px(count - 1), py(count - 1));
          ctx.stroke();
        }
        ctx.restore();

        // Live nametag follows the tip of an in-progress stroke.
        if (this.showNames && !stroke.done && stroke.name) {
          const tipX = ox + pts[pts.length - 2] * w;
          const tipY = oy + pts[pts.length - 1] * h;
          this._nametag(stroke.name, stroke.color, tipX, tipY, alpha);
        }
      }
    }

    _nametag(name, color, x, y, alpha) {
      const { ctx } = this;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = '500 12px "DM Mono", ui-monospace, monospace';
      const padX = 6;
      const width = ctx.measureText(name).width + padX * 2;
      const boxX = Math.min(Math.max(x + 12, 2), this.canvas.clientWidth - width - 2);
      const boxY = Math.min(Math.max(y - 26, 2), this.canvas.clientHeight - 22);

      ctx.fillStyle = 'rgba(10, 9, 8, 0.82)';
      ctx.fillRect(boxX, boxY, width, 19);
      ctx.fillStyle = color;
      ctx.fillRect(boxX, boxY, 3, 19);
      ctx.fillStyle = '#f4efe4';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, boxX + padX, boxY + 10);
      ctx.restore();
    }
  }

  global.Board = Board;
})(window);
