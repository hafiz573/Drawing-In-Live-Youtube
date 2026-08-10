/* Landing-page showreel: fakes four viewers doodling on the overlay, on a loop.
   Purely decorative — no network, no sockets. */

(function () {
  'use strict';

  const canvas = document.getElementById('demoCanvas');
  if (!canvas || !window.Board) return;

  const board = new Board(canvas, { width: 1280, height: 720, fit: 'stretch', showNames: true });

  // --- shape generators (normalised 0..1) ----------------------------------
  const at = (cx, cy, rx, ry, fn, steps = 64) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const [ux, uy] = fn((i / steps) * Math.PI * 2);
      pts.push(cx + ux * rx, cy + uy * ry);
    }
    return pts;
  };

  const circle = (cx, cy, r) => at(cx, cy, r, r * (16 / 9), (t) => [Math.cos(t), Math.sin(t)]);

  const heart = (cx, cy, s) => at(cx, cy, s, s * (16 / 9), (t) => [
    (16 * Math.sin(t) ** 3) / 16,
    -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16,
  ]);

  const star = (cx, cy, r) => {
    const pts = [];
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r * (16 / 9));
    }
    return pts;
  };

  const arc = (cx, cy, r, from, to, steps = 24) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r * (16 / 9));
    }
    return pts;
  };

  const squiggle = (x0, y0, x1, amp, waves, steps = 70) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push(x0 + (x1 - x0) * t, y0 + Math.sin(t * Math.PI * waves) * amp);
    }
    return pts;
  };

  const line = (x0, y0, x1, y1) => [x0, y0, x1, y1];

  // --- the cast ------------------------------------------------------------
  const SCRIPT = [
    { name: 'rizky_07',   color: '#ff3b1f', size: 9,  delay: 0,    pts: circle(0.24, 0.42, 0.085) },
    { name: 'rizky_07',   color: '#ff3b1f', size: 9,  delay: 900,  pts: circle(0.212, 0.36, 0.011) },
    { name: 'rizky_07',   color: '#ff3b1f', size: 9,  delay: 1050, pts: circle(0.268, 0.36, 0.011) },
    { name: 'rizky_07',   color: '#ff3b1f', size: 9,  delay: 1200, pts: arc(0.24, 0.44, 0.05, 0.35, Math.PI - 0.35) },

    { name: 'mira.draws', color: '#4de2c2', size: 12, delay: 700,  pts: heart(0.52, 0.4, 0.075) },
    { name: 'mira.draws', color: '#4de2c2', size: 6,  delay: 1900, pts: squiggle(0.44, 0.62, 0.62, 0.028, 3) },

    { name: 'bang_deni',  color: '#ffb020', size: 11, delay: 1500, pts: star(0.78, 0.36, 0.075) },
    { name: 'bang_deni',  color: '#ffb020', size: 7,  delay: 2500, pts: line(0.70, 0.56, 0.86, 0.56) },
    { name: 'bang_deni',  color: '#ffb020', size: 7,  delay: 2750, pts: line(0.86, 0.56, 0.815, 0.50) },
    { name: 'bang_deni',  color: '#ffb020', size: 7,  delay: 2900, pts: line(0.86, 0.56, 0.815, 0.62) },

    { name: 'nay',        color: '#b07cff', size: 8,  delay: 3200, pts: squiggle(0.16, 0.80, 0.86, 0.035, 6) },
  ];

  const CYCLE_TAIL_MS = 2600;
  const POINTS_PER_FRAME = 3;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced) {
    // No animation: paint the finished frame once and stop.
    board.setStrokes(SCRIPT.map((s, i) => ({
      id: `demo-${i}`, name: s.name, color: s.color, size: s.size,
      tool: 'pen', pts: s.pts, t: Date.now(), done: true,
    })));
    return;
  }

  let started = 0;
  let live = [];
  let cycleStart = performance.now();

  function tick(now) {
    const elapsed = now - cycleStart;

    // Kick off any stroke whose cue has arrived.
    while (started < SCRIPT.length && SCRIPT[started].delay <= elapsed) {
      const spec = SCRIPT[started];
      const id = `demo-${cycleStart}-${started}`;
      board.addStroke({
        id, name: spec.name, color: spec.color, size: spec.size,
        tool: 'pen', pts: [spec.pts[0], spec.pts[1]], t: Date.now(), done: false,
      });
      live.push({ id, pts: spec.pts, cursor: 1 });
      started++;
    }

    // Advance every in-flight stroke.
    for (const stroke of live) {
      if (stroke.cursor * 2 >= stroke.pts.length) continue;
      const slice = stroke.pts.slice(stroke.cursor * 2, (stroke.cursor + POINTS_PER_FRAME) * 2);
      if (slice.length) {
        board.appendPoints(stroke.id, slice);
        stroke.cursor += slice.length / 2;
      }
      if (stroke.cursor * 2 >= stroke.pts.length) board.endStroke(stroke.id);
    }

    const allDone = started === SCRIPT.length && live.every((s) => s.cursor * 2 >= s.pts.length);
    const lastCue = SCRIPT[SCRIPT.length - 1].delay;
    if (allDone && elapsed > lastCue + CYCLE_TAIL_MS) {
      board.clear();
      live = [];
      started = 0;
      cycleStart = now;
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
