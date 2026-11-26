'use strict';
// [KINETIC-TITLE] Motion-graphic title templates (the "kinetic" hook looks).
//
// One template = one function that lays out a headline as a flat list of
// ELEMENTS (single letters, words, filled shapes, stroked doodles), each with
// its own keyframes. Two writers consume that list:
//   toAssEvents()  -> libass Dialogue lines   (burn, this file)
//   renderer.js    -> absolutely positioned DOM + WAAPI keyframes (preview)
// so the preview and the burned clip are driven by the SAME geometry and the
// SAME timing — the lesson of every earlier preview≠burn bug in this app.
//
// Timing follows the kinetic-typography principles (easeOutExpo-ish entries,
// chars 20-40 ms apart, words 40-70 ms, whole reveal capped near ~800 ms):
// libass \t accel < 1 is an ease-out curve, used for every entry.
//
// Element shape:
//   { kind:'text', text, font, px, color, oc, ow, sc, sd, bold, x, y, rot,
//     keys:[{t, sx, sy, rot, a, x, y, blur, clip}] , a0, ord }
//   { kind:'shape', path, color, oc, ow, fillA, x, y, rot, keys:[...] }
// x/y are the element CENTRE in canonical 1080x1920 space; `keys` are deltas
// applied over time (t in ms from the title start). sx/sy in %, a = opacity 0..1,
// rot in degrees (absolute), clip = [l,t,r,b] in element-local px (wipe mask).
(function (root) {
const IS_NODE = typeof module !== 'undefined' && module.exports && typeof window === 'undefined';
const FM = IS_NODE ? require('./font-metrics') : null;

const EASE_OUT = 0.45;   // libass \t accel: <1 decelerates (easeOut)

// Relative luminance 0..1 of #rrggbb (sRGB weights, no gamma: a ranking only).
function glowLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
function hexToAss(hex) {
  const h = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
function alphaHex(a) {
  const v = Math.round(255 * (1 - Math.max(0, Math.min(1, a))));
  return `&H${v.toString(16).padStart(2, '0').toUpperCase()}&`;
}

// Deterministic PRNG so one headline always gets the same "random" jitter —
// preview, burn and a re-render must agree letter for letter.
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

let _fontsDir = null;
function fontsDir() {
  if (_fontsDir || !IS_NODE) return _fontsDir;
  try { _fontsDir = require('./pipeline-inverse-v1').__test.assFontsDirFs(); } catch { _fontsDir = ''; }
  return _fontsDir;
}
function setFontsDir(d) { _fontsDir = d; }

// Width in px of `text` set at CSS px `px` (font-metrics gives em widths).
// Browser: canvas advance widths of the same @font-face files libass burns.
let _ctx = null;
function canvasWidthEm(text, font, italic) {
  if (!_ctx) _ctx = document.createElement('canvas').getContext('2d');
  _ctx.font = `${italic ? 'italic ' : ''}100px "${font}"`;
  return _ctx.measureText(String(text)).width / 100;
}
// [KINETIC-WIDTHS] One table for burn and preview (see gen-kinetic-widths.js).
const WIDTHS = IS_NODE ? require('./kinetic-widths') : (root.KineticWidths || null);
function tableWidthEm(text, font) {
  const t = WIDTHS && WIDTHS[font];
  if (!t) return null;
  let sum = 0;
  for (const ch of String(text)) {
    const a = t[ch.codePointAt(0).toString(36)];
    if (a == null) return null;
    sum += a;
  }
  return sum;
}
function widthPx(text, font, px, italic = false) {
  let em = italic ? null : tableWidthEm(text, font);
  if (em == null) em = FM ? FM.textWidthEm(text, assFontName(font), fontsDir(), false, italic) : canvasWidthEm(text, font, italic);
  return (em == null ? 0.55 * String(text).length : em) * px;
}

// Lay letters of `word` left->right starting at x0; returns centres.
function letterCentres(word, font, px, x0) {
  const out = [];
  const chars = Array.from(word);
  for (let i = 0; i < chars.length; i++) {
    const pre = widthPx(chars.slice(0, i).join(''), font, px);
    const w = widthPx(chars[i], font, px);
    out.push({ ch: chars[i], cx: x0 + pre + w / 2, w });
  }
  return out;
}

// Greedy line split by a max width.
function wrapWords(words, font, px, maxW) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    const tryL = cur.concat(w).join(' ');
    if (cur.length && widthPx(tryL, font, px) > maxW) { lines.push(cur); cur = [w]; } else cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Split words into exactly k lines minimising the widest line (words <= ~10,
// so trying every cut is cheap). Balanced lines read as a designed lockup.
function balancedLines(words, k, font, px) {
  k = Math.max(1, Math.min(k, words.length));
  let best = null;
  const rec = (start, left, acc) => {
    if (left === 1) {
      const lines = acc.concat([words.slice(start)]);
      const m = Math.max(...lines.map((l) => widthPx(l.join(' '), font, px)));
      if (!best || m < best.m) best = { m, lines };
      return;
    }
    for (let e = start + 1; e <= words.length - left + 1; e++) rec(e, left - 1, acc.concat([words.slice(start, e)]));
  };
  rec(0, k, []);
  return best.lines;
}

// Rotate point (x,y) about (ox,oy) by deg (screen coords, +deg = clockwise
// like CSS rotate; libass \frz is counter-clockwise, handled in the writer).
function rotPt(x, y, ox, oy, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = x - ox, dy = y - oy;
  return [ox + dx * c - dy * s, oy + dx * s + dy * c];
}

// ---------------------------------------------------------------------------
// Drawing helpers (ASS \p1 paths in a local box, origin top-left).
const P = {
  rect: (w, h) => `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`,
  // parallelogram band skewed by k px
  band: (w, h, k) => `m ${k} 0 l ${w} 0 ${w - k} ${h} 0 ${h}`,
  // torn tape: jagged short edges
  tape: (w, h, r) => {
    const pts = [[0, 0]];
    const teeth = 5;
    for (let i = 1; i <= teeth; i++) pts.push([w - (i % 2 ? r() * 14 : 0), (h * i) / teeth]);
    for (let i = teeth - 1; i >= 0; i--) pts.push([(i % 2 ? r() * 14 : 0), (h * i) / teeth]);
    // close: top edge back to start already implied
    const [first, ...rest] = [[0, 0], [w, 0], ...pts.slice(1)];
    return `m ${first[0]} ${first[1]} l ${rest.map((p) => `${p[0] | 0} ${p[1] | 0}`).join(' ')}`;
  },
  // torn paper strip: ragged top and bottom edges, slightly uneven ends
  paper: (w, h, r) => {
    const top = [], bot = [];
    const n = Math.max(6, Math.round(w / 22));
    for (let i = 0; i <= n; i++) top.push([(w * i) / n, r() * 6]);
    for (let i = n; i >= 0; i--) bot.push([(w * i) / n, h - r() * 6]);
    const pts = top.concat([[w - r() * 4, h * 0.5]], bot, [[r() * 4, h * 0.5]]);
    return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
  // tapered spike (burst line) pointing up-right, length L
  spike: (L, w) => `m 0 ${w} l ${L} 0 ${L} ${w * 0.35} 0 ${w * 1.35}`,
  // tick / check mark
  check: (s) => `m 0 ${s * 0.55} l ${s * 0.22} ${s * 0.38} ${s * 0.42} ${s * 0.62} ${s} 0 ${s * 1.12} ${s * 0.16} ${s * 0.42} ${s * 0.92}`,
  // ring arc (thick quarter ring) — approximated with line segments
  arc: (R, th, a0, a1) => {
    const n = 14, o = [], i2 = [];
    for (let i = 0; i <= n; i++) {
      const a = (a0 + (a1 - a0) * (i / n)) * Math.PI / 180;
      o.push([R + R * Math.cos(a), R + R * Math.sin(a)]);
      i2.push([R + (R - th) * Math.cos(a), R + (R - th) * Math.sin(a)]);
    }
    const pts = o.concat(i2.reverse());
    return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
  // hand-drawn ellipse loop (stroke via outline only)
  loop: (w, h, r) => {
    const n = 22, pts = [];
    for (let i = 0; i <= n + 3; i++) {
      const a = (i / n) * Math.PI * 2 - 0.4;
      const j = 1 + (r() - 0.5) * 0.08;
      pts.push([w / 2 + (w / 2) * Math.cos(a) * j, h / 2 + (h / 2) * Math.sin(a) * j]);
    }
    return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
  // scribble strike line
  strike: (w, r) => {
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push([(w * i) / 8, (r() - 0.5) * 10 + (i % 2) * 3]);
    return `m ${pts[0][0]} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
  },
};

// ---------------------------------------------------------------------------
// TEMPLATES. Each returns { elements, box:{top,bottom,left,right} } for a title
// centred at (cx, cy) with base size `px` (canonical 1080x1920 space).

function letterPop(lines, { font, px, color, oc, ow, sc, sd, lineGap, cx, cy, rot, t0, stagger, popMs, from = 0, overshoot = 118, lineStyle }) {
  const els = [];
  const lh = px * lineGap;
  const total = lines.length * lh;
  let k = 0;
  lines.forEach((ln, li) => {
    const st = lineStyle ? lineStyle(li) : {};
    const fpx = st.px || px;
    const text = ln.join(' ');
    const W = widthPx(text, st.font || font, fpx);
    const y = cy - total / 2 + lh * li + lh / 2;
    letterCentres(text, st.font || font, fpx, cx - W / 2).forEach((L) => {
      if (L.ch === ' ') return;
      const [x, yy] = rotPt(L.cx, y, cx, cy, rot);
      const t = t0 + k * stagger;
      k++;
      els.push({
        kind: 'text', text: L.ch, font: st.font || font, px: fpx, color: st.color || color, oc: st.oc || oc, ow: st.ow ?? ow,
        sc: st.sc || sc, sd: st.sd ?? sd, x, y: yy, rot,
        keys: [{ t: 0, sx: from, sy: from, a: 0 }, { t, sx: from, sy: from, a: 0 }, { t: t + 1, a: 1 },
          { t: t + popMs * 0.6, sx: overshoot, sy: overshoot }, { t: t + popMs, sx: 100, sy: 100 }],
      });
    });
  });
  return els;
}

// [HOOK-SUB] "MAIN | SMALL" — the small line (kicker label / sub-headline) rides
// in the same title text after a bar, so it stays editable as one field.
// Pure connectors only: "BISA SEMBUNYIKAN" keeps "BISA" inside the box.
const SOROT_SKIP = new Set('yang dan di ke dari ini itu untuk dengan karena jadi tapi atau the a an to of and or in on for'.split(' '));
// [KIN-CAP-NO-BLINK] Fade-out of a kinetic caption cue: none when the next cue
// follows within `gap` s (it replaces this one), else a short 80 ms fade.
// Shared by the burn (toAssEvents) and the preview (paintKineticTitle).
function kinCapFadeMs(cue, next, gap = 0.05) {
  return next && cue && (+next.start - +cue.end) <= gap ? 0 : 80;
}
function splitSub(text) {
  const t = String(text || '');
  const i = t.indexOf('|');
  return i < 0 ? [t.trim(), ''] : [t.slice(0, i).trim(), t.slice(i + 1).trim()];
}
// Wrap at maxW, shrinking the size until it fits in maxLines.
function fitWrap(words, font, px, maxW, maxLines) {
  let p = px, lines = wrapWords(words, font, p, maxW);
  while (lines.length > maxLines && p > px * 0.55) { p *= 0.9; lines = wrapWords(words, font, p, maxW); }
  return { lines, px: p };
}

const TEMPLATES = {
  // Sticker headline: chunky rounded pink letters popping in one by one, the
  // second line on a lime skewed ribbon that wipes in, plus burst spikes,
  // spinning arcs and a check mark. Whole lockup tilted a few degrees.
  stiker_pop(text, o) {
    const r = rng(text);
    const words = text.split(/\s+/).filter(Boolean);
    const px = (o.px || 140) * (o.k || 1);
    const font = 'CooperBlkBT-Regular';
    const rot = -5;
    // Reference lockup: a short BIG line on top, the rest on the ribbon.
    // Top = first ~40% of the words (1-3), shrunk to fit one line; ribbon =
    // the rest, shrunk to fit one line too.
    const up = words.map((w) => w.toUpperCase());
    const nRib = up.length <= 2 ? up.length - 1 : Math.min(3, Math.floor(up.length / 2));
    const top = up.slice(0, up.length - nRib);
    const rib = up.slice(up.length - nRib);
    const fitPx = (t, f, p0, maxW) => Math.min(p0, Math.floor(p0 * maxW / Math.max(1, widthPx(t, f, p0))));
    const ribFont = 'CooperBlkBT-Regular';
    const big = Math.max(px, 140);
    const nL = Math.min(3, wrapWords(top, font, big, 920).length);
    const topLines = balancedLines(top, nL, font, big);
    // 860 not 920: the lockup is tilted, so its corners reach further out.
    const topPx = Math.min(...topLines.map((l) => fitPx(l.join(' '), font, big, 860)));
    const ribPx = rib.length ? fitPx(rib.join(' '), ribFont, Math.round(topPx * 0.62), 860) : 0;
    const cx = o.cx, cy = o.cy;
    const topH = topPx * 1.0 * topLines.length;
    const ribH = rib.length ? ribPx * 1.75 : 0;
    const H = topH + ribH;
    const topCy = cy - H / 2 + topH / 2;
    const ribCy = cy + H / 2 - ribH / 2 + ribPx * 0.12;
    const els = [];
    // Ribbon band first (drawn under its text).
    if (rib.length) {
      const rt = rib.join(' ');
      const rw = widthPx(rt, ribFont, ribPx) + ribPx * 1.1;
      const bh = ribPx * 1.32;
      const [bx, by] = rotPt(cx, ribCy, cx, cy, rot);
      els.push({ kind: 'shape', path: P.band(rw, bh, bh * 0.28), w: rw, h: bh, color: '#29b34a', oc: '#0b4f22', ow: 5, sd: 7, sc: '#0b3a1a', x: bx, y: by, rot,
        keys: [{ t: 0, a: 0, clip: [0, 0, 0, bh] }, { t: 180, a: 1, clip: [0, 0, 0, bh] }, { t: 520, clip: [0, -40, rw + 40, bh + 40] }] });
    }
    els.push(...letterPop(topLines, { font, px: topPx, color: '#ff3fa4', oc: '#5c0a3a', ow: 7, sc: '#3b0726', sd: 7, lineGap: 1.0, cx, cy: topCy, rot, t0: 60, stagger: Math.min(38, 640 / Math.max(1, topLines.flat().join("").length)), popMs: 260 }));
    if (rib.length) {
      const n0 = topLines.flat().join('').length;
      els.push(...letterPop([rib], { font: ribFont, px: ribPx, color: '#f2ff3b', oc: '#0b4f22', ow: 5, sc: '#0b3a1a', sd: 4, lineGap: 1.0, cx, cy: ribCy + 2, rot, t0: 260 + n0 * 10, stagger: 30, popMs: 220 }));
    }
    // Decorations around the lockup.
    const halfW = Math.min(500, Math.max(...topLines.map((l) => widthPx(l.join(' '), font, topPx))) / 2 + 30);
    const burst = ['#ffe81a', '#ffe81a', '#36c759', '#3a6bff', '#ff9f1a'];
    burst.forEach((c, i) => {
      const ang = -120 + i * 14 + (r() - 0.5) * 6;
      const L = 70 + r() * 50;
      const bx = cx - halfW + 10 + i * 12, by = cy - H / 2 - 30 - (i % 2) * 14;
      els.push({ kind: 'shape', path: P.spike(L, 12), w: L, h: 16, color: c, x: bx, y: by, rot: ang,
        keys: [{ t: 0, a: 0, sx: 0, sy: 100 }, { t: 340 + i * 30, a: 0, sx: 0 }, { t: 341 + i * 30, a: 1 }, { t: 520 + i * 30, sx: 115 }, { t: 640 + i * 30, sx: 100 }] });
    });
    [['#36e0ff', 56, 18, 0], ['#3a46ff', 40, 14, 40]].forEach(([c, R, th, d], i) => {
      els.push({ kind: 'shape', path: P.arc(R, th, 120, 300), w: R * 2, h: R * 2, color: c, x: cx - halfW + 10 + i * 6, y: cy + H / 2 + 40 + i * 4, rot: 0,
        keys: [{ t: 0, a: 0, rot: -90 }, { t: 420 + d, a: 0, rot: -90 }, { t: 421 + d, a: 1 }, { t: 900 + d, rot: 30 }, { t: 3200, rot: 70 }] });
    });
    els.push({ kind: 'shape', path: P.check(78), w: 88, h: 88, color: '#ff3fa4', oc: '#5c0a3a', ow: 4, x: cx + halfW - 10, y: cy + H / 2 + 36, rot: -6,
      keys: [{ t: 0, a: 0, sx: 0, sy: 0 }, { t: 560, a: 0, sx: 0, sy: 0 }, { t: 561, a: 1 }, { t: 720, sx: 125, sy: 125 }, { t: 840, sx: 100, sy: 100 }] });
    return { elements: els, box: { top: cy - H / 2 - 110, bottom: cy + H / 2 + 90 } };
  },

  // Riot zine: condensed yellow capitals, every letter dropped in with its own
  // tilt and bounce, then a scribbled loop around the last word, a strike
  // under the first and a black ticker strip of the text scrolling below.
  riot(text, o) {
    const r = rng(text);
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const px = (o.px || 150) * (o.k || 1);
    const font = 'Anton';
    const cx = o.cx, cy = o.cy;
    const lines = wrapWords(words, font, px, 860);
    const lh = px * 1.08;
    const H = lines.length * lh;
    const els = [];
    let k = 0;
    // Random drop order inside the reveal window (like the reference: letters
    // land scattered, not left-to-right).
    const all = [];
    lines.forEach((ln, li) => {
      const t = ln.join(' ');
      const W = widthPx(t, font, px);
      const wordTilt = ln.map(() => (r() - 0.5) * 10);
      let wi = 0;
      const y = cy - H / 2 + lh * li + lh / 2;
      letterCentres(t, font, px, cx - W / 2).forEach((L) => {
        if (L.ch === ' ') { wi++; return; }
        all.push({ L, y: y + (r() - 0.5) * 14, rot: wordTilt[wi] + (r() - 0.5) * 7, line: li, word: wi });
      });
    });
    const order = all.map((_, i) => i).sort(() => r() - 0.5);
    order.forEach((idx, n) => { all[idx].t = 80 + n * Math.min(40, 560 / all.length); });
    all.forEach((A) => {
      const t = A.t;
      els.push({ kind: 'text', text: A.L.ch, font, px, color: '#f5f01f', oc: '#111111', ow: 6, sc: '#000000', sd: 0, x: A.L.cx, y: A.y, rot: A.rot,
        keys: [{ t: 0, a: 0, sx: 170, sy: 170, rot: A.rot + (r() - 0.5) * 40, y: A.y - 90 }, { t, a: 0 }, { t: t + 1, a: 1 },
          { t: t + 140, sx: 92, sy: 92, rot: A.rot, y: A.y }, { t: t + 230, sx: 100, sy: 100 }] });
      k++;
    });
    const doneT = 80 + all.length * Math.min(40, 560 / all.length) + 60;   // doodles start as the last letters land
    // Loop around the last word.
    const lastLine = lines[lines.length - 1];
    const lastW = widthPx(lastLine[lastLine.length - 1], font, px);
    const lineW = widthPx(lastLine.join(' '), font, px);
    const lx = cx + lineW / 2 - lastW / 2, ly = cy + H / 2 - lh / 2;
    els.push({ kind: 'shape', path: P.loop(lastW + 70, lh * 0.95, r), w: lastW + 70, h: lh * 0.95, color: '#ffffff', fillA: 0, oc: '#ffffff', ow: 3, x: lx, y: ly, rot: -8,
      keys: [{ t: 0, a: 0, clip: [0, 0, 0, lh] }, { t: doneT, a: 0 }, { t: doneT + 1, a: 1 }, { t: doneT + 380, clip: [-20, -20, lastW + 100, lh + 20] }] });
    // Strike through the first word.
    const firstW = widthPx(lines[0][0], font, px);
    const fW0 = widthPx(lines[0].join(' '), font, px);
    const sx0 = cx - fW0 / 2 + firstW / 2, sy0 = cy - H / 2 + lh * 0.5;
    els.push({ kind: 'shape', path: P.strike(firstW + 30, r), w: firstW + 30, h: 14, color: '#ffffff', oc: '#ffffff', ow: 2, fillA: 0, x: sx0, y: sy0, rot: -4,
      keys: [{ t: 0, a: 0, clip: [0, -20, 0, 34] }, { t: doneT + 150, a: 0 }, { t: doneT + 151, a: 1 }, { t: doneT + 400, clip: [-10, -20, firstW + 50, 34] }] });
    // Ticker strip.
    const tick = (`${words.join(' ')} • `).repeat(4);
    const tpx = 46;
    const tW = widthPx(tick, font, tpx);
    const ty = cy + H / 2 + 70;
    els.push({ kind: 'shape', bleed: true, path: P.rect(1300, 72), w: 1300, h: 72, color: '#111111', x: 540, y: ty, rot: -3,
      keys: [{ t: 0, a: 0, clip: [0, 0, 0, 72] }, { t: doneT - 150, a: 0 }, { t: doneT - 149, a: 0.92 }, { t: doneT + 200, clip: [0, 0, 1300, 72] }] });
    els.push({ kind: 'text', bleed: true, text: tick, font, px: tpx, color: '#f2f2f2', oc: '#111111', ow: 0, sd: 0, x: 540 + tW / 2 - 700, y: ty + 2, rot: -3,
      keys: [{ t: 0, a: 0 }, { t: doneT, a: 0 }, { t: doneT + 200, a: 1 }, { t: 3500, x: 540 + tW / 2 - 700 - 360, y: ty + 2 - 19 }] });
    return { elements: els, box: { top: cy - H / 2 - 40, bottom: ty + 50 } };
  },

  // Tape label: a torn yellow strip of tape wipes across, then the headline
  // types onto it as ransom-note letters (alternating faces, some inverted).
  lakban(text, o) {
    const r = rng(text);
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const px = (o.px || 96) * (o.k || 1);
    const faces = ['Anton', 'CooperBlkBT-Regular', 'Times New Roman MT Condensed', 'Anton', "Editor'sNote-Semibold"];
    const cx = o.cx, cy = o.cy;
    // Pick each letter's face/size first, then wrap on those real widths so
    // the tape never runs off the frame.
    const specOf = (ch) => {
      const f = faces[Math.floor(r() * faces.length)];
      const p = px * (0.9 + r() * 0.25);
      return { ch, f, p, w: ch === ' ' ? px * 0.35 : widthPx(ch, f, p) + 6, inv: r() < 0.22 };
    };
    const wordSpecs = words.map((w) => Array.from(w).map(specOf));
    const wW = (ws) => ws.reduce((a, c) => a + c.w, 0);
    const MAXW = 840;
    const lines = [];
    let cur = [];
    wordSpecs.forEach((ws) => {
      const next = cur.length ? cur.concat([[specOf(' ')], ws]) : [ws];
      if (cur.length && wW(next.flat()) > MAXW) { lines.push(cur); cur = [ws]; } else cur = next;
    });
    if (cur.length) lines.push(cur);
    const lh = px * 1.45;
    const H = lines.length * lh;
    const els = [];
    let k = 0;
    const nCh = words.join('').length;
    lines.forEach((ln, li) => {
      const y = cy - H / 2 + lh * li + lh / 2;
      let spec = ln.flat();
      let W = wW(spec);
      if (W > MAXW) { const f = MAXW / W; spec = spec.map((c) => Object.assign({}, c, { p: c.p * f, w: c.w * f })); W = MAXW; }
      const tw = W + 70;
      const tT = li * 110;
      els.push({ kind: 'shape', path: P.tape(tw, lh * 0.92, r), w: tw, h: lh * 0.92, color: '#ffe100', x: cx, y, rot: li % 2 ? 1.5 : -2,
        keys: [{ t: 0, a: 1, clip: [0, -10, 0, lh + 10] }, { t: tT, clip: [0, -10, 0, lh + 10] }, { t: tT + 300, clip: [-10, -10, tw + 20, lh + 10] }] });
      let x = cx - W / 2;
      spec.forEach((c) => {
        const ccx = x + c.w / 2; x += c.w;
        if (c.ch === ' ') return;
        const at = tT + 260 + k * Math.min(34, 520 / Math.max(1, nCh)); k++;
        const rot = (r() - 0.5) * 8;
        if (c.inv) {
          els.push({ kind: 'shape', path: P.rect(c.w + 2, c.p * 0.95), w: c.w + 2, h: c.p * 0.95, color: '#111111', x: ccx, y, rot,
            keys: [{ t: 0, a: 0 }, { t: at, a: 0 }, { t: at + 1, a: 1 }] });
        }
        els.push({ kind: 'text', text: c.ch, font: c.f, px: c.p, color: c.inv ? '#ffe100' : '#111111', oc: '#000000', ow: 0, sd: 0, x: ccx, y: y + 2, rot,
          keys: [{ t: 0, a: 0, sx: 140, sy: 140 }, { t: at, a: 0, sx: 140, sy: 140 }, { t: at + 1, a: 1 }, { t: at + 90, sx: 100, sy: 100 }] });
      });
    });
    return { elements: els, box: { top: cy - H / 2, bottom: cy + H / 2 } };
  },

  // [HOOK-SOROTAN] News-highlight look: a small red pill label on top, a
  // condensed white headline, and the payoff phrase of one line knocked out on
  // a red box. Text: "HEADLINE | LABEL" (label defaults to SOROTAN).
  sorotan(text, o) {
    const [main, kick0] = splitSub(text);
    // Case comes from the hook text itself (Huruf hook setting), never forced.
    const words = main.split(/\s+/).filter(Boolean);
    if (!words.length) return { elements: [], box: null };
    const font = 'Anton', kfont = 'Inter SOCL Black';
    const cx = o.cx, cy = o.cy;
    const fit = fitWrap(words, font, (o.px || 118) * (o.k || 1), 900, 3);
    const lines = fit.lines, px = fit.px;
    const lh = px * 1.1;
    const H = lines.length * lh;
    const els = [];
    // Label pill.
    const kick = kick0 || 'SOROTAN';
    const kpx = Math.max(22, px * 0.27);
    const kW = widthPx(kick, kfont, kpx) + kpx * 1.2, kH = kpx * 1.75;
    const ky = cy - H / 2 - kH / 2 - px * 0.14;
    els.push({ kind: 'shape', path: P.rect(kW, kH), w: kW, h: kH, color: '#E5202E', x: cx, y: ky, rot: 0,
      keys: [{ t: 0, a: 0, sx: 60, sy: 60 }, { t: 40, a: 0, sx: 60, sy: 60 }, { t: 41, a: 1 }, { t: 200, sx: 108, sy: 108 }, { t: 280, sx: 100, sy: 100 }] });
    els.push({ kind: 'text', text: kick, font: kfont, px: kpx, color: '#FFFFFF', oc: '#000000', ow: 0, sd: 0, x: cx, y: ky + kpx * 0.04, rot: 0,
      keys: [{ t: 0, a: 0 }, { t: 120, a: 0 }, { t: 220, a: 1 }] });
    // Which line carries the payoff box: the middle of three, else the last.
    const hiLine = lines.length >= 3 ? 1 : lines.length - 1;
    lines.forEach((ln, li) => {
      const y = cy - H / 2 + lh * li + lh / 2;
      const t = ln.join(' ');
      const W = widthPx(t, font, px);
      const at = 160 + li * 110;
      if (li === hiLine && lines.length > 1 || (lines.length === 1 && ln.length > 1)) {
        // Box the phrase after any leading connector words ("YANG [BISA SEMBUNYIKAN]").
        let s0 = 0;
        while (s0 < ln.length - 1 && SOROT_SKIP.has(ln[s0].toLowerCase())) s0++;
        if (lines.length === 1) s0 = Math.max(s0, Math.ceil(ln.length / 2));
        const pre = ln.slice(0, s0).join(' ');
        const hi = ln.slice(s0).join(' ');
        const x0 = cx - W / 2 + (pre ? widthPx(pre + ' ', font, px) : 0);
        const hw = widthPx(hi, font, px), pad = px * 0.12;
        const bw = hw + pad * 2, bh = px * 1.02;
        els.push({ kind: 'shape', path: P.rect(bw, bh), w: bw, h: bh, color: '#E5202E', x: x0 + hw / 2, y: y + px * 0.02, rot: 0,
          keys: [{ t: 0, a: 1, clip: [0, -4, 0, bh + 4] }, { t: at + 120, clip: [0, -4, 0, bh + 4] }, { t: at + 360, clip: [-4, -4, bw + 4, bh + 4] }] });
      }
      // Thin hard shadow: burn (\shad) and preview (text-shadow) draw it the same.
      els.push({ kind: 'text', text: t, font, px, color: '#FFFFFF', oc: '#000000', ow: 0, sc: '#000000', sd: 2, x: cx, y, rot: 0,
        keys: [{ t: 0, a: 0, y: y + px * 0.35 }, { t: at, a: 0, y: y + px * 0.35 }, { t: at + 240, a: 1, y }] });
    });
    return { elements: els, box: { top: ky - kH / 2, bottom: cy + H / 2 } };
  },

  // [HOOK-KERTAS] Torn-paper headline: each line on its own ragged white strip,
  // heavy black capitals, and a yellow sub-headline bar under it.
  // Text: "HEADLINE | SUB-HEADLINE" (no bar = headline only).
  kertas_sobek(text, o) {
    const r = rng(text);
    const [main, sub] = splitSub(text);
    const words = main.split(/\s+/).filter(Boolean);
    if (!words.length) return { elements: [], box: null };
    const font = 'Inter SOCL Black';
    const cx = o.cx, cy = o.cy;
    const fit = fitWrap(words, font, (o.px || 100) * (o.k || 1), 820, 3);
    const lines = fit.lines, px = fit.px;
    const sh = px * 1.16, gap = px * 0.1;
    const subWords = sub.split(/\s+/).filter(Boolean);
    const sfit = subWords.length ? fitWrap(subWords, font, Math.max(24, px * 0.34), 900, 2) : { lines: [], px: 0 };
    const spx = sfit.px, slh = spx * 1.6;
    const Hm = lines.length * sh + (lines.length - 1) * gap;
    const Hs = sfit.lines.length ? sfit.lines.length * slh + px * 0.22 : 0;
    const top = cy - (Hm + Hs) / 2;
    const els = [];
    lines.forEach((ln, li) => {
      const t = ln.join(' ');
      const W = widthPx(t, font, px);
      const y = top + li * (sh + gap) + sh / 2;
      const pw = W + px * 0.5;
      const rot = li % 2 ? 0.6 : -0.8;
      const at = 60 + li * 130;
      els.push({ kind: 'shape', path: P.paper(pw, sh, r), w: pw, h: sh, color: '#F6F5F0', x: cx, y, rot, sc: '#000000', sd: 0,
        keys: [{ t: 0, a: 0, sx: 118, sy: 118 }, { t: at, a: 0, sx: 118, sy: 118 }, { t: at + 1, a: 1 }, { t: at + 150, sx: 98, sy: 98 }, { t: at + 230, sx: 100, sy: 100 }] });
      els.push({ kind: 'text', text: t, font, px, color: '#111111', oc: '#000000', ow: 0, sd: 0, x: cx, y: y + px * 0.03, rot,
        keys: [{ t: 0, a: 0, sx: 118, sy: 118 }, { t: at + 40, a: 0, sx: 118, sy: 118 }, { t: at + 41, a: 1 }, { t: at + 190, sx: 98, sy: 98 }, { t: at + 270, sx: 100, sy: 100 }] });
    });
    const subT = 60 + lines.length * 130 + 160;
    sfit.lines.forEach((ln, si) => {
      const t = ln.join(' ');
      const W = widthPx(t, font, spx);
      const y = top + Hm + px * 0.22 + si * slh + slh / 2;
      const bw = W + spx * 0.9, bh = spx * 1.5;
      els.push({ kind: 'shape', path: P.rect(bw, bh), w: bw, h: bh, color: '#FFE14D', x: cx, y, rot: 0,
        keys: [{ t: 0, a: 1, clip: [0, -4, 0, bh + 4] }, { t: subT + si * 80, clip: [0, -4, 0, bh + 4] }, { t: subT + si * 80 + 260, clip: [-4, -4, bw + 4, bh + 4] }] });
      els.push({ kind: 'text', text: t, font, px: spx, color: '#111111', oc: '#000000', ow: 0, sd: 0, x: cx, y: y + spx * 0.04, rot: 0,
        keys: [{ t: 0, a: 0 }, { t: subT + si * 80 + 160, a: 0 }, { t: subT + si * 80 + 300, a: 1 }] });
    });
    return { elements: els, box: { top, bottom: top + Hm + Hs } };
  },

  // From the kinetic-typography recipes: mask/clip reveal — each line wipes
  // up out of a hidden baseline, 80 ms apart, easeOutExpo, clean bold sans.
  mask_naik(text, o) {
    const words = text.split(/\s+/).filter(Boolean);
    const px = (o.px || 128) * (o.k || 1);
    const font = 'Open Sauce Two ExtraBold';
    const cx = o.cx, cy = o.cy;
    const lines = wrapWords(words, font, px, 900);
    const lh = px * 1.12;
    const H = lines.length * lh;
    const els = [];
    lines.forEach((ln, li) => {
      const t = ln.join(' ');
      const y = cy - H / 2 + lh * li + lh / 2;
      const W = widthPx(t, font, px);
      const at = 60 + li * 90;
      els.push({ kind: 'text', text: t, font, px, color: '#ffffff', oc: '#000000', ow: 0, sc: '#000000', sd: 0, shadowSoft: true, x: cx, y, rot: 0,
        // Mask band a bit taller than the line so descenders (g, y) are not cut.
        clipAbs: [cx - W / 2 - 30, y - lh * 0.6, cx + W / 2 + 30, y + lh * 0.66],
        keys: [{ t: 0, y: y + lh }, { t: at, y: y + lh }, { t: at + 560, y }] });
      // accent bar under the last line, wiping left->right
      if (li === lines.length - 1) {
        els.push({ kind: 'shape', path: P.rect(W * 0.4, 12), w: W * 0.4, h: 12, color: '#c8ff2e', x: cx - W / 2 + W * 0.2, y: y + lh * 0.66, rot: 0,
          keys: [{ t: 0, clip: [0, 0, 0, 12] }, { t: at + 400, clip: [0, 0, 0, 12] }, { t: at + 760, clip: [0, 0, W * 0.4, 12] }] });
      }
    });
    return { elements: els, box: { top: cy - H / 2, bottom: cy + H / 2 + 24 } };
  },

  // Blur-in focus pull, per-word stagger (recipes #2 + word stagger).
  fokus_blur(text, o) {
    const words = text.split(/\s+/).filter(Boolean);
    const px = (o.px || 132) * (o.k || 1);
    const font = "Editor'sNote-Medium";
    const cx = o.cx, cy = o.cy;
    const lines = wrapWords(words, font, px, 900);
    const lh = px * 1.05;
    const H = lines.length * lh;
    const els = [];
    let k = 0;
    lines.forEach((ln, li) => {
      const y = cy - H / 2 + lh * li + lh / 2;
      const W = widthPx(ln.join(' '), font, px);
      let x = cx - W / 2;
      ln.forEach((w) => {
        const wf = k % 3 === 1 ? "Editor'sNote-MediumItalic" : font;   // every 3rd word italic
        const ww = widthPx(w, wf, px);
        const at = 60 + k * 70; k++;
        els.push({ kind: 'text', text: w, font: wf, px, color: '#ffffff', oc: '#000000', ow: 0, sd: 0, glowSoft: true, x: x + ww / 2, y, rot: 0,
          keys: [{ t: 0, a: 0, blur: 14, sx: 108, sy: 108 }, { t: at, a: 0, blur: 14 }, { t: at + 500, a: 1, blur: 0, sx: 100, sy: 100 }] });
        x += ww + widthPx(' ', font, px);
      });
    });
    return { elements: els, box: { top: cy - H / 2, bottom: cy + H / 2 } };
  },
};

// ---------------------------------------------------------------------------
// [KINETIC-CAPTION] Caption templates: one cue (a short phrase) builds up word
// by word with a size hierarchy — small connective words, one big KEY word.
// opts: { cx, top, px, dur (cue length, ms) }. The key word is the most
// "contentful" one: longest word that is not a connector.
const CAP_STOP = new Set(('yang dan di ke dari itu ini aku saya gua gue lu lo kamu dia kita kami mereka untuk dengan karena jadi ada juga tapi aja saja sih kok nya pun lagi udah sudah akan bisa kalau kalo atau the a an to of and is are was in on it that this for you i we they be so but').split(' '));
function keyIndex(words) {
  let best = -1, bl = -1;
  words.forEach((w, i) => {
    const c = w.toLowerCase().replace(/[^a-z0-9À-ɏ]/g, '');
    const l = CAP_STOP.has(c) ? 0 : c.length;
    if (l >= bl) { bl = l; best = i; }
  });
  return best < 0 ? words.length - 1 : best;
}
// Word i appears at a time proportional to the characters before it, inside
// the first 70% of the cue (so the phrase is complete while it is spoken).
function wordTimes(words, dur) {
  const span = Math.max(120, Math.min(dur * 0.7, words.length * 420));
  const tot = words.reduce((a, w) => a + w.length + 1, 0) || 1;
  let acc = 0;
  return words.map((w) => { const t = (acc / tot) * span; acc += w.length + 1; return Math.round(t); });
}
// Lay a run of words on one line (centred at cx, or starting at x0 when left).
function wordRow(words, font, px, { cx, x0, y, italic }) {
  const sp = widthPx(' ', font, px);
  const ws = words.map((w) => widthPx(w, font, px, italic));
  const W = ws.reduce((a, b) => a + b, 0) + sp * Math.max(0, words.length - 1);
  let x = x0 != null ? x0 : cx - W / 2;
  return { W, items: words.map((w, i) => { const it = { w, x: x + ws[i] / 2, ww: ws[i] }; x += ws[i] + sp; return it; }), y };
}
function capPop(el, t, big) {
  el.keys = [{ t: 0, a: 0, sx: big ? 135 : 112, sy: big ? 135 : 112, blur: 6, y: el.y + (big ? 0 : 14) }, { t, a: 0 }, { t: t + 1, a: 1 },
    { t: t + (big ? 200 : 170), sx: 100, sy: 100, blur: 0, y: el.y }];
  return el;
}
// Fit a set of rows (each { words, font, px }) into maxW by shrinking all.
function fitRows(rows, maxW) {
  let k = 1;
  rows.forEach((r) => { const w = widthPx(r.words.join(' '), r.font, r.px, r.italic); if (w * k > maxW) k = maxW / w; });
  rows.forEach((r) => { r.px *= k; });
  return rows;
}
function capBuild(text, o, spec) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { elements: [], box: null };
  const ki = keyIndex(words);
  const times = wordTimes(words, o.dur || 1500);
  const rows = spec.rows(words, ki).filter((r) => r.words.length);
  fitRows(rows, spec.maxW || 900);
  const els = [];
  let y = o.top;
  rows.forEach((r) => {
    const lh = r.px * (r.lh || 1.05);
    const cy = y + lh / 2;
    const row = wordRow(r.words, r.font, r.px, { cx: o.cx, x0: spec.left ? o.cx - (spec.maxW || 900) / 2 + (r.indent || 0) : null, y: cy, italic: r.italic });
    // Keep every row on screen whatever the caption X is (a caption moved to
    // x=242 put the key word 12 px off the left edge).
    if (row.items.length) {
      const l = row.items[0].x - row.items[0].ww / 2, rr = row.items[row.items.length - 1].x + row.items[row.items.length - 1].ww / 2;
      const M = 40;
      const dx = l < M ? M - l : (rr > 1080 - M ? 1080 - M - rr : 0);
      if (dx) row.items.forEach((it) => { it.x += dx; });
    }
    row.items.forEach((it, j) => {
      const wi = r.idx[j];
      els.push(capPop({ kind: 'text', text: it.w, font: r.font, italic: false, px: r.px, color: r.color, oc: r.oc || '#000000', ow: r.ow || 0, sd: 0,
        shadowSoft: !r.glow, shade: true, glow: r.glow || null, x: it.x, y: cy, rot: 0 }, times[wi], wi === ki));
    });
    y += lh;
  });
  return { elements: els, box: { top: o.top, bottom: y } };
}
function capGlow(text, o, color, glow) {
  const px = (o.px || 140) * (o.k || 1);
  return capBuild(text, o, {
    rows: (w, k) => [
      { words: w.slice(0, k), idx: w.slice(0, k).map((_, i) => i), font: 'Open Sauce Two ExtraBold', px: px * 0.58, color: '#ffffff', lh: 1.1 },
      { words: [w[k]], idx: [k], font: 'Open Sauce Two ExtraBold', px, color, glow, lh: 1.0 },
      { words: w.slice(k + 1), idx: w.slice(k + 1).map((_, i) => k + 1 + i), font: 'Open Sauce Two ExtraBold', px: px * 0.58, color: '#ffffff', lh: 1.1 },
    ],
  });
}
// [CAP-FOKUS] Keynote-style captions (2026-10-12): a clean bold sans in two
// STAGGERED lines (one nudged right, the other left), every word focusing in
// from a blur, and the key word set apart — orange, or italic / capitals.
function capFocusEl(el, t) {
  el.keys = [{ t: 0, a: 0, blur: 16, sx: 96, sy: 96 }, { t, a: 0, blur: 16, sx: 96, sy: 96 }, { t: t + 340, a: 1, blur: 0, sx: 100, sy: 100 }];
  return el;
}
function capFocus(text, o, mode) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return { elements: [], box: null };
  const r = rng(text);
  const ki = keyIndex(words);
  const times = wordTimes(words, o.dur || 1500);
  let px = (o.px || 104) * (o.k || 1);
  // Open Sauce Two (user's pick, 2026-10-12): the Bold the app already ships
  // plus its own Bold Italic (identical advance widths, renamed the same way).
  // [SOROT-XB] Sorot (2026-10-12): Open Sauce ExtraBold squeezed to 92 %.
  const oranye = mode === 'oranye';
  const base = oranye ? 'Open Sauce Two ExtraBold' : 'Open Sauce Two Bold', ital = 'Open Sauce Two Bold Italic';
  const SX = oranye ? 86 : 100;   // [SOROT-NARROW] narrower (user, 2026-10-12)
  const glowKey = oranye && r() < 0.5 ? '#ff7a00' : null;   // sometimes the orange word glows
  // Two lines when there are 3+ words, split where the halves balance.
  let cut = words.length;
  if (words.length >= 3) {
    let best = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(widthPx(words.slice(0, i).join(' '), base, px) - widthPx(words.slice(i).join(' '), base, px));
      if (d < best) { best = d; cut = i; }
    }
  }
  const lines = [words.slice(0, cut), words.slice(cut)].filter((l) => l.length);
  const idxOf = (li, j) => (li === 0 ? j : cut + j);
  // Look B: a 3+ word second line is set in capitals; otherwise the key word
  // is the italic one. Look A: the key word is orange.
  const capsLine = mode === 'miring' && lines.length > 1 && lines[1].length >= 3 ? 1 : -1;
  const styleOf = (wi, li) => {
    if (li === capsLine) return { font: base, text: words[wi].toUpperCase(), color: '#FFFFFF' };
    if (wi === ki && mode === 'oranye') return { font: base, text: words[wi], color: '#F7A21B' };
    if (wi === ki && mode === 'miring') return { font: ital, text: words[wi], color: '#FFFFFF' };
    return { font: base, text: words[wi], color: '#FFFFFF' };
  };
  // [CAP-FOKUS-TRACK] Slightly tight tracking (user, 2026-10-12): -3.5% of
  // the size per glyph, carried on each element as `fsp` so the burn (\\fsp)
  // and the preview (letter-spacing) apply the same amount.
  const TRACK = -0.035;
  const wordW = (st) => (widthPx(st.text, st.font, px) + TRACK * px * st.text.length) * SX / 100;
  const spW = () => widthPx(' ', base, px) * SX / 100;
  const rowW = (ln, li) => ln.reduce((a, w, j) => a + wordW(styleOf(idxOf(li, j), li)), 0) + spW() * (ln.length - 1);
  // Keep the widest line inside the frame.
  const maxW = 900;
  const widest = Math.max(...lines.map(rowW));
  if (widest > maxW) px *= maxW / widest;
  const Ws = lines.map(rowW);
  const shift = lines.length > 1 ? Math.min(140, Math.max(...Ws) * 0.16) * (r() < 0.5 ? 1 : -1) : 0;
  const lh = px * 1.08;
  const els = [];
  // [SOROT-MIX] a shuffled run of the five entrances: neighbouring words never share one
  const order = [0, 1, 2, 3, 4];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  lines.forEach((ln, li) => {
    const y = o.top + lh * li + lh / 2;
    const W = Ws[li];
    let x = o.cx - W / 2 + (li === 0 ? shift : -shift);
    // stay on screen whatever the caption X is
    const M = 40;
    if (x < M) x = M; if (x + W > 1080 - M) x = 1080 - M - W;
    ln.forEach((_, j) => {
      const wi = idxOf(li, j);
      const st = styleOf(wi, li);
      const ww = wordW(st);
      // [SOROT-BOLD] the coloured word heavier: a same-colour stroke on top of ExtraBold
      const heavy = oranye && wi === ki;
      const el = capFocusEl({ kind: 'text', text: st.text, font: st.font, px, fsp: TRACK * px, color: st.color, oc: heavy ? st.color : '#000000', ow: heavy ? 0.028 * px : 0, sc: '#000000', sd: 2, x: x + ww / 2, y, rot: 0,
        glow: wi === ki ? glowKey : null }, times[wi]);
      if (oranye) el.keys = sorotKeys(order[wi % order.length], times[wi], x + ww / 2, y, SX);   // [SOROT-MIX] each word its own entrance
      els.push(el);
      x += ww + spW();
    });
  });
  return { elements: els, box: { top: o.top, bottom: o.top + lh * lines.length } };
}
// [SOROT-MIX] Per-word entrances mixed inside one cue: blur focus, rise or pop.
// [SOROT-MIX] Five calm "podcast" entrances (soft, no bounce), one per word:
// 0 blur focus · 1 rise + fade · 2 settle down from 116 % · 3 slide in from the
// left · 4 drop from above. All land on the same final state.
function sorotKeys(kind, t, x, y, sx) {
  const end = { a: 1, blur: 0, sx, sy: 100, x, y };
  switch (kind) {
    case 0: return [{ t: 0, a: 0, blur: 18, sx: sx * 0.97, sy: 97 }, { t, a: 0, blur: 18, sx: sx * 0.97, sy: 97 }, Object.assign({ t: t + 380 }, end)];
    case 1: return [{ t: 0, a: 0, y: y + 30, sx, sy: 100 }, { t, a: 0, y: y + 30 }, Object.assign({ t: t + 300 }, end)];
    case 2: return [{ t: 0, a: 0, blur: 6, sx: sx * 1.16, sy: 116 }, { t, a: 0, blur: 6, sx: sx * 1.16, sy: 116 }, Object.assign({ t: t + 340 }, end)];
    case 3: return [{ t: 0, a: 0, x: x - 36, sx, sy: 100 }, { t, a: 0, x: x - 36 }, Object.assign({ t: t + 300 }, end)];
    default: return [{ t: 0, a: 0, y: y - 26, blur: 8, sx, sy: 100 }, { t, a: 0, y: y - 26, blur: 8 }, Object.assign({ t: t + 320 }, end)];
  }
}
// [CAP-QUOTE] Quote (2026-10-12, replaces Tegas + Lirik): Bootzy, lowercase,
// pure white solid, at its own width. Cues come 1–4 words (mixChunks max 4):
// 1–2 words sit on one line; 3–4 words stack (small lead-in / big key word /
// small tail, the capAcak stack). The key word is sometimes set in Open Sauce
// ExtraBold Italic. o.glow (the caption Glow switch) adds a soft white halo.
function capQuote(text, o) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const r = rng(`quote|${text}`);
  // italic only on 1–2 word lines: in the 3–4 word stack its taller ascenders
  // and descenders collide with the tight rows above and below
  const italic = raw.length <= 2 && r() < 0.45;
  const L = raw.length >= 3 ? capAcak(text, o, 'bootzy') : capSauceMix(text, Object.assign({}, o, { quote: true, quoteItal: italic }));
  if (o.glow) L.elements.forEach((e) => { e.glow = '#ffffff'; });
  return L;
}
// [CAP-ESTETIK] Podcast-clip look, calibrated frame by frame on the user's
// reference (2026-10-14, 30 fps, 15 fps zoom sheets):
//   • three rows, left-aligned block: small lead-in words on top, ONE big key
//     word, small tail words below; small = 0.42x big, rows nearly touching;
//   • lead-in row flush RIGHT with the big word ("berapa / Lama"); a one-word
//     tail flush right ("tuh ?"), a longer tail flush left ("lama mereka");
//   • Poppins Bold, pure white, key word thickened with a same-colour stroke,
//     Title Case (short words) or CAPS, tracking -2 %;
//   • readability from a soft DARK halo behind every word, not a coloured glow;
//   • each small word focuses in as it is spoken: blur 10 -> 0, rises 12 px,
//     fades in over ~230 ms (4 frames); the big word blurs in harder
//     (blur 24 -> 0) rising 40 px with a 104 % -> 100 % settle over ~330 ms.
// Key word for the Estetik stack: a content word (thing / quality), never a
// question word or helper, and verbs with an affix count less — the
// reference picks "berapa LAMA", "menentukan HOOK", "bisa dapetin SENSE".
const EST_AUX = new Set('berapa bagaimana gimana apa apakah kenapa mengapa siapa kapan dimana mana bisa harus mau akan sudah udah sampe sampai menurut kalian kamu aku gue gua lu dia mereka kita kami seorang sebuah yang dan atau tapi tuh sih nih dong deh kok loh lho ya yah oh wow eh ah oke nya itu ini juga lagi aja banget sangat lebih paling how what why who when where can will would should the a an to of and is are was'.split(' '));
function estKeyIndex(words) {
  let best = -1, bs = -1;
  words.forEach((w, i) => {
    const c = w.toLowerCase().replace(/[^a-z0-9À-ɏ]/g, '');
    let sc = c.length;
    if (!c || EST_AUX.has(c) || CAP_STOP.has(c)) sc = 0.5;
    else if (/^(me|mem|men|meng|meny|ber|di|nge|ng)[a-z]{3,}/.test(c) || /[a-z]{3,}(kan|in)$/.test(c)) sc *= 0.4;
    if (sc >= bs) { bs = sc; best = i; }
  });
  return best < 0 ? words.length - 1 : best;
}
function capEstetik(text, o) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const r = rng(`estetik|${text}`);
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);
  const FONT = 'Poppins Bold';
  const TRACK = -0.02;
  let big = (o.px || 150) * (o.k || 1);
  const key = raw[ki].replace(/^["'“(]+|[,.;:"'”)]+$/g, '');
  const bigText = key.length <= 7 && r() < 0.45 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  const maxW = 900;
  const wBig = () => widthPx(bigText, FONT, big) * (1 + TRACK);
  const big0 = big;
  if (wBig() > maxW) big *= maxW / wBig();
  // a long key word shrinks to fit, but the small rows must stay readable
  const small = Math.max(big * 0.42, big0 * 0.36);
  const lead = raw.slice(0, ki).map((w) => w.toLowerCase());
  const tail = raw.slice(ki + 1).map((w) => w.toLowerCase());
  const rowW = (ws) => (ws.length ? widthPx(ws.join(' '), FONT, small) : 0);
  const Wb = wBig(), Wt = rowW(lead), Wl = rowW(tail);
  const W = Math.max(Wb, Wt, Wl);
  const left = o.align === 'left' ? 60 : Math.max(40, Math.min(1080 - 40 - W, o.cx - W / 2));
  const els = [];
  const word = (w, px, x, y, t, isBig) => {
    const el = { kind: 'text', text: w, font: FONT, px, fsp: TRACK * px, color: '#ffffff',
      oc: '#ffffff', ow: isBig ? 0.022 * px : 0, sd: 0, shade: true, x, y, rot: 0 };
    el.keys = isBig
      ? [{ t: 0, a: 0, blur: 24, y: y + 40, sx: 104, sy: 104 }, { t, a: 0, blur: 24, y: y + 40, sx: 104, sy: 104 }, { t: t + 330, a: 1, blur: 0, y, sx: 100, sy: 100 }]
      : [{ t: 0, a: 0, blur: 10, y: y + 12 }, { t, a: 0, blur: 10, y: y + 12 }, { t: t + 230, a: 1, blur: 0, y }];
    return el;
  };
  const row = (ws, idx0, x0, y) => {
    const sp = widthPx(' ', FONT, small);
    let x = x0;
    ws.forEach((w, j) => {
      const ww = widthPx(w, FONT, small);
      els.push(word(w, small, x + ww / 2, y, times[idx0 + j], false));
      x += ww + sp;
    });
  };
  let y = o.top;
  if (lead.length) {
    const cy = y + small * 0.5;
    row(lead, 0, Wt <= Wb ? left + Wb - Wt : left, cy);
    y += small * 0.88;
  }
  const by = y + big * 0.46;
  els.push(word(bigText, big, left + Wb / 2, by, times[ki], true));
  y += big * 0.86;
  if (tail.length) {
    const cy = y + small * 0.5;
    row(tail, ki + 1, tail.length === 1 && Wl <= Wb ? left + Wb - Wl : left, cy);
    y += small * 1.0;
  }
  return { elements: els, box: { top: o.top, bottom: y } };
}
// [CAP-STACK] Stacked lyric captions, calibrated 1:1 on the user's
// references ("never / complain", "and what it / means"): all lowercase,
// pure white, the key word big on its own row, the words before it in one
// small row above (0.55x) and the words after it in one row below; rows
// almost touching, word gaps 80 % of a space, tracking -2 %. Never random:
// the stack is centred, or left-aligned with o.align === 'left'.
// Big word always bold: Open Sauce ExtraBold at 92 % width, or Bootzy
// thickened with a same-colour stroke.
function capAcak(text, o, mode) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const bootzy = mode === 'bootzy';
  const words = raw.map((w) => w.toLowerCase());
  const ki = keyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);
  let px = (o.px || 150) * (o.k || 1);
  const FONT = bootzy ? 'Bootzy TM' : 'Open Sauce Two ExtraBold';
  const SXB = bootzy ? 100 : 92, SXS = bootzy ? 100 : 96;
  const BOLDEN = 0;
  const TRACK = bootzy ? 0.03 : -0.02;
  const SMALL = 0.55;
  const left = o.align === 'left';
  const rows = [];
  if (ki > 0) rows.push({ big: false, idx: raw.slice(0, ki).map((_, i) => i) });
  rows.push({ big: true, idx: [ki] });
  if (ki < raw.length - 1) rows.push({ big: false, idx: raw.slice(ki + 1).map((_, i) => ki + 1 + i) });
  const sx = (row) => (row.big ? SXB : SXS);
  const stroke = (row, size) => (row.big ? BOLDEN * size : 0);
  const wordW = (i, row, size) => (widthPx(words[i], FONT, size) + TRACK * size * words[i].length) * sx(row) / 100 + 2 * stroke(row, size);
  const gap = (row, size) => widthPx(' ', FONT, size) * 0.8 * sx(row) / 100;
  const sizeOf = (row) => px * (row.big ? 1 : SMALL);
  const rowW = (row) => row.idx.reduce((a, i) => a + wordW(i, row, sizeOf(row)), 0) + gap(row, sizeOf(row)) * (row.idx.length - 1);
  let widest = Math.max(...rows.map(rowW));
  if (widest > 900) { px *= 900 / widest; widest = 900; }
  const xh = 0.74;                           // lowercase body + ascender share of the size
  const els = [];
  let y = o.top, prevH = 0;
  const blockL = o.cx - widest / 2;
  rows.forEach((row, ri) => {
    const size = sizeOf(row), h = size * xh;
    y += ri === 0 ? h / 2 : prevH / 2 + h / 2 + Math.min(prevH, h) * 0.06;
    prevH = h;
    const W = rowW(row);
    let x = left ? blockL : o.cx - W / 2;
    const M = 50;
    if (x < M) x = M; if (x + W > 1080 - M) x = 1080 - M - W;
    row.idx.forEach((i) => {
      const w = wordW(i, row, size);
      const t = times[i];
      const s0 = sx(row);
      const el = { kind: 'text', text: words[i], font: FONT, px: size, fsp: TRACK * size, color: '#FFFFFF',
        oc: '#FFFFFF', ow: stroke(row, size), sc: '#000000', sd: 2, x: x + w / 2, y, rot: 0 };
      el.keys = row.big
        ? [{ t: 0, a: 0, sx: s0 * 1.12, sy: 112 }, { t, a: 0, sx: s0 * 1.12, sy: 112 }, { t: t + 1, a: 1 },
          { t: t + 140, sx: s0 * 0.97, sy: 97 }, { t: t + 260, sx: s0, sy: 100 }]
        : [{ t: 0, a: 0, blur: 8, y: y + 12, sx: s0, sy: 100 }, { t, a: 0, blur: 8, y: y + 12 }, { t: t + 220, a: 1, blur: 0, y }];
      els.push(el);
      x += w + gap(row, size);
    });
  });
  return { elements: els, box: { top: o.top, bottom: y + prevH / 2 } };
}
// [SAUCE-MIX] Mixed cue lengths (1–3 words) for the Sauce campur look: a long
// content word stands alone ("dream"), connectors gather up to three
// ("enter my"), a spoken pause or punctuation always ends a cue. Shared by
// the pipeline (chunkWordsToCues) and the preview (ensureCueWords).
// [CAP-ESTETIK] Reference groups run 2–5 words around ONE key word ("berapa
// LAMA tuh?", "menurut kalian BERAPA lama mereka"): break only on a real
// pause or a sentence end, never on a heavy word, and fold a lone word into
// its neighbour when they are spoken together.
function estChunks(ws, max = 5) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  ws.forEach((w, i) => {
    const gap = i > 0 ? (+w.start) - (+ws[i - 1].end) : 0;
    if (cur.length && gap > 0.45) flush();
    cur.push(w);
    if (/[.!?]["'”)]*$/.test(String(w.text || '')) || cur.length >= max) flush();
  });
  flush();
  for (let i = 0; i < out.length; i++) {
    if (out[i].length !== 1) continue;
    const prev = out[i - 1], next = out[i + 1];
    const gp = prev ? (+out[i][0].start) - (+prev[prev.length - 1].end) : Infinity;
    const gn = next ? (+next[0].start) - (+out[i][0].end) : Infinity;
    const endsSentence = (g) => /[.!?]["'”)]*$/.test(String(g[g.length - 1].text || ''));
    if (prev && gp <= 0.6 && prev.length < max && !endsSentence(prev) && (gp <= gn || !next)) { prev.push(out[i][0]); out.splice(i--, 1); }
    else if (next && gn <= 0.6 && next.length < max && !endsSentence(out[i])) { next.unshift(out[i][0]); out.splice(i--, 1); }
  }
  return out;
}
function mixChunks(ws, max = 3) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  ws.forEach((w, i) => {
    const plain = String(w.text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const heavy = plain.length >= 5 && !CAP_STOP.has(plain);
    const gap = i > 0 ? (+w.start) - (+ws[i - 1].end) : 0;
    // max 4 (Quote/Sorot): a heavy word ENDS its cue ("and what it means") instead of standing alone
    if (cur.length && (gap > 0.35 || (heavy && max <= 3))) flush();
    cur.push(w);
    if (heavy || /[.!?,;:]$/.test(String(w.text || '')) || cur.length >= max) flush();
  });
  flush();
  return out;
}
// [CHUNK-RULE] Per-preset words-per-cue range, read from the preset file's header line  // Chunk: 1-3  (or  // Chunk: 2).
// Cues are cut at pauses (> 0.35 s) and sentence punctuation, never below `min` words, never above `max`;
// a heavy word (5+ letters, not a stop word) ends the cue once `min` is reached. min == max gives fixed-size cues.
const CHUNK_RULES = {};
function chunkRule(id) { return CHUNK_RULES[id] || null; }
function rangeChunks(ws, min = 1, max = 3) {
  min = Math.max(1, min | 0); max = Math.max(min, max | 0);
  const out = []; let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  ws.forEach((w, i) => {
    const plain = String(w.text || '').toLowerCase().replace(/[^p{L}p{N}]/gu, '');
    const heavy = plain.length >= 5 && !CAP_STOP.has(plain);
    const gap = i > 0 ? (+w.start) - (+ws[i - 1].end) : 0;
    if (cur.length >= min && gap > 0.35) flush();
    cur.push(w);
    if (cur.length >= max || (cur.length >= min && (heavy || /[.!?,;:]$/.test(String(w.text || ''))))) flush();
  });
  flush();
  // a lone tail shorter than min joins the previous cue when that still fits
  if (out.length > 1 && out[out.length - 1].length < min && out[out.length - 2].length + out[out.length - 1].length <= max) { const l = out.pop(); out[out.length - 1].push(...l); }
  return out;
}
// [SAUCE-MIX] One face family: Open Sauce ExtraBold squeezed to 90 %,
// lowercase, tight; the key word sometimes in its own ExtraBold Italic
// (more often when it stands alone), words focusing in from a blur, the cue
// placed a little differently each time.
function capSauceMix(text, o) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  const r = rng(`mix|${text}`);
  const words = raw.map((w) => w.toLowerCase());
  const ki = keyIndex(raw);
  const italic = o.quote ? !!o.quoteItal : r() < (raw.length === 1 ? 0.6 : 0.4);
  const times = wordTimes(raw, o.dur || 1500);
  const FONT = o.quote ? 'Bootzy TM' : 'Open Sauce Two ExtraBold', ITAL = 'Open Sauce Two ExtraBold Italic';
  const SX = o.quote ? 100 : 90, TRACK = o.quote ? 0.03 : -0.02;
  let px = (o.px || 140) * (o.k || 1) * (raw.length === 1 ? 1.12 : 1);
  const fontOf = (i) => (italic && i === ki ? ITAL : FONT);
  const trk = (i) => (fontOf(i) === ITAL ? -0.02 : TRACK);
  const wordW = (i, size) => (widthPx(words[i], fontOf(i), size) + trk(i) * size * words[i].length) * SX / 100;
  const gap = (size) => widthPx(' ', FONT, size) * 0.72 * SX / 100;
  const lineW = (idx, size) => idx.reduce((a, i) => a + wordW(i, size), 0) + gap(size) * (idx.length - 1);
  let lines = [raw.map((_, i) => i)];
  if (lineW(lines[0], px) > 880 && raw.length > 1) {
    const cut = Math.ceil(raw.length / 2);
    lines = [lines[0].slice(0, cut), lines[0].slice(cut)];
  }
  const widest = Math.max(...lines.map((l) => lineW(l, px)));
  if (widest > 880) px *= 880 / widest;
  const dx = 0, dy = 0;   // [CAP-STACK] never random — centred or left
  const lh = px * 0.98;
  const els = [];
  lines.forEach((idx, li) => {
    const y = o.top + dy + lh * li + lh / 2;
    const W = lineW(idx, px);
    let x = o.align === 'left' ? o.cx - widest / 2 : o.cx + dx - W / 2;
    const M = 50;
    if (x < M) x = M; if (x + W > 1080 - M) x = 1080 - M - W;
    idx.forEach((i) => {
      const w = wordW(i, px);
      const t = times[i];
      els.push({ kind: 'text', text: words[i], font: fontOf(i), px, fsp: trk(i) * px, color: '#FFFFFF', oc: '#000000', ow: 0, sc: '#000000', sd: 2, x: x + w / 2, y, rot: 0,
        keys: [{ t: 0, a: 0, blur: 10, sx: SX * 1.04, sy: 104 }, { t, a: 0, blur: 10, sx: SX * 1.04, sy: 104 }, { t: t + 240, a: 1, blur: 0, sx: SX, sy: 100 }] });
      x += w + gap(px);
    });
  });
  return { elements: els, box: { top: o.top + dy, bottom: o.top + dy + lh * lines.length } };
}
// [CAP-TUMPUK2] Stacked editorial look (Helvetica Neue): small Roman lead-in words, one big Bold key word.
//   key first  -> key on the top row, the rest small underneath
//   key later  -> lead-in words small on top, key (+ tail) underneath
//   1–2 words  -> one row, only the key word is big
// Words slide in with a motion blur (direction varies per phrase, seeded by the text).
function capTumpuk2(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = rng(`tumpuk2|${text}`);
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_BOLD = 'Helvetica Neue Bold';
  const FONT_REG = 'Helvetica Neue Roman';
  const TRACK = -0.045;
  const MAXW = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  let bigPx = Math.round(basePx * 1.28);
  let smallPx = Math.max(Math.round(basePx * 0.50), 32);

  const topRow = [], botRow = [];
  if (raw.length <= 2) {
    raw.forEach((word, idx) => topRow.push({ word, idx, big: raw.length === 1 || idx === ki }));
  } else if (ki === 0) {
    topRow.push({ word: raw[0], idx: 0, big: true });
    for (let i = 1; i < raw.length; i++) botRow.push({ word: raw[i], idx: i, big: false });
  } else {
    for (let i = 0; i < ki; i++) topRow.push({ word: raw[i], idx: i, big: false });
    for (let i = ki; i < raw.length; i++) botRow.push({ word: raw[i], idx: i, big: i === ki });
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => (it.big ? FONT_BOLD : FONT_REG);
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const spOf = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.85;
  const rowW = (row) => row.reduce((a, it, j) => a + wOf(it) + (j ? spOf(it) : 0), 0);

  const k = Math.min(1, MAXW / Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0, 1));
  bigPx *= k;
  smallPx *= k;

  // Slightly negative line gap (about CapCut's line spacing -1): the lower row tucks against the upper one.
  const gap = Math.round(-basePx * 0.07 * k);

  const blockW = Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0);
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, o.cx - blockW / 2));

  const bigMode = Math.floor(r() * 3);   // 0: slide up, 1: right -> left, 2: left -> right
  const smallMode = Math.floor(r() * 2); // 0: right -> left, 1: slide up

  const word = (w, font, px, x, y, t, isBig) => {
    const el = { kind: 'text', text: w, font, px, fsp: TRACK * px, color: '#ffffff', oc: '#ffffff', ow: 0, sd: 0, shade: false, x, y, rot: 0 };
    let startX = x, startY = y;
    const blur0 = isBig ? 16 : 8;
    const dur = isBig ? 190 : 150;
    if (isBig) {
      if (bigMode === 0) startY = y + 36;
      else if (bigMode === 1) startX = x + 65;
      else startX = x - 65;
    } else if (smallMode === 0) startX = x + 35;
    else startY = y + 18;
    el.keys = [
      { t: 0, a: 0, blur: blur0, x: startX, y: startY, sx: 100, sy: 100 },
      { t, a: 0, blur: blur0, x: startX, y: startY, sx: 100, sy: 100 },
      { t: t + dur, a: 1, blur: 0, x, y, sx: 100, sy: 100 },
    ];
    return el;
  };

  const els = [];
  let y = o.top;
  const place = (row) => {
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    let x = blockStartX;
    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      els.push(word(it.word, fontOf(it), pxOf(it), x + ww / 2, cy + baselineOffset, times[it.idx], it.big));
      x += ww + spOf(it);
    });
    y += h + gap;
  };
  place(topRow);
  if (botRow.length) place(botRow);
  return { elements: els, box: { top: o.top, bottom: y - gap } };
}

// ---- preset: CleanBlurReveal.txt
// Nama Gaya Sosmed: Clean Minimalist Creator Captions / Subtle Blur-Reveal Subtitles
// Karakteristik: Kontras ekstrem Helvetica Neue Light (baris pengantar) vs Helvetica Neue Bold (baris inti), ukuran 1:1 seragam ringkas (~52px pada 1080x1920), 1-2 baris bertumpuk sangat rapat (tight leading & tracking -0.055), muncul word-by-word dengan Blur Fade-In Up (Rebound Out) & Hazy Slide Left/Right (Circular Ease).
// Font Wajib: Helvetica Neue Bold, Helvetica Neue Light
// Mode Blend: NORMAL (putih solid #FFFFFF dengan soft drop shadow halus, tanpa outline/bar)
// Chunk: 1-4

function capCleanBlurReveal(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`cleanblur|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_HEAVY = 'Helvetica Neue Bold';
  const FONT_LIGHT = 'Helvetica Neue Light';
  const TRACK = -0.055;
  const MAXW = 760;

  // Ukuran 1:1 presisi sesuai referensi gambar (~52px pada basePx 105)
  const basePx = (o.px || 105) * (o.k || 1);
  let wordPx = Math.max(Math.round(basePx * 0.50), 40);

  const topRow = [];
  const botRow = [];

  if (raw.length === 1) {
    topRow.push({ word: raw[0], idx: 0, isHeavy: true });
  } else if (raw.length === 2) {
    const bothHeavy = ki === 0;
    raw.forEach((word, idx) => {
      topRow.push({ word, idx, isHeavy: bothHeavy || idx === ki });
    });
  } else if (raw.length === 3) {
    const splitAt = ki <= 1 ? 1 : 2;
    for (let i = 0; i < splitAt; i++) {
      topRow.push({ word: raw[i], idx: i, isHeavy: false });
    }
    for (let i = splitAt; i < raw.length; i++) {
      botRow.push({ word: raw[i], idx: i, isHeavy: true });
    }
  } else {
    const splitAt = Math.min(Math.max(ki, 2), raw.length - 1);
    for (let i = 0; i < splitAt; i++) {
      topRow.push({ word: raw[i], idx: i, isHeavy: false });
    }
    for (let i = splitAt; i < raw.length; i++) {
      botRow.push({ word: raw[i], idx: i, isHeavy: true });
    }
  }

  const fontOf = (it) => (it.isHeavy ? FONT_HEAVY : FONT_LIGHT);
  const wOf = (it) => widthPx(it.word, fontOf(it), wordPx) * (1 + TRACK);
  const spaceW = (it) => widthPx(' ', fontOf(it), wordPx) * 0.82;
  const rowW = (row) =>
    row.reduce((acc, it, j) => acc + wOf(it) + (j > 0 ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0, 1);
  const fitScale = Math.min(1, MAXW / maxRowWidth);
  wordPx = Math.round(wordPx * fitScale);

  const lineGap = Math.round(-wordPx * 0.14);
  const blockW = Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0);
  const cx = o.cx || 540;
  const blockStartX = Math.max(60, Math.min(1080 - 60 - blockW, cx - blockW / 2));

  const phraseMode = Math.floor(r() * 3);

  const buildWordElement = (it, x, y, t) => {
    const isHeavy = it.isHeavy;
    const font = fontOf(it);

    let startX = x;
    let startY = y;
    let startBlur = isHeavy ? 13 : 9;
    let startScale = 100;
    const animDur = isHeavy ? 165 : 140;

    const mode = r() < 0.72 ? phraseMode : Math.floor(r() * 3);

    if (mode === 0) {
      startY = y + Math.round(wordPx * 0.36);
      startBlur = isHeavy ? 14 : 10;
    } else if (mode === 1) {
      startX = x - Math.round(wordPx * 0.45);
      startBlur = isHeavy ? 15 : 11;
      startScale = 106;
    } else {
      startX = x + Math.round(wordPx * 0.45);
      startBlur = isHeavy ? 15 : 11;
      startScale = 106;
    }

    const midT = t + Math.round(animDur * 0.56);
    const midX = x + (startX - x) * 0.15;
    const midY = y + (startY - y) * 0.14;
    const midBlur = Math.round(startBlur * 0.2);
    const midScale = 100 + (startScale - 100) * 0.14;

    return {
      kind: 'text',
      text: it.word,
      font,
      px: wordPx,
      fsp: TRACK * wordPx,
      color: isHeavy ? '#FFFFFF' : '#E6E6E6',
      oc: '#000000',
      ow: 0,
      sd: 10,
      shade: true,
      x,
      y,
      rot: 0,
      keys: [
        { t: 0, a: 0, blur: startBlur, x: startX, y: startY, sx: startScale, sy: startScale },
        { t, a: 0, blur: startBlur, x: startX, y: startY, sx: startScale, sy: startScale },
        { t: midT, a: 0.9, blur: midBlur, x: midX, y: midY, sx: midScale, sy: midScale },
        { t: t + animDur, a: 1, blur: 0, x, y, sx: 100, sy: 100 }
      ]
    };
  };

  const els = [];
  let y = o.top ?? 1160;

  const placeRow = (row) => {
    const currentRowW = rowW(row);
    let cursorX = blockStartX + (blockW - currentRowW) / 2;
    const cy = y + wordPx / 2;

    row.forEach((it) => {
      const ww = wOf(it);
      els.push(buildWordElement(it, cursorX + ww / 2, cy, times[it.idx]));
      cursorX += ww + spaceW(it);
    });

    y += wordPx + lineGap;
  };

  placeRow(topRow);
  if (botRow.length) {
    placeRow(botRow);
  }

  return {
    elements: els,
    box: {
      top: o.top ?? 1160,
      bottom: y - lineGap
    }
  };
}
// ---- preset: CleanEditorial.txt
// Nama Gaya Sosmed: Clean Editorial Stacked & Inline Highlight Captions (Devin Jatho Style)
// Karakteristik: Menggunakan 3 tingkat ketebalan tipografi (Regular untuk kata pembuka atas, Bold untuk kata kunci besar, Medium untuk kata lanjutan bawah). Kata kunci besar memakai gradien vertikal oranye-kuning (#FF5500 -> #FFB800) + soft glow, sedangkan mode 1 baris inline memakai kuning neon (#F5E614). Animasi masuk halus Blur Fade-In Up/Down/Hazy dari JSON.
// Font Wajib: 'Helvetica Neue Bold', 'Helvetica Neue Medium', 'Helvetica Neue Regular'
// Mode Blend: NORMAL
// Chunk: 2-5

function capCleanEditorial(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`clean_editorial_v3|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 3 Tingkat Ketebalan Font sesuai audit visual referensi
  const FONT_BOLD = 'Helvetica Neue Bold';    // Tingkat 1: Kata Kunci Utama (Keyword)
  const FONT_MED  = 'Helvetica Neue Medium';  // Tingkat 2: Kata Lanjutan / Penutup Bawah ("editing style")
  const FONT_REG  = 'Helvetica Neue Regular'; // Tingkat 3: Kata Pembuka Atas ("This is the") & Inline Pendukung

  const TRACK   = -0.045; // Kerapatan huruf rapat khas Helvetica Neue editorial
  const SPACE_K = 0.68;   // Jarak antar kata rapat
  const MAXW    = 860;

  const basePx = (o.px || 105) * (o.k || 1);

  // Menentukan 3 variasi struktur layout:
  // 0 = 3 Baris Asimetris (pre: Regular di atas-kiri, keyword: Bold besar di tengah, post: Medium di bawah-kanan)
  // 1 = 2 Baris Bertumpuk (pendukung: Regular di atas, keyword: Bold besar di bawah)
  // 2 = 1 Baris Inline (pendukung: Regular, keyword: Bold kuning neon #F5E614, ukuran sama besar)
  let layoutMode = 2;
  if (raw.length >= 4 && ki > 0 && ki < raw.length - 1) {
    layoutMode = r() > 0.22 ? 0 : 2;
  } else if (raw.length >= 2) {
    layoutMode = r() > 0.42 ? 1 : 2;
  }

  const isInline = layoutMode === 2;

  // Rasio ukuran: Stacked (Keyword ~2.25x lebih besar dari pendukung) vs Inline (1:1 sama besar)
  let bigPx   = isInline ? Math.round(basePx * 0.72) : Math.round(basePx * 1.48);
  let smallPx = isInline ? bigPx : Math.max(Math.round(basePx * 0.65), 34);

  // Rentang kata kunci (1 kata atau 2 kata berdekatan seperti "this effects")
  const keySet = new Set([ki]);
  if (ki + 1 < raw.length && raw[ki + 1].length >= 4 && r() > 0.45) {
    keySet.add(ki + 1);
  }

  // Tier ketebalan: 'bold' (Keyword), 'medium' (Post/Bawah), 'regular' (Pre/Atas & Inline)
  const rows = [];
  if (layoutMode === 2) {
    // Pola C: 1 Baris Inline ("to make this effects" / "so you can do it yourself")
    rows.push({
      align: 'center',
      items: raw.map((word, idx) => ({
        word,
        idx,
        big: keySet.has(idx),
        tier: keySet.has(idx) ? 'bold' : 'regular'
      }))
    });
  } else if (layoutMode === 0) {
    // Pola A: 3 Baris Asimetris ("This is the" [Regular] -> "cleanest" [Bold] -> "editing style" [Medium])
    const firstKey = Math.min(...keySet);
    const lastKey  = Math.max(...keySet);
    const pre  = raw.slice(0, firstKey).map((word, i) => ({ word, idx: i, big: false, tier: 'regular' }));
    const mid  = raw.slice(firstKey, lastKey + 1).map((word, i) => ({ word, idx: firstKey + i, big: true, tier: 'bold' }));
    const post = raw.slice(lastKey + 1).map((word, i) => ({ word, idx: lastKey + 1 + i, big: false, tier: 'medium' }));

    if (pre.length)  rows.push({ align: 'left',   items: pre });
    rows.push({ align: 'center', items: mid });
    if (post.length) rows.push({ align: 'right',  items: post });
  } else {
    // Pola B: 2 Baris Bertumpuk
    const firstKey = Math.min(...keySet);
    if (firstKey === 0) {
      rows.push({ align: 'center', items: [{ word: raw[0], idx: 0, big: true, tier: 'bold' }] });
      rows.push({ align: 'right',  items: raw.slice(1).map((word, i) => ({ word, idx: i + 1, big: false, tier: 'medium' })) });
    } else {
      rows.push({ align: r() > 0.5 ? 'left' : 'center', items: raw.slice(0, firstKey).map((word, i) => ({ word, idx: i, big: false, tier: 'regular' })) });
      rows.push({ align: 'center', items: raw.slice(firstKey).map((word, i) => ({ word, idx: firstKey + i, big: true, tier: 'bold' })) });
    }
  }

  const pxOf   = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => {
    if (it.tier === 'bold') return FONT_BOLD;
    if (it.tier === 'medium') return FONT_MED;
    return FONT_REG;
  };
  const wOf     = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const spaceOf = (it) => widthPx(' ', fontOf(it), pxOf(it)) * SPACE_K;
  const rowW    = (items) => items.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceOf(it) : 0), 0);

  // Auto-fit terhadap batas lebar kanvas MAXW = 860
  const maxRowWidth = Math.max(...rows.map((rw) => rowW(rw.items)), 1);
  const scaleFit = Math.min(1, MAXW / maxRowWidth);
  bigPx   *= scaleFit;
  smallPx *= scaleFit;

  const blockW = Math.max(...rows.map((rw) => rowW(rw.items)));
  const cx = o.cx || 540;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  // Jarak antar baris rapat (tight leading) seperti pada gambar referensi
  const gap = isInline ? 0 : Math.round(-basePx * 0.14 * scaleFit);

  // Warna & Gradien sesuai mode
  const useMagenta   = !isInline && r() > 0.78;
  const keyColor     = isInline ? '#F5E614' : (useMagenta ? '#E82CFF' : '#FF7A00');
  const keyGradStart = isInline ? null : (useMagenta ? '#FF4DF0' : '#FF5500');
  const keyGradEnd   = isInline ? null : (useMagenta ? '#C814E8' : '#FFB800');
  const glowColor    = isInline ? 'rgba(245, 230, 20, 0.35)' : (useMagenta ? 'rgba(232, 44, 255, 0.55)' : 'rgba(255, 107, 0, 0.50)');

  // Parameter animasi masuk dari ekstraksi JSON (1_Blur_Up, 1_Basic_Down, 3_Right_Hazy, 3_Left_Hazy)
  const bigMotionMode   = Math.floor(r() * 2); // 0: 1_Blur_Up (+121px), 1: 1_Basic_Down (-116px)
  const smallMotionMode = Math.floor(r() * 4); // 0: Up, 1: Down, 2: Right Hazy, 3: Left Hazy

  const createWordEl = (it, x, y, t) => {
    const px    = pxOf(it);
    const isKey = it.big;
    const mode  = isKey ? bigMotionMode : smallMotionMode;

    let startX     = x;
    let startY     = y;
    let blur0      = isKey ? 18 : 10;
    let animDur    = isKey ? 320 : 250;
    let startScale = 100;

    if (mode === 0) {
      startY = y + (isKey ? 121 : 52) * scaleFit;
    } else if (mode === 1) {
      startY = y - (isKey ? 116 : 48) * scaleFit;
    } else if (mode === 2) {
      startX = x + 68 * scaleFit;
      startScale = 105;
    } else {
      startX = x - 68 * scaleFit;
      startScale = 105;
    }

    const el = {
      kind: 'text',
      text: it.word,
      font: fontOf(it),
      px,
      fsp: TRACK * px,
      color: isKey ? keyColor : '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: isKey ? 12 : 5,
      shadowColor: isKey ? glowColor : 'rgba(0, 0, 0, 0.45)',
      shade: false,
      x,
      y,
      rot: 0,
      keys: [
        { t: 0,           a: 0, blur: blur0, x: startX, y: startY, sx: startScale, sy: startScale },
        { t,              a: 0, blur: blur0, x: startX, y: startY, sx: startScale, sy: startScale },
        { t: t + animDur, a: 1, blur: 0,     x: x,      y: y,      sx: 100,        sy: 100 }
      ]
    };

    if (isKey && !isInline && keyGradStart && keyGradEnd) {
      el.gradient = {
        type: 'linear',
        angle: 180,
        stops: [
          { offset: 0, color: keyGradStart },
          { offset: 1, color: keyGradEnd }
        ]
      };
    }

    return el;
  };

  const els = [];
  let y = o.top || 820;

  rows.forEach((rw) => {
    const rwWidth = rowW(rw.items);
    const h = Math.max(...rw.items.map(pxOf));
    const cy = y + h / 2;

    let curX = blockStartX;
    if (rw.align === 'center') {
      curX = blockStartX + (blockW - rwWidth) / 2;
    } else if (rw.align === 'right') {
      curX = blockStartX + (blockW - rwWidth);
    }

    rw.items.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      els.push(createWordEl(it, curX + ww / 2, cy + baselineOffset, times[it.idx]));
      curX += ww + spaceOf(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: o.top || 820, bottom: y - gap } };
}
// ---- preset: EditorialContrast.txt
// Nama Gaya Sosmed: Editorial Contrast / Stacked Podcast Kinetic Captions (80$ Edit)
// Karakteristik: 5 pola kemunculan dinamis (Staggered Blur-Up, Typewriter Reveal, Stepped Diagonal Cascade, Pocket-Nested Anchor, dan Horizontal Pop), kombinasi ketebalan font presisi (Helvetica Neue Bold, Helvetica Neue Light, Playfair Display Regular & Italic), efek cahaya soft glow, serta selective Subtract (difference) pada pola 1, 3, dan 4
// Font Wajib: 'Helvetica Neue Bold', 'Helvetica Neue Light', 'Playfair Display Regular', 'Playfair Display Italic'
// Mode Blend: HYBRID (Selective SUBTRACT / mix-blend-mode: difference pada pola 1, 3, 4 & NORMAL dengan Soft Glow pada kata lainnya)
// Chunk: 2-5

function capEditorialContrast(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`ed80_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // Font & ketebalan yang dikalibrasi ulang agar identik dengan video referensi
  const FONT_BOLD     = 'Helvetica Neue Bold';
  const FONT_LIGHT    = 'Helvetica Neue Light';
  const FONT_SERIF    = 'Playfair Display Regular';
  const FONT_SERIF_IT = 'Playfair Display Italic';
  const MAXW          = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  let bigPx    = Math.round(basePx * 1.62);
  let medPx    = Math.max(Math.round(basePx * 0.54), 34);
  let smallPx  = Math.max(Math.round(basePx * 0.39), 26);

  // 5 Pola Kemunculan sesuai analisis video referensi:
  // Pattern 0 (Pola 1): Staggered Blur-Up & Left-Hazy Pocket Stack ("and there are TWO parts to that") -> Subtract di keyword
  // Pattern 1 (Pola 2): Per-Character / Snappy Typewriter Accent ("the only TRUE test" / "Wanting / first place") -> Normal + Glow
  // Pattern 2 (Pola 3): Stepped Cascade / Tangga Turun Diagonal ("getting / what / YOU / want.") -> Subtract di kata tengah/fokus
  // Pattern 3 (Pola 4): Anchor Keyword + Sub-Phrase Pocket Lock-In ("and THE Second is" / "is that you GET what you...") -> Subtract di kata penghubung atas
  // Pattern 4 (Pola 5): Horizontal Pop / Clean 1-2 Line Slide-In ("knowing what to want in the") -> Normal + Glow
  let pattern = Math.floor(r() * 5);
  if (raw.length === 1) pattern = 1;
  else if (raw.length === 2) pattern = r() > 0.5 ? 4 : 1;

  // Penentuan indeks kata yang mendapat efek Subtract (difference) hanya pada Pola 1, 3, dan 4
  let subtractIdx = -1;
  if (pattern === 0) {
    subtractIdx = ki; // Pola 1: Keyword raksasa (seperti "two")
  } else if (pattern === 2 && raw.length >= 3) {
    subtractIdx = Math.min(raw.length - 1, Math.max(1, ki + 1)); // Pola 3: Kata fokus baris tengah (seperti "you")
  } else if (pattern === 3 && ki > 0) {
    subtractIdx = ki - 1; // Pola 4: Kata sandang tepat di atas keyword (seperti "the" di atas "Second")
  }

  // Klasifikasi peran & gaya setiap kata
  const items = raw.map((w, idx) => {
    const isBig = idx === ki;
    let role = 'microLight';

    if (isBig) {
      role = 'big';
    } else if (pattern === 0) {
      if (idx === 0) role = 'topBold';
      else if (idx === raw.length - 1 && raw.length >= 3) role = 'tailSerif';
      else role = 'microLight';
    } else if (pattern === 1) {
      if (idx < ki) role = 'topBold';
      else if (idx === raw.length - 1) role = 'tailSerif';
      else role = 'microLight';
    } else if (pattern === 2) {
      role = idx <= 1 ? 'topBold' : 'microLight';
    } else if (pattern === 3) {
      if (idx < ki) role = 'topBold';
      else if (raw.length >= 4 && idx >= raw.length - 2) role = 'topBold';
      else role = 'microLight';
    } else {
      role = idx === ki || idx === ki + 1 ? 'topBold' : 'microLight';
    }

    return {
      word: w,
      idx,
      role,
      useSubtract: idx === subtractIdx
    };
  });

  const fontOf = (it) => {
    if (it.role === 'big') return pattern === 3 && raw.length <= 4 ? FONT_SERIF : FONT_BOLD;
    if (it.role === 'tailSerif') return FONT_SERIF_IT;
    if (it.role === 'topBold') return FONT_BOLD;
    return FONT_LIGHT;
  };

  const pxOf = (it) => {
    if (it.role === 'big') return bigPx;
    if (it.role === 'tailSerif') return Math.round(medPx * 1.15);
    if (it.role === 'topBold') return medPx;
    return smallPx;
  };

  const trackOf = (it) => {
    if (it.role === 'big') return fontOf(it) === FONT_SERIF ? -0.028 : -0.062;
    if (it.role === 'tailSerif') return -0.015;
    if (it.role === 'topBold') return -0.048;
    return -0.032;
  };

  const formatText = (it) => {
    if (it.role === 'big' && fontOf(it) === FONT_SERIF) {
      return it.word.charAt(0).toUpperCase() + it.word.slice(1).toLowerCase();
    }
    return it.word.toLowerCase();
  };

  const wOf = (it) => widthPx(formatText(it), fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.65;

  // Pembentukan layout baris & pocket-nesting (kata mikro menyelip rapat di kiri/kanan atas atau kanan bawah keyword)
  // Tiap item pada `layoutNodes` menyimpan offset relatif (dx, dy) & skala
  const buildLayoutNodes = (scaleK) => {
    const bigIt = items[ki];
    const bigW = wOf(bigIt);
    const bigH = pxOf(bigIt);
    const nodes = [];

    if (pattern === 0 && items.length >= 4) {
      // Pola 1 Pocket Nesting ("and there" di kiri atas, "are" di kiri tengah dekat keyword, "TWO" besar, "parts to" di kanan atas keyword, "that" di kanan bawah)
      const preWords = items.slice(0, ki);
      const postWords = items.slice(ki + 1);
      const tailIt = postWords[postWords.length - 1];
      const rightPocket = postWords.slice(0, -1);

      let topX = 0;
      preWords.forEach((it, j) => {
        const ww = wOf(it);
        const isLastPre = j === preWords.length - 1 && preWords.length >= 2;
        if (isLastPre) {
          // Menyelip tepat di sebelah kiri huruf pertama keyword (seperti "are" di sebelah "two")
          nodes.push({ it, x: Math.max(0, topX - ww * 0.35), y: bigH * 0.56 });
        } else {
          nodes.push({ it, x: topX, y: 0 });
          topX += ww + spaceW(it);
        }
      });

      const keyX = Math.max(Math.round(62 * scaleK), topX * 0.55);
      const keyY = Math.round(medPx * 0.72);
      nodes.push({ it: bigIt, x: keyX, y: keyY });

      // Menyelip rapat di sisi kanan atas keyword (seperti "parts to" di kanan atas "two")
      let rpX = keyX + bigW + Math.round(10 * scaleK);
      rightPocket.forEach((it) => {
        const ww = wOf(it);
        nodes.push({ it, x: rpX, y: keyY + Math.round(bigH * 0.08) });
        rpX += ww + spaceW(it);
      });

      // Kata penutup Serif Italic di kanan bawah
      if (tailIt) {
        nodes.push({
          it: tailIt,
          x: keyX + bigW * 0.72,
          y: keyY + bigH * 0.86
        });
      }
    } else if (pattern === 2) {
      // Pola 3 Stepped Diagonal Cascade ("getting / what / you / want.")
      let curX = 0;
      let curY = 0;
      items.forEach((it, idx) => {
        const ww = wOf(it);
        const hh = pxOf(it);
        nodes.push({ it, x: curX, y: curY });
        curX += idx === 0 ? ww * 0.28 : ww * 0.62;
        curY += hh * 0.84;
      });
    } else if (pattern === 3 && items.length >= 3) {
      // Pola 4 Anchor Keyword + Sub-Phrase Pocket Lock-In ("is that you GET what you want out of life" / "and THE Second is")
      const preWords = items.slice(0, ki);
      const postWords = items.slice(ki + 1);

      let topX = 0;
      preWords.forEach((it) => {
        const ww = wOf(it);
        nodes.push({ it, x: topX, y: 0 });
        topX += ww + spaceW(it);
      });

      const keyX = preWords.length ? Math.round(topX * 0.42) : 0;
      const keyY = preWords.length ? Math.round(medPx * 0.78) : 0;
      nodes.push({ it: bigIt, x: keyX, y: keyY });

      // 1-2 kata pertama setelah keyword menyelip rapat di kanan bawah kaki keyword (seperti "what you" / "is")
      const pocketCount = postWords.length >= 3 ? 2 : Math.min(1, postWords.length);
      let pkX = keyX + bigW + Math.round(12 * scaleK);
      const pkY = keyY + bigH - smallPx * 1.05;
      for (let i = 0; i < pocketCount; i++) {
        const it = postWords[i];
        nodes.push({ it, x: pkX, y: pkY });
        pkX += wOf(it) + spaceW(it);
      }

      // Sisa frasa turun rapat tepat di bawah garis dasar keyword (seperti "want out of life")
      if (postWords.length > pocketCount) {
        let botX = Math.max(0, keyX - Math.round(45 * scaleK));
        const botY = keyY + bigH * 0.92;
        for (let i = pocketCount; i < postWords.length; i++) {
          const it = postWords[i];
          nodes.push({ it, x: botX, y: botY });
          botX += wOf(it) + spaceW(it);
        }
      }
    } else if (pattern === 4) {
      // Pola 5 Horizontal Pop + Pocket Atas ("knowing / what to want / in the")
      const preWords = items.slice(0, ki);
      const mainWords = items.slice(ki, Math.min(items.length, ki + 3));
      const tailWords = items.slice(Math.min(items.length, ki + 3));

      let preX = 0;
      preWords.forEach((it) => {
        nodes.push({ it, x: preX, y: 0 });
        preX += wOf(it) + spaceW(it);
      });

      let mainX = preWords.length ? Math.round(preX * 0.55) : 0;
      const mainY = preWords.length ? Math.round(smallPx * 0.92) : 0;
      mainWords.forEach((it) => {
        nodes.push({ it, x: mainX, y: mainY });
        mainX += wOf(it) + spaceW(it);
      });

      let tailX = mainX + Math.round(8 * scaleK);
      tailWords.forEach((it) => {
        nodes.push({ it, x: tailX, y: Math.max(0, mainY - smallPx * 0.65) });
        tailX += wOf(it) + spaceW(it);
      });
    } else {
      // Pola 2 Classic Stacked ("the only / true / test")
      const preWords = items.slice(0, ki);
      const postWords = items.slice(ki + 1);

      let topX = 0;
      preWords.forEach((it) => {
        nodes.push({ it, x: topX, y: 0 });
        topX += wOf(it) + spaceW(it);
      });

      const keyX = preWords.length ? Math.round(topX * 0.52) : 0;
      const keyY = preWords.length ? Math.round(medPx * 0.78) : 0;
      nodes.push({ it: bigIt, x: keyX, y: keyY });

      let botX = keyX + bigW * 0.55;
      const botY = keyY + bigH * 0.88;
      postWords.forEach((it) => {
        nodes.push({ it, x: botX, y: botY });
        botX += wOf(it) + spaceW(it);
      });
    }

    return nodes;
  };

  // Hitung auto-fit MAXW = 860
  let draftNodes = buildLayoutNodes(1);
  const rawMaxX = Math.max(...draftNodes.map((n) => n.x + wOf(n.it)), 1);
  const k = Math.min(1, MAXW / rawMaxX);
  bigPx   *= k;
  medPx   *= k;
  smallPx *= k;

  const finalNodes = buildLayoutNodes(k);
  const blockW = Math.max(...finalNodes.map((n) => n.x + wOf(n.it)));
  const cx = o.cx !== undefined ? o.cx : 540;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));
  const topStart = o.top !== undefined ? o.top : 780;

  // Bangun keyframe dari 4 JSON: 1_Blur_Up, 1_Keyboard_Up, 2.Light_Zoom In, 3_Left_Hazy
  const buildWordElement = (node, t) => {
    const { it } = node;
    const font  = fontOf(it);
    const px    = pxOf(it);
    const trk   = trackOf(it);
    const label = formatText(it);
    const ww    = wOf(it);
    const x     = blockStartX + node.x + ww / 2;
    const y     = topStart + node.y + px / 2;
    const isBig = it.role === 'big';

    const el = {
      kind: 'text',
      text: label,
      font,
      px,
      fsp: trk * px,
      color: '#FFFFFF',
      oc: it.useSubtract ? '#000000' : '#FFFFFF',
      ow: 0,
      // Subtract wajib bersih (sd: 0, shade: false); Normal memakai soft white glow
      sd: it.useSubtract ? 0 : (isBig || it.role === 'tailSerif' ? 15 : 8),
      shade: !it.useSubtract,
      x,
      y,
      rot: 0
    };

    if (it.useSubtract) {
      el.blendMode = 'difference';
    }

    if (pattern === 1 || it.role === 'tailSerif') {
      // Pola 2 (1_Keyboard_Up.json): Snappy typewriter lift (+44px), tajam (blur: 0), durasi 240ms
      const dur = 240;
      const startY = y + Math.round(44 * k);
      el.keys = [
        { t: 0,       a: 0, blur: 0, x, y: startY, sx: 100, sy: 100 },
        { t,          a: 0, blur: 0, x, y: startY, sx: 100, sy: 100 },
        { t: t + dur, a: 1, blur: 0, x, y,         sx: 100, sy: 100 }
      ];
    } else if (isBig && pattern === 3) {
      // Pola 4 Keyword (2.Light_Zoom In.json): Scale 33% -> 100% (rasio 0.4044 / 1.22), Circular Ease
      const dur = 450;
      el.keys = [
        { t: 0,       a: 0, blur: 10, x, y, sx: 33,  sy: 33  },
        { t,          a: 0, blur: 10, x, y, sx: 33,  sy: 33  },
        { t: t + dur, a: 1, blur: 0,  x, y, sx: 100, sy: 100 }
      ];
    } else if (isBig || pattern === 2) {
      // Pola 1 & 3 (1_Blur_Up.json): Rebound Out naik (+92px) dengan Blur Fade-In (22 -> 0)
      const dur = 410;
      const startY = y + Math.round(92 * k);
      el.keys = [
        { t: 0,       a: 0, blur: 22, x, y: startY, sx: 100, sy: 100 },
        { t,          a: 0, blur: 22, x, y: startY, sx: 100, sy: 100 },
        { t: t + dur, a: 1, blur: 0,  x, y,         sx: 100, sy: 100 }
      ];
    } else {
      // Pola 1, 4 & 5 Pendukung (3_Left_Hazy.json): Slide kanan -> kiri (+135px), scale 142% -> 100%, blur 24 -> 0
      const dur = 420;
      const startX = x + Math.round(135 * k);
      el.keys = [
        { t: 0,       a: 0, blur: 24, x: startX, y, sx: 142, sy: 142 },
        { t,          a: 0, blur: 24, x: startX, y, sx: 142, sy: 142 },
        { t: t + dur, a: 1, blur: 0,  x,         y, sx: 100, sy: 100 }
      ];
    }

    return el;
  };

  const els = finalNodes.map((node) => buildWordElement(node, times[node.it.idx]));
  const yBottom = Math.max(...finalNodes.map((n) => topStart + n.y + pxOf(n.it)));

  return { elements: els, box: { top: topStart, bottom: yBottom } };
}
// ---- preset: EditorialEmphasis.txt
// Nama Gaya Sosmed: Dynamic Stacked Gradient Glow / Hormozi-Editorial Emphasis Captions
// Karakteristik: 5 pola dinamis (3 baris asimetris, 2 baris top-heavy, 1 baris split-weight, 2 baris anchor oranye, 2 baris anchor magenta) dengan Dual-Layer Warm Halation Glow (#FF9500 + #FF2A00) & jarak kata/baris super rapat
// Font Wajib: 'Helvetica Neue Heavy', 'Helvetica Neue Bold', 'Helvetica Neue Medium'
// Mode Blend: NORMAL
// Chunk: 2-5

function capStackedGlowEmphasis(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`stacked_glow_v4|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_HEAVY  = 'Helvetica Neue Heavy';
  const FONT_BOLD   = 'Helvetica Neue Bold';
  const FONT_MEDIUM = 'Helvetica Neue Medium';

  const TRACK_HERO = -0.048;
  const TRACK_SUB  = -0.032;
  const MAXW = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  const hasNumberOrSymbol = raw.some((w) => /[$%0-9]/.test(w));

  // 5 Pola Asli Video Referensi:
  // 0: Hero 3-Line Asymmetric Stack ("I left my" kiri / "$30,000" tengah / "business" kanan)
  // 1: Hero 2-Line Top-Heavy Stack ("because" besar atas / "I was tired" bawah)
  // 2: Single-Line Split-Weight ("10-12 hours" Medium putih + "a day" Bold kuning)
  // 3: 2-Line Anchor Stack Orange ("No" Medium atas / "weekends," atau "family" Bold bawah)
  // 4: 2-Line Multi-Word Magenta ("No" Medium atas / "time spent with" Bold bawah)
  let pattern = 0;
  if (hasNumberOrSymbol && raw.length >= 3) {
    pattern = 0;
  } else if (ki === 0 && raw.length >= 2) {
    pattern = 1;
  } else if (raw.length >= 3 && r() < 0.34) {
    pattern = 2;
  } else if (raw.length >= 4 && ki === 1 && r() < 0.45) {
    pattern = 4;
  } else {
    pattern = 3;
  }

  let heroPx      = Math.round(basePx * 1.65); // Kata raksasa ($30,000, because)
  let anchorKeyPx = Math.round(basePx * 1.06); // Kata kunci sedang (weekends,, family, time spent with)
  let subBoldPx   = Math.max(Math.round(basePx * 0.65), 38); // Kata pendukung tebal (I left my, I was tired)
  let subMedPx    = Math.max(Math.round(basePx * 0.76), 42); // Kata pendukung medium (10-12 hours, No)

  const rows = [];

  if (pattern === 0 && raw.length >= 3) {
    const pivot = ki > 0 && ki < raw.length - 1 ? ki : Math.floor(raw.length / 2);
    rows.push(
      raw.slice(0, pivot).map((word, i) => ({ word, idx: i, role: 'subBold', colorType: 'white', align: 'left' }))
    );
    rows.push([
      { word: raw[pivot], idx: pivot, role: 'hero', colorType: 'warmGlow', align: 'center' }
    ]);
    rows.push(
      raw.slice(pivot + 1).map((word, i) => ({ word, idx: pivot + 1 + i, role: 'subBold', colorType: 'white', align: 'right' }))
    );
  } else if (pattern === 1) {
    rows.push([
      { word: raw[0], idx: 0, role: 'hero', colorType: 'warmGlow', align: 'center' }
    ]);
    if (raw.length > 1) {
      rows.push(
        raw.slice(1).map((word, i) => ({ word, idx: i + 1, role: 'subBold', colorType: 'white', align: 'center' }))
      );
    }
  } else if (pattern === 2) {
    const splitAt = ki > 0 ? ki : Math.max(1, raw.length - 2);
    rows.push(
      raw.map((word, idx) => ({
        word,
        idx,
        role: idx >= splitAt ? 'subBold' : 'subMed',
        colorType: idx >= splitAt ? 'gold' : 'white',
        align: 'center'
      }))
    );
  } else if (pattern === 4 && raw.length >= 3) {
    rows.push([
      { word: raw[0], idx: 0, role: 'subMed', colorType: 'white', align: 'center' }
    ]);
    rows.push(
      raw.slice(1).map((word, i) => ({
        word,
        idx: i + 1,
        role: 'anchorKey',
        colorType: 'magenta',
        align: 'center'
      }))
    );
  } else {
    const splitAt = ki > 0 ? ki : 1;
    rows.push(
      raw.slice(0, splitAt).map((word, i) => ({ word, idx: i, role: 'subMed', colorType: 'white', align: 'center' }))
    );
    rows.push(
      raw.slice(splitAt).map((word, i) => ({
        word,
        idx: splitAt + i,
        role: 'anchorKey',
        colorType: 'warmGlow',
        align: 'center'
      }))
    );
  }

  const pxOf = (it) => {
    if (it.role === 'hero') return heroPx;
    if (it.role === 'anchorKey') return anchorKeyPx;
    if (it.role === 'subMed') return subMedPx;
    return subBoldPx;
  };

  const fontOf = (it) => {
    if (it.role === 'hero') return FONT_HEAVY;
    if (it.role === 'subMed') return FONT_MEDIUM;
    return FONT_BOLD;
  };

  const trackOf = (it) => (it.role === 'hero' || it.role === 'anchorKey' ? TRACK_HERO : TRACK_SUB);
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));

  const spaceW = (it) => {
    const mult = it.role === 'subBold' ? 0.62 : 0.70;
    return widthPx(' ', fontOf(it), pxOf(it)) * mult;
  };

  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const fitScale = Math.min(1, MAXW / maxRowWidth);
  heroPx      *= fitScale;
  anchorKeyPx *= fitScale;
  subBoldPx   *= fitScale;
  subMedPx    *= fitScale;

  const gap = pattern === 0 || pattern === 1
    ? Math.round(-basePx * 0.15 * fitScale)
    : Math.round(-basePx * 0.08 * fitScale);

  const blockW = Math.max(...rows.map(rowW));
  const cx = o.cx || 540;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  const animVariant = Math.floor(r() * 3);
  const slideDir = r() < 0.5 ? 1 : -1;

  const makeWordLayers = (it, x, y, t) => {
    const px = pxOf(it);
    const font = fontOf(it);
    const track = trackOf(it);
    const isHero = it.role === 'hero';
    const isAccent = it.colorType !== 'white';

    let fillColor = '#FFFFFF';
    let glowHex = '#000000';
    let sdVal = 8;

    if (it.colorType === 'warmGlow') {
      fillColor = '#FF9500';
      glowHex = '#FF2A00';
      sdVal = isHero ? 34 : 22;
    } else if (it.colorType === 'gold') {
      fillColor = '#FFD60A';
      glowHex = '#FF8800';
      sdVal = 20;
    } else if (it.colorType === 'magenta') {
      fillColor = '#E040FB';
      glowHex = '#A21CAF';
      sdVal = 24;
    }

    let startX = x;
    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let blur0 = 0;
    let dur = 300;

    if (isHero || it.role === 'anchorKey') {
      if (animVariant === 0 && isHero) {
        startSx = 38;
        startSy = 38;
        blur0 = 10;
        dur = 340;
      } else if (animVariant === 1) {
        startY = y + 64;
        blur0 = 15;
        dur = 310;
      } else {
        startX = x + slideDir * 80;
        blur0 = 12;
        dur = 320;
      }
    } else {
      if (pattern === 2) {
        startY = y + 22;
        blur0 = 10;
        dur = 250;
      } else if (animVariant === 2) {
        startX = x - slideDir * 42;
        blur0 = 6;
        dur = 240;
      } else {
        startY = y + 38;
        blur0 = 6;
        dur = 240;
      }
    }

    const tMid = t + Math.round(dur * 0.45);
    const midX = x + (startX - x) * 0.20;
    const midY = y + (startY - y) * 0.20;
    const midS = 100 + (startSx - 100) * 0.20;
    const midBlur = Math.round(blur0 * 0.25);

    const out = [];

    if (isAccent) {
      const glowAlpha = isHero ? 0.62 : 0.48;
      const glowBlur = isHero ? 24 : 16;
      out.push({
        kind: 'text',
        text: it.word,
        font,
        px,
        fsp: track * px,
        color: glowHex,
        oc: glowHex,
        ow: isHero ? 6 : 4,
        sd: sdVal,
        shade: false,
        x,
        y,
        rot: 0,
        keys: [
          { t: 0,       a: 0,               blur: glowBlur + blur0, x: startX, y: startY, sx: startSx, sy: startSy },
          { t,          a: 0,               blur: glowBlur + blur0, x: startX, y: startY, sx: startSx, sy: startSy },
          { t: tMid,    a: glowAlpha * 0.9, blur: glowBlur,         x: midX,   y: midY,   sx: midS,    sy: midS },
          { t: t + dur, a: glowAlpha,       blur: glowBlur,         x: x,      y: y,      sx: 100,     sy: 100 }
        ]
      });
    }

    out.push({
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp: track * px,
      color: fillColor,
      oc: isAccent ? glowHex : '#000000',
      ow: 0,
      sd: isAccent ? 14 : 8,
      shade: !isAccent,
      x,
      y,
      rot: 0,
      keys: [
        { t: 0,       a: 0,    blur: blur0,   x: startX, y: startY, sx: startSx, sy: startSy },
        { t,          a: 0,    blur: blur0,   x: startX, y: startY, sx: startSx, sy: startSy },
        { t: tMid,    a: 0.90, blur: midBlur, x: midX,   y: midY,   sx: midS,    sy: midS },
        { t: t + dur, a: 1,    blur: 0,       x: x,      y: y,      sx: 100,     sy: 100 }
      ]
    });

    return out;
  };

  const els = [];
  let y = o.top;

  rows.forEach((row) => {
    const rw = rowW(row);
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    const align = row[0].align;

    // Sejajar presisi dengan tepi kiri & kanan kata utama ($30,000) seperti di screenshot
    let curX = blockStartX + (blockW - rw) / 2;
    if (align === 'left') {
      curX = blockStartX;
    } else if (align === 'right') {
      curX = blockStartX + (blockW - rw);
    }

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.34;
      const layers = makeWordLayers(it, curX + ww / 2, cy + baselineOffset, times[it.idx]);
      els.push(...layers);
      curX += ww + spaceW(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: o.top, bottom: y - gap } };
}

// ---- preset: EditorialMinimal.txt
// Nama Gaya Sosmed: Minimalist Editorial / Kinetic Serif-Sans Pop-up
// Karakteristik: 1 baris center-aligned, all-lowercase, kontras Sans-Serif Bold (1 kata) & kombinasi Sans-Serif Regular tipis + Serif Italic besar (frasa 2-3 kata), tanpa background pill
// Font Wajib: 'Helvetica Neue Bold', 'Helvetica Neue Regular', dan 'Playfair Display Italic'
// Mode Blend: SUBTRACT (aktifkan inverse_auto / .style-inverse_auto)
// Chunk: 1-3

function capEditorialMinimal(text, o = {}) {
  const raw = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorialMinimal|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_BOLD   = 'Helvetica Neue Bold';
  const FONT_REG    = 'Helvetica Neue Regular';
  const FONT_SERIF  = 'Playfair Display Italic';
  const TRACK_SANS  = -0.042;
  const TRACK_SERIF = -0.02;
  const MAXW        = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  const isSingleWord = raw.length === 1;

  // Variasi gaya per kemunculan:
  // Mode 0: Frasa multi-kata menggunakan Serif Italic besar untuk keyword + Sans Regular tipis untuk kata pendukung (seperti "pain in" & "move through")
  // Mode 1: Clean Sans-Serif Bold seragam (seperti "the pain", "becomes", "consumed")
  // Mode 2: Sans-Serif Bold dengan kurung siku editorial "[ word ]" (seperti "[ understand ]")
  const styleRoll = r();
  const useDualEditorial = !isSingleWord && styleRoll < 0.55;
  const useBrackets = isSingleWord && styleRoll > 0.72;

  const displayRaw = useBrackets ? [`[ ${raw[0]} ]`] : raw;

  let keyPx = useDualEditorial
    ? Math.round(basePx * 1.18)
    : Math.round(basePx * 0.96);

  let regPx = useDualEditorial
    ? Math.max(Math.round(basePx * 0.72), 36)
    : Math.round(basePx * 0.96);

  const items = displayRaw.map((word, idx) => ({
    word,
    idx,
    isKey: isSingleWord ? true : idx === ki
  }));

  const pxOf = (it) => (it.isKey ? keyPx : regPx);
  const fontOf = (it) => {
    if (useDualEditorial) {
      return it.isKey ? FONT_SERIF : FONT_REG;
    }
    return FONT_BOLD;
  };
  const trackOf = (it) => (useDualEditorial && it.isKey ? TRACK_SERIF : TRACK_SANS);
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));

  // Jarak antar kata dibuat rapat dan presisi seperti pada referensi ("pain in" & "move through")
  const spaceRatio = useDualEditorial ? 0.58 : 0.78;
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * spaceRatio;

  // Auto-fit terhadap MAXW = 860
  const totalRowWidth = Math.max(
    items.reduce((acc, it, j) => acc + wOf(it) + (j > 0 ? spaceW(it) : 0), 0),
    1
  );
  const k = Math.min(1, MAXW / totalRowWidth);
  keyPx *= k;
  regPx *= k;

  const blockW = items.reduce((acc, it, j) => acc + wOf(it) + (j > 0 ? spaceW(it) : 0), 0);
  const cx = o.cx !== undefined ? o.cx : 540;
  const topY = o.top !== undefined ? o.top : 960;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  // Variasi gerakan masuk dari JSON (1_Basic_Up, 1_Blur_Up, 2.Light_Zoom In)
  const motionMode = Math.floor(r() * 2); // 0: Blur Up + Light Zoom | 1: Snappy Rebound Up + Light Zoom

  const buildWordElement = (it, x, y, t) => {
    const px = pxOf(it);
    const track = trackOf(it);
    const isKey = it.isKey;

    // Ekstraksi matematis JSON:
    // - Offset Y dari 1_Basic_Up (-0.1258 normalized -> diskalakan ke 44px untuk keyword, 22px untuk pendukung)
    // - Blur dari 1_Blur_Up (Blur Fade-In -> 12px untuk keyword, 6px untuk pendukung)
    // - Scale dari 2.Light_Zoom In (84% -> 100% untuk keyword, 94% -> 100% untuk pendukung)
    const offsetY    = isKey ? 44 : 22;
    const startBlur  = motionMode === 0 ? (isKey ? 12 : 6) : (isKey ? 5 : 0);
    const startScale = isKey ? 84 : 94;
    const animDur    = isKey ? 230 : 180;

    return {
      kind: 'text',
      text: it.word,
      font: fontOf(it),
      px,
      fsp: track * px,
      color: '#FFFFFF',
      oc: '#FFFFFF',
      ow: 0,
      sd: 0,
      shade: false,
      blendMode: 'difference',
      x,
      y,
      rot: 0,
      keys: [
        { t: 0,           a: 0, blur: startBlur, x, y: y + offsetY, sx: startScale, sy: startScale },
        { t: t,           a: 0, blur: startBlur, x, y: y + offsetY, sx: startScale, sy: startScale },
        { t: t + animDur, a: 1, blur: 0,         x, y: y,           sx: 100,        sy: 100 }
      ]
    };
  };

  const els = [];
  const lineH = Math.max(...items.map(pxOf));
  const cy = topY + lineH / 2;
  let curX = blockStartX;

  items.forEach((it) => {
    const ww = wOf(it);
    // Sejajarkan baseline bagian bawah antara Serif Italic besar dan Sans Regular kecil
    const baselineOffset = (lineH - pxOf(it)) * 0.36;
    els.push(buildWordElement(it, curX + ww / 2, cy + baselineOffset, times[it.idx]));
    curX += ww + spaceW(it);
  });

  return {
    elements: els,
    box: {
      top: topY,
      bottom: topY + lineH
    }
  };
}
// ---- preset: EditorialMix.txt
// Nama Gaya Sosmed: Iman Gadzhi Editorial Calligraphic & Bold Kinetic Typography
// Karakteristik: Dinamis (1-kata cepat pada transisi kalimat & tumpukan 2-4 baris staggered overlapping pada frasa utama), 3 kategori font kontras (Sans Regular tipis #FFFFFF untuk pendukung, Swash Serif/Script Italic putih & oranye menyala #FF8A00 dengan Warm Outer Glow, serta Heavy Bold Sans untuk penekanan tegas), jarak antar kata rapat (0.68x space).
// Font Wajib: 'Playfair Display Italic', 'Helvetica Neue Bold', 'Helvetica Neue Regular'
// Mode Blend: Normal (Solid + Soft Drop Shadow pada teks putih, Warm Outer Glow #FF5500 pada keyword oranye)
// Chunk: 1-5
function capEditorialMix(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorialMix|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_SWASH_IT = 'Playfair Display Italic'; // Mewakili Calligraphic / Swash Serif Italic ("I Think", "Calendar", "easiest way", "Someone's", "5 years", "behavior")
  const FONT_BOLD_BD  = 'Helvetica Neue Bold';     // Mewakili Heavy Bold Sans-Serif ("genuinely", "wealth")
  const FONT_SUPP_RG  = 'Helvetica Neue Regular';  // Mewakili Sans-Serif tipis/ramping untuk kata pendukung & transisi 1-kata

  const TRACK_BOLD = -0.045;
  const TRACK_SWSH = -0.015;
  const TRACK_SUPP = -0.010;
  const SPACE_MULT = 0.68; // Jarak antar kata horizontal rapat khas editorial
  const MAXW       = 860;

  const basePx  = (o.px || 105) * (o.k || 1);
  let bigPx     = Math.round(basePx * 1.48);           // ~2.3x lebih besar dari pendukung
  let smallPx   = Math.max(Math.round(basePx * 0.42), 34); // Tipis & clean seperti di video ("it's", "right", "But", "just")

  // KASUS KHUSUS 1: Chunk 1-2 kata transisi cepat (seperti detik 00:08 "But" / "just" / "people")
  if (raw.length === 1 && raw[0].length <= 6 && r() < 0.55) {
    const w = raw[0];
    const ww = widthPx(w, FONT_SUPP_RG, smallPx) * (1 + TRACK_SUPP);
    const cx = o.cx || 540;
    const y0 = o.top !== undefined ? o.top : 860;
    const t0 = times[0];

    return {
      elements: [{
        kind: 'text',
        text: w,
        font: FONT_SUPP_RG,
        px: smallPx,
        fsp: TRACK_SUPP * smallPx,
        color: '#FFFFFF',
        oc: '#000000',
        ow: 0,
        sd: 8,
        shade: true,
        x: cx,
        y: y0 + smallPx / 2,
        rot: 0,
        keys: [
          { t: 0,        a: 0, blur: 6, x: cx, y: y0 + smallPx / 2 + 16, sx: 100, sy: 100 },
          { t: t0,       a: 0, blur: 6, x: cx, y: y0 + smallPx / 2 + 16, sx: 100, sy: 100 },
          { t: t0 + 160, a: 1, blur: 0, x: cx, y: y0 + smallPx / 2,      sx: 100, sy: 100 }
        ]
      }],
      box: { top: y0, bottom: y0 + smallPx }
    };
  }

  // Tentukan gaya visual kata kunci utama:
  // Mode 0 (55%): Calligraphic/Swash Italic Oranye Menyala + Glow ("easiest way", "5 years", "behavior", "Calendar")
  // Mode 1 (25%): Heavy Bold Sans Oranye Menyala + Glow ("genuinely", "wealth")
  // Mode 2 (20%): Calligraphic/Swash Italic Putih Bersih ("I Think", "Someone's")
  const keyRoll = r();
  const keyStyle = keyRoll < 0.55 ? 'swash_orange' : (keyRoll < 0.80 ? 'bold_orange' : 'swash_white');

  // Susun baris bertumpuk staggered (menjorok asimetris seperti di video)
  const rows = [];
  if (raw.length === 1) {
    rows.push({
      indent: 0,
      items: [{ word: raw[0], idx: 0, role: 'key' }]
    });
  } else if (raw.length === 2) {
    if (ki === 0) {
      rows.push({ indent: -0.06, items: [{ word: raw[0], idx: 0, role: 'key' }] });
      rows.push({ indent: 0.14,  items: [{ word: raw[1], idx: 1, role: 'supp' }] });
    } else {
      rows.push({ indent: -0.10, items: [{ word: raw[0], idx: 0, role: 'supp' }] });
      rows.push({ indent: 0.04,  items: [{ word: raw[1], idx: 1, role: 'key' }] });
    }
  } else if (raw.length <= 4) {
    const pre = raw.slice(0, ki);
    const post = raw.slice(ki + 1);
    if (pre.length) {
      rows.push({
        indent: -0.14, // Menjorok kiri atas (seperti "It's also the" / "where")
        items: pre.map((word, i) => ({ word, idx: i, role: 'supp' }))
      });
    }
    rows.push({
      indent: 0.0,
      items: [{ word: raw[ki], idx: ki, role: 'key' }]
    });
    if (post.length) {
      rows.push({
        indent: 0.15,  // Menjorok kanan bawah (seperti "to know" / "right")
        items: post.map((word, i) => ({ word, idx: ki + 1 + i, role: 'supp' }))
      });
    }
  } else {
    // 5 kata: gabungkan maksimal 2 kata menjadi frasa keyword utama ("easiest way", "5 years")
    const pre = raw.slice(0, ki);
    const keyEnd = Math.min(raw.length, ki + 2);
    const keyWords = raw.slice(ki, keyEnd);
    const post = raw.slice(keyEnd);

    if (pre.length) {
      rows.push({
        indent: -0.15,
        items: pre.map((word, i) => ({ word, idx: i, role: 'supp' }))
      });
    }
    rows.push({
      indent: 0.0,
      items: keyWords.map((word, i) => ({ word, idx: ki + i, role: 'key' }))
    });
    if (post.length) {
      rows.push({
        indent: 0.14,
        items: post.map((word, i) => ({ word, idx: keyEnd + i, role: 'supp' }))
      });
    }
  }

  const pxOf = (it) => (it.role === 'key' ? bigPx : smallPx);
  const fontOf = (it) => {
    if (it.role !== 'key') return FONT_SUPP_RG;
    return keyStyle === 'bold_orange' ? FONT_BOLD_BD : FONT_SWASH_IT;
  };
  const trackOf = (it) => {
    if (it.role !== 'key') return TRACK_SUPP;
    return keyStyle === 'bold_orange' ? TRACK_BOLD : TRACK_SWSH;
  };
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const rowW = (row) => row.items.reduce((acc, it, j) => {
    const sp = j ? widthPx(' ', fontOf(it), pxOf(it)) * SPACE_MULT : 0;
    return acc + wOf(it) + sp;
  }, 0);

  // Auto-fit terhadap MAXW = 860
  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const scaleFit = Math.min(1, MAXW / maxRowWidth);
  bigPx   *= scaleFit;
  smallPx *= scaleFit;

  // Tight overlapping leading (-16% dari basePx agar ascender menyentuh baris atasnya)
  const gap = Math.round(-basePx * 0.16 * scaleFit);
  const blockW = Math.max(...rows.map(rowW));
  const cx = o.cx || 540;
  const baseBlockX = Math.max(60, Math.min(1080 - 60 - blockW, cx - blockW / 2));

  // Variasi preset gerakan dari JSON:
  // 0: 1_Blur_Up (offset Y +121px, blur 16->0)
  // 1: 2.Light_Zoom In (scale 33%->100%, blur 12->0)
  // 2: 3_Left_Hazy (reveal slide dari kiri ke kanan + blur 14->0)
  const keyAnimMode   = Math.floor(r() * 3);
  const smallAnimMode = Math.floor(r() * 3);

  const makeWord = (it, x, y, t) => {
    const isKey = it.role === 'key';
    const px = pxOf(it);
    const font = fontOf(it);
    const trk = trackOf(it);
    const isOrangeGlow = isKey && keyStyle !== 'swash_white';

    const el = {
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp: trk * px,
      color: isOrangeGlow ? '#FF8A00' : '#FFFFFF',
      oc: isOrangeGlow ? '#FF5500' : '#000000',
      ow: 0,
      sd: isOrangeGlow ? 20 : 10, // Warm outer glow pada keyword oranye, soft shadow pada teks putih
      shade: true,
      x,
      y,
      rot: 0
    };

    let startX = x;
    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let blur0 = 0;
    let animDur = isKey ? 280 : 200;

    if (isKey) {
      if (keyAnimMode === 0) {
        // Preset 1_Blur_Up (nilai matematis JSON: -0.12587 * 960 = +121px)
        startY = y + Math.round(121 * scaleFit);
        blur0 = 16;
      } else if (keyAnimMode === 1) {
        // Preset 2.Light_Zoom In (nilai matematis JSON: 0.4044 / 1.22 = 33% -> 100%)
        startSx = 33;
        startSy = 33;
        blur0 = 12;
        animDur = 310;
      } else {
        // Sapuan masuk dari kiri ke kanan + blur halus
        startX = x - Math.round(85 * scaleFit);
        blur0 = 14;
      }
    } else {
      if (smallAnimMode === 0) {
        // Preset 1_Blur_Up halus untuk kata pendukung
        startY = y + Math.round(64 * scaleFit);
        blur0 = 10;
      } else if (smallAnimMode === 1) {
        // Preset 1_Basic_Up (tanpa blur, dorongan vertikal cepat)
        startY = y + Math.round(78 * scaleFit);
        blur0 = 0;
      } else {
        // Preset 3_Left_Hazy (geser horizontal lembut + hazy blur)
        startX = x + Math.round(95 * scaleFit);
        startSx = 128;
        startSy = 128;
        blur0 = 14;
      }
    }

    // Kurva Rebound Out / Circular Ease dari JSON (89% progres di 35% durasi awal)
    const tMid   = t + Math.round(animDur * 0.35);
    const midX   = x + (startX - x) * 0.22;
    const midY   = y + (startY - y) * 0.22;
    const midSx  = 100 + (startSx - 100) * 0.22;
    const midSy  = 100 + (startSy - 100) * 0.22;
    const midBlr = Math.round(blur0 * 0.25);

    el.keys = [
      { t: 0,           a: 0,    blur: blur0,  x: startX, y: startY, sx: startSx, sy: startSy },
      { t,              a: 0,    blur: blur0,  x: startX, y: startY, sx: startSx, sy: startSy },
      { t: tMid,        a: 0.89, blur: midBlr, x: midX,   y: midY,   sx: midSx,   sy: midSy },
      { t: t + animDur, a: 1,    blur: 0,      x: x,      y: y,      sx: 100,     sy: 100 }
    ];

    return el;
  };

  const els = [];
  let y = o.top !== undefined ? o.top : 800;

  rows.forEach((row) => {
    const h = Math.max(...row.items.map(pxOf));
    const cy = y + h / 2;
    const rw = rowW(row);
    const indentOffset = row.indent * blockW;
    let x = Math.max(50, Math.min(1080 - 50 - rw, baseBlockX + (blockW - rw) * 0.35 + indentOffset));

    row.items.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.32;
      els.push(makeWord(it, x + ww / 2, cy + baselineOffset, times[it.idx]));
      x += ww + widthPx(' ', fontOf(it), pxOf(it)) * SPACE_MULT;
    });

    y += h + gap;
  });

  return { elements: els, box: { top: o.top !== undefined ? o.top : 800, bottom: y - gap } };
}
// ---- preset: EditorialScript.txt
// Nama Gaya Sosmed: Editorial Script & Multi-Contrast Kinetic Captions (Clean Storytelling / Modern Editorial)
// Karakteristik: 4 variasi kontras tipografi dinamis: (1) Script Calligraphy besar lowercase bertumpuk rapat, (2) Sans-Serif SemiBold lowercase, (3) Condensed Bold ALL CAPS untuk klimaks, dan (4) B-Roll 2 baris dengan sorotan kuning bercahaya.
// Font Wajib: 'Brittany Signature' (Script), 'Inter SemiBold' (penekanan sedang), 'Bebas Neue' (klimaks ALL CAPS), 'Inter Regular' & 'Inter Light' (pendukung)
// Mode Blend: NORMAL (Solid text dengan soft outer glow + drop shadow halus; TIDAK memakai efek Subtract/Difference)
// Chunk: 2-5
function capEditorialScript(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const durTotal = o.dur || 1500;
  const cx = o.cx ?? 540;
  const r = typeof rng === 'function' ? rng(`editorialScriptExact|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, durTotal);

  // 5 Font sesuai seluruh klip di video referensi:
  const FONT_SCRIPT    = 'Brittany Signature'; // Dominan keyword ("stuck", "identity", "skills", "attributes", "important")
  const FONT_SEMIBOLD  = 'Inter SemiBold';     // Keyword/frasa non-script ("really", "to a kid", "corporate job", "certain")
  const FONT_CONDENSED = 'Bebas Neue';         // Keyword klimaks ALL CAPS ("LIGHT BULB MOMENT", "BUILD AROUND")
  const FONT_REG       = 'Inter Regular';      // Pendukung talking-head ("You're not", "was very much", "good at a")
  const FONT_LIGHT     = 'Inter Light';        // Pendukung B-roll ("because you", "hey pick this thing and")

  // Kerapatan huruf setara -1 di CapCut (huruf berdekatan rapat)
  const TRACK_TIGHT     = -0.055; // Inter Regular / Light / SemiBold
  const TRACK_CONDENSED = -0.020; // Bebas Neue ALL CAPS
  const TRACK_SCRIPT    = -0.025; // Brittany Signature (sambungan kaligrafi menyatu)
  const SPACE_RATIO     = 0.68;   // Jarak antar kata rapat seperti di video

  const MAXW = 860;
  const basePx = (o.px || 105) * (o.k || 1);

  // Warna solid + pendaran cahaya (soft outer glow) persis seperti video:
  const COLOR_YELLOW_GLOW = '#F3F084'; // Kuning lemon pastel bercahaya
  const COLOR_WHITE       = '#FFFFFF'; // Putih bersih bercahaya

  // Pilih Mode Segmen sesuai pola di video:
  // 0 = Talking-Head Script (52% - "You're not / stuck / in", "My / identity / was very much")
  // 1 = Talking-Head SemiBold Lowercase (22% - "to say / to a kid", "tied to my / corporate job", "good at a / certain / thing")
  // 2 = Talking-Head Condensed ALL CAPS (12% - "I had this / LIGHT BULB MOMENT", "You have to / BUILD AROUND")
  // 3 = B-Roll Inline / 2-Baris (14% - "because you committed to it", "hey pick this thing and / then go run with it")
  const modeRoll = r();
  const segMode =
    raw.length >= 4 && modeRoll < 0.16
      ? 3
      : modeRoll < 0.66
      ? 0
      : modeRoll < 0.86
      ? 1
      : 2;

  const rows = [];

  if (segMode === 3) {
    // MODE 3: B-Roll Editorial (Gambar 2 & Gambar 4)
    const smallPx = Math.max(Math.round(basePx * 0.48), 32);
    if (raw.length === 4) {
      // 1 baris sejajar: "because you committed to it"
      rows.push(
        raw.map((w, idx) => ({
          word: w,
          idx,
          isKey: idx === ki,
          font: idx === ki ? FONT_SEMIBOLD : FONT_LIGHT,
          px: smallPx,
          track: TRACK_TIGHT,
          color: COLOR_WHITE,
          glow: idx === ki ? 14 : 6,
          isScript: false
        }))
      );
    } else {
      // 2 baris bertumpuk rapat: baris atas putih tipis, baris bawah kuning bercahaya (#F3F084)
      const splitIdx = Math.ceil(raw.length / 2);
      rows.push(
        raw.slice(0, splitIdx).map((w, idx) => ({
          word: w,
          idx,
          isKey: false,
          font: FONT_LIGHT,
          px: Math.round(smallPx * 0.90),
          track: TRACK_TIGHT,
          color: COLOR_WHITE,
          glow: 8,
          isScript: false
        }))
      );
      rows.push(
        raw.slice(splitIdx).map((w, j) => ({
          word: w,
          idx: splitIdx + j,
          isKey: true,
          font: FONT_SEMIBOLD,
          px: Math.round(smallPx * 1.06),
          track: TRACK_TIGHT,
          color: COLOR_YELLOW_GLOW,
          glow: 16,
          isScript: false
        }))
      );
    }
  } else {
    // MODE 0, 1, 2: Talking-Head Stacked (2-3 baris bertumpuk)
    const isScript = segMode === 0;
    const isCondensed = segMode === 2;

    const keyFont = isScript
      ? FONT_SCRIPT
      : isCondensed
      ? FONT_CONDENSED
      : FONT_SEMIBOLD;

    const keyTrack = isScript
      ? TRACK_SCRIPT
      : isCondensed
      ? TRACK_CONDENSED
      : TRACK_TIGHT;

    // Skala ukuran huruf utama vs pendukung sesuai proporsi video:
    const bigPx = Math.round(
      basePx * (isScript ? 1.72 : isCondensed ? 1.24 : 1.12)
    );
    const smallPx = Math.max(Math.round(basePx * 0.45), 31);

    // ~68% kata kunci memakai kuning pastel bercahaya (#F3F084), ~32% putih bercahaya (#FFFFFF)
    const keyColor = r() < 0.68 ? COLOR_YELLOW_GLOW : COLOR_WHITE;

    // Pada mode SemiBold / Condensed, kata kunci bisa mencakup 2 kata pendek berdekatan ("to a kid", "corporate job", "BUILD AROUND")
    const spanMultiKey =
      !isScript && ki + 1 < raw.length && raw[ki].length + raw[ki + 1].length <= 13;
    const keyEnd = spanMultiKey ? ki + 1 : ki;

    const formatKeyWord = (w) =>
      isCondensed ? w.toUpperCase() : w.toLowerCase();

    const topRow = [];
    const midRow = [];
    const botRow = [];

    for (let i = 0; i < raw.length; i++) {
      if (i < ki) {
        topRow.push({
          word: raw[i],
          idx: i,
          isKey: false,
          font: FONT_REG,
          px: smallPx,
          track: TRACK_TIGHT,
          color: COLOR_WHITE,
          glow: 7,
          isScript: false
        });
      } else if (i >= ki && i <= keyEnd) {
        midRow.push({
          word: formatKeyWord(raw[i]),
          idx: i,
          isKey: true,
          font: keyFont,
          px: bigPx,
          track: keyTrack,
          color: keyColor,
          glow: keyColor === COLOR_YELLOW_GLOW ? 18 : 11,
          isScript
        });
      } else {
        botRow.push({
          word: raw[i],
          idx: i,
          isKey: false,
          font: FONT_REG,
          px: smallPx,
          track: TRACK_TIGHT,
          color: COLOR_WHITE,
          glow: 7,
          isScript: false
        });
      }
    }

    if (topRow.length) rows.push(topRow);
    if (midRow.length) rows.push(midRow);
    if (botRow.length) rows.push(botRow);
  }

  const wOf = (it) => widthPx(it.word, it.font, it.px) * (1 + it.track);
  const rowW = (row) =>
    row.reduce(
      (acc, it, j) => acc + wOf(it) + (j ? widthPx(' ', it.font, it.px) * SPACE_RATIO : 0),
      0
    );

  // Auto-fit terhadap batas lebar aman MAXW = 860
  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const scaleFit = Math.min(1, MAXW / maxRowWidth);
  rows.forEach((row) =>
    row.forEach((it) => {
      it.px = Math.round(it.px * scaleFit);
    })
  );

  // Jarak antar baris sangat rapat (tight stacking / overlapping halus pada Script seperti "You're not / stuck / in" & "My / identity / was very much")
  const gap =
    segMode === 3
      ? Math.round(basePx * 0.03 * scaleFit)
      : Math.round(-basePx * (segMode === 0 ? 0.25 : 0.13) * scaleFit);

  const blockW = Math.max(...rows.map(rowW));
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  // Variasi animasi masuk berdasarkan file JSON yang sudah diekstrak:
  // 0 = 2.Light_Zoom In (scale 33% -> 100%, Circular Ease, rot 0.23°)
  // 1 = 4. Up_Long + 1_Blur_Up (slide naik panjang + blur fade-in)
  const keyAnimMode = r() < 0.55 ? 0 : 1;

  const createWordEl = (it, x, y, t) => {
    const targetRot = it.isKey && it.isScript ? 0.23 : 0;

    const el = {
      kind: 'text',
      text: it.word,
      font: it.font,
      px: it.px,
      fsp: it.track * it.px,
      color: it.color,
      oc: it.color, // Outer glow menggunakan warna teks (kuning lemon bercahaya / putih)
      ow: 0,
      sd: it.glow,  // Radius pendaran cahaya lembut (16-18 untuk kuning glow, 6-11 untuk putih)
      shade: true,
      x,
      y,
      rot: targetRot
    };

    if (it.isKey && segMode !== 3) {
      if (keyAnimMode === 0) {
        // 2.Light_Zoom In.json (scale 0.404 / 1.22 = 33%, Circular Ease)
        const animDur = Math.min(450, Math.max(240, Math.round(durTotal * 0.32)));
        const fadeLead = Math.round(animDur * 0.16);
        el.keys = [
          { t: 0,            a: 0, blur: 6, x, y, sx: 33,  sy: 33 },
          { t,               a: 0, blur: 6, x, y, sx: 33,  sy: 33 },
          { t: t + fadeLead, a: 0, blur: 4, x, y, sx: 48,  sy: 48 },
          { t: t + animDur,  a: 1, blur: 0, x, y, sx: 100, sy: 100 }
        ];
      } else {
        // 4. Up_Long.json + 1_Blur_Up.json
        const animDur = Math.min(430, Math.max(230, Math.round(durTotal * 0.30)));
        const offsetY = Math.round(175 * scaleFit);
        el.keys = [
          { t: 0,           a: 0, blur: 14, x, y: y + offsetY, sx: 96,  sy: 96 },
          { t,              a: 0, blur: 14, x, y: y + offsetY, sx: 96,  sy: 96 },
          { t: t + animDur, a: 1, blur: 0,  x, y: y,           sx: 100, sy: 100 }
        ];
      }
    } else {
      // 1_Blur_Up.json: kata pendukung naik halus + blur dissolve
      const animDur = Math.min(310, Math.max(175, Math.round(durTotal * 0.22)));
      const offsetY = Math.round((segMode === 3 ? 50 : 80) * scaleFit);
      el.keys = [
        { t: 0,           a: 0, blur: 10, x, y: y + offsetY, sx: 100, sy: 100 },
        { t,              a: 0, blur: 10, x, y: y + offsetY, sx: 100, sy: 100 },
        { t: t + animDur, a: 1, blur: 0,  x, y: y,           sx: 100, sy: 100 }
      ];
    }

    return el;
  };

  const els = [];
  let y = o.top ?? 860;

  rows.forEach((row, rIdx) => {
    const rw = rowW(row);
    const h = Math.max(...row.map((it) => it.px));
    const cy = y + h / 2;

    // Tata letak asimetris organik persis seperti di video:
    // Baris atas sedikit ke kiri atas keyword (0.20), baris keyword center, baris bawah sedikit ke kanan bawah (0.64)
    let rowOffsetX = (blockW - rw) / 2;
    if (segMode !== 3 && rows.length >= 2) {
      if (rIdx === 0 && !row[0].isKey) {
        rowOffsetX = Math.max(0, (blockW - rw) * 0.20);
      } else if (rIdx === rows.length - 1 && !row[0].isKey) {
        rowOffsetX = Math.min(blockW - rw, (blockW - rw) * 0.64);
      }
    }

    let x = blockStartX + rowOffsetX;

    row.forEach((it) => {
      const ww = wOf(it);
      els.push(createWordEl(it, x + ww / 2, cy, times[it.idx]));
      x += ww + widthPx(' ', it.font, it.px) * SPACE_RATIO;
    });

    y += h + gap;
  });

  return {
    elements: els,
    box: { top: o.top ?? 860, bottom: y - gap }
  };
}
// ---- preset: EditorialScriptMix.txt
// Nama Gaya Sosmed : Editorial Script-Bold Collage / Viral White Minimalist (Joseph Style)
// Karakteristik    : 3-tier tipografi kontras tinggi: Script Calligraphy ('Snell Roundhand')
//                    untuk pembuka/aksen frasa, Sans-Serif Bold ('Helvetica Neue Bold',
//                    tracking -1 CapCut) untuk kata kunci utama, dan Sans-Serif Regular
//                    kecil ('Helvetica Neue Regular') untuk kata sambung. Mendukung mode
//                    kolase bertumpuk kompak & single-word center emphasis.
// Font Wajib       : 'Snell Roundhand', 'Helvetica Neue Bold', 'Helvetica Neue Regular'
// Mode Blend       : NORMAL (Putih solid #FFFFFF bersih tanpa shadow & tanpa Subtract)
// Chunk: 1-6

function capEditorialScriptMix(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`edscript_clean|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_SCRIPT = 'Snell Roundhand';
  const FONT_BOLD   = 'Helvetica Neue Bold';
  const FONT_REG    = 'Helvetica Neue Regular';
  const TRACK_BOLD  = -0.06;  // Setara karakter -1 di CapCut (huruf rapat)
  const TRACK_REG   = -0.03;
  const TRACK_SCR   = 0.0;    // 0 agar sambungan huruf kaligrafi tidak terputus
  const MAXW        = 860;

  // Daftar kata sambung/artikel kecil (Level 3: Regular kecil)
  const STOP_WORDS = new Set([
    'is', 'are', 'was', 'were', 'the', 'a', 'an', 'to', 'in', 'on', 'at',
    'of', 'for', 'and', 'or', 'but', 'it', 'its', "it's", 'my', 'your',
    'this', 'that', 'taking', 'wants', 'making', 'go', 'ahead', 'out', 'by'
  ]);

  const basePx = (o.px || 105) * (o.k || 1);

  // MODE 1: Single-Word Center Emphasis (1 kata tunggal di tengah layar)
  if (raw.length === 1) {
    const word = raw[0];
    const px = Math.round(basePx * 0.78);
    const fsp = TRACK_BOLD * px;
    const x = o.cx || 540;
    const y = o.top + px * 0.6;
    const t = times[0] || 0;

    return {
      elements: [{
        kind: 'text',
        text: word,
        font: FONT_BOLD,
        px,
        fsp,
        color: '#FFFFFF',
        oc: '#FFFFFF',
        ow: 0,
        sd: 0,
        shade: false,
        x,
        y,
        rot: 0,
        keys: [
          { t: 0,       a: 0, blur: 14, x, y: y + 26, sx: 88,  sy: 88 },
          { t,          a: 0, blur: 14, x, y: y + 26, sx: 88,  sy: 88 },
          { t: t + 190, a: 1, blur: 0,  x, y,      sx: 100, sy: 100 }
        ]
      }],
      box: { top: o.top, bottom: o.top + px * 1.2 }
    };
  }

  // MODE 2: Kolase Bertumpuk 3-Tier (Script + Bold Keyword + Regular Connector)
  let scriptPx = Math.round(basePx * 1.38); // Level 1: Script besar
  let bigPx    = Math.round(basePx * 1.22); // Level 2: Bold keyword raksasa
  let smallPx  = Math.max(Math.round(basePx * 0.48), 32); // Level 3: Regular kecil

  const items = raw.map((word, idx) => {
    const clean = word.replace(/[^a-zA-Z0-9']/g, '');
    const lower = clean.toLowerCase();
    const isNumber = /^\d+$/.test(clean);
    const isKeyword = idx === ki || isNumber;

    let role = 'reg';
    if (idx === 0 && !isNumber) {
      role = 'script';
    } else if (idx === 1 && raw.length >= 5 && STOP_WORDS.has(lower) && ki >= 2) {
      role = 'script';
    } else if (isKeyword) {
      role = 'big';
    } else if (idx === raw.length - 1 && raw.length >= 5 && lower.length <= 3 && !isNumber) {
      role = 'script';
    } else if (!STOP_WORDS.has(lower) && clean.length >= 4) {
      role = 'big';
    } else {
      role = 'reg';
    }

    return { word, idx, role };
  });

  // Pembagian baris kompak (2 baris untuk 2-4 kata, 3 baris untuk 5+ kata)
  const rows = [];
  if (items.length <= 4) {
    const split = Math.max(1, Math.min(items.length - 1, ki === 0 ? 1 : ki));
    rows.push(items.slice(0, split));
    rows.push(items.slice(split));
  } else {
    const r1 = Math.min(3, Math.max(2, Math.ceil(items.length * 0.38)));
    const r2 = Math.min(items.length - 1, Math.max(r1 + 1, Math.ceil(items.length * 0.72)));
    rows.push(items.slice(0, r1));
    rows.push(items.slice(r1, r2));
    rows.push(items.slice(r2));
  }

  const pxOf    = (it) => (it.role === 'script' ? scriptPx : it.role === 'big' ? bigPx : smallPx);
  const fontOf  = (it) => (it.role === 'script' ? FONT_SCRIPT : it.role === 'big' ? FONT_BOLD : FONT_REG);
  const trackOf = (it) => (it.role === 'script' ? TRACK_SCR : it.role === 'big' ? TRACK_BOLD : TRACK_REG);
  const wOf     = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const spaceOf = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.58;
  const rowW    = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceOf(it) : 0), 0);

  // Pergeseran tangga ringan (staircase editorial)
  const stepShift = rows.length > 1 ? Math.round(28 * (o.k || 1)) : 0;

  // Auto-fit terhadap MAXW = 860
  const maxTotalW = Math.max(...rows.map((row, idx) => rowW(row) + idx * stepShift), 1);
  const k = Math.min(1, MAXW / maxTotalW);
  scriptPx *= k;
  bigPx    *= k;
  smallPx  *= k;
  const shiftK = stepShift * k;

  // Tight leading (-14% dari basePx)
  const gap = Math.round(-basePx * 0.14 * k);
  const blockW = Math.max(...rows.map((row, idx) => rowW(row) + idx * shiftK));
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, (o.cx || 540) - blockW / 2));

  // Variasi animasi dari JSON CapCut (1_Blur_Up & 2.Light_Zoom In)
  const keyAnimMode = Math.floor(r() * 2);

  const makeWord = (it, x, y, t) => {
    const px = pxOf(it);
    const font = fontOf(it);
    const fsp = trackOf(it) * px;
    const isPrimary = it.role === 'big' || it.role === 'script';

    let startX = x;
    let startY = y;
    let startScale = 100;
    let blur0 = 0;
    let animDur = isPrimary ? 230 : 175;

    if (isPrimary) {
      if (keyAnimMode === 0) {
        // 1_Blur_Up.json: naik halus + blur-to-sharp
        startY = y + Math.round(64 * k);
        blur0 = 16;
      } else {
        // 2.Light_Zoom In.json: zoom-in halus dari 42% -> 100%
        startScale = 42;
        blur0 = 10;
        animDur = 245;
      }
    } else {
      // 1_Basic_Up.json: kata sambung naik singkat dan cepat
      startY = y + Math.round(36 * k);
      blur0 = 3;
    }

    return {
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp,
      color: '#FFFFFF',
      oc: '#FFFFFF',
      ow: 0,
      sd: 0,
      shade: false,
      x,
      y,
      rot: 0,
      keys: [
        { t: 0,           a: 0, blur: blur0, x: startX, y: startY, sx: startScale, sy: startScale },
        { t,              a: 0, blur: blur0, x: startX, y: startY, sx: startScale, sy: startScale },
        { t: t + animDur, a: 1, blur: 0,     x: x,      y: y,      sx: 100,        sy: 100 }
      ]
    };
  };

  const els = [];
  let y = o.top;

  rows.forEach((row, rIdx) => {
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    let x = blockStartX + rIdx * shiftK;

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * (it.role === 'reg' ? 0.18 : 0.35);
      els.push(makeWord(it, x + ww / 2, cy + baselineOffset, times[it.idx]));
      x += ww + spaceOf(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: o.top, bottom: y - gap } };
}
// ---- preset: EditorialStacked.txt
// Nama Gaya Sosmed : Haniarteq Editorial Contrast Captions / Stacked Kinetic Typography
// Karakteristik    : Blok 2-3 baris kompak rata kiri sejajar (Left-Aligned), 3 tingkat ketebalan Helvetica Neue,
//                    tracking rapat (-1 CapCut), highlight Terracotta/Neon-Lime + Soft Glow & Gradasi pada keyword.
// Font Wajib       : Helvetica Neue Bold, Helvetica Neue Medium, Helvetica Neue Regular, Helvetica Neue Light
// Mode Blend       : SUBTRACT pada kata pendukung (aktifkan inverse_auto / .style-inverse_auto) + Normal Glow pada kata utama
// Chunk: 2-5

function capEditorialStacked(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorial_stacked|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 3 Tingkat Ketebalan Helvetica Neue (agar kata besar tidak terlalu gemuk)
  const FONT_KEY  = 'Helvetica Neue Bold';    // Kata kunci utama (highlight + glow)
  const FONT_MAIN = 'Helvetica Neue Medium';  // Kata besar sekunder (putih ramping)
  const FONT_SUP  = 'Helvetica Neue Light';   // Kata pendukung kecil (tipis + subtract)

  // Kerapatan huruf rapat setara -1 di CapCut
  const TRACK = -0.052;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1240;
  const basePx = (o.px || 105) * (o.k || 1);

  // Ukuran kompak proporsional di area dada (tidak raksasa mentok layar)
  let bigPx = Math.round(basePx * 0.69);
  let smallPx = Math.max(Math.round(basePx * 0.33), 26);

  // Susun 2 hingga 3 baris bertumpuk sesuai pola video referensi (Chunk 2-5)
  const rows = [];
  if (raw.length === 1) {
    rows.push([{ word: raw[0], idx: 0, big: true, tier: 'key' }]);
  } else if (raw.length === 2) {
    rows.push(
      raw.map((word, idx) => ({
        word,
        idx,
        big: true,
        tier: idx === ki ? 'key' : 'main'
      }))
    );
  } else if (ki === 0) {
    // Pola: Kata utama besar di baris 1 ("Captions"), kata pendukung kecil di baris 2 ("under my chin")
    rows.push([{ word: raw[0], idx: 0, big: true, tier: 'key' }]);
    rows.push(
      raw.slice(1).map((word, i) => ({
        word,
        idx: i + 1,
        big: false,
        tier: 'sup'
      }))
    );
  } else if (raw.length >= 5 && ki > 0 && ki < raw.length - 1) {
    // Pola 3 baris mengapit keyword ("There is a" / "Golden rule" / "in social media")
    const endKey = Math.min(raw.length - 1, ki + 1);
    rows.push(
      raw.slice(0, ki).map((word, i) => ({
        word,
        idx: i,
        big: false,
        tier: 'sup'
      }))
    );
    rows.push(
      raw.slice(ki, endKey).map((word, i) => ({
        word,
        idx: ki + i,
        big: true,
        tier: i === 0 ? 'key' : 'main'
      }))
    );
    rows.push(
      raw.slice(endKey).map((word, i) => ({
        word,
        idx: endKey + i,
        big: false,
        tier: 'sup'
      }))
    );
  } else {
    // Pola dominan 2 baris: baris 1 kata pendukung kecil ("Something" / "and that makes"),
    // baris 2 kata besar semua ("great happens" / "your videos") dengan hanya keyword yang tebal + glow
    rows.push(
      raw.slice(0, ki).map((word, i) => ({
        word,
        idx: i,
        big: false,
        tier: 'sup'
      }))
    );
    rows.push(
      raw.slice(ki).map((word, i) => ({
        word,
        idx: ki + i,
        big: true,
        tier: i === 0 ? 'key' : 'main'
      }))
    );
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => {
    if (it.tier === 'key') return FONT_KEY;
    if (it.tier === 'main') return FONT_MAIN;
    return FONT_SUP;
  };

  // Jarak antar kata rapat (0.76x spasi normal)
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.76;
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  // Batasi lebar blok kompak ~560px (aman di dalam MAXW 860)
  const targetMaxW = Math.min(MAXW, 560);
  const fitScale = Math.min(1, targetMaxW / maxRowWidth);
  bigPx *= fitScale;
  smallPx *= fitScale;

  // Jarak vertikal antar baris sangat rapat (tight leading)
  const gap = Math.round(-basePx * 0.085 * fitScale);
  const blockW = Math.max(...rows.map(rowW));
  const blockStartX = Math.max(70, Math.min(1080 - 70 - blockW, cx - blockW / 2));

  // Palet warna sesuai video awal (Terracotta Glow + Gradasi) & foto referensi (Neon Lime Glow)
  // Default Terracotta '#E87A3E' (ganti ke '#D8FF2A' jika ingin fokus gaya Neon Lime foto kedua)
  const useNeonLime = r() > 0.65;
  const HIGHLIGHT_COLOR = useNeonLime ? '#D8FF2A' : '#E87A3E';
  const HIGHLIGHT_GRAD_TOP = useNeonLime ? '#EEFF70' : '#FF9A52';
  const HIGHLIGHT_GRAD_BOT = useNeonLime ? '#B8E600' : '#D96528';

  // Variasi gerakan hasil ekstraksi 4 JSON (1_Blur_Up, 1_Basic_Up, 3_Left_Hazy, 2.Light_Zoom In)
  const bigAnimMode = Math.floor(r() * 3);
  const supSlideDir = r() > 0.5 ? 1 : -1;

  const createWordEl = (w, font, px, x, y, t, it) => {
    const isKey = it.tier === 'key';
    const isSup = it.tier === 'sup';

    let el;
    if (isSup) {
      // KATA PENDUKUNG: Efek SUBTRACT (Difference) putih murni tanpa tepian/bayangan
      el = {
        kind: 'text',
        text: w,
        font,
        px,
        fsp: TRACK * px,
        color: '#FFFFFF',
        oc: '#FFFFFF',
        ow: 0,
        sd: 0,
        shade: false,
        blendMode: 'difference',
        x,
        y,
        rot: 0,
        keys: []
      };
    } else if (isKey) {
      // KATA KUNCI UTAMA: Highlight Terracotta/Neon Lime + Soft Outer Glow + Gradasi Halus
      el = {
        kind: 'text',
        text: w,
        font,
        px,
        fsp: TRACK * px,
        color: HIGHLIGHT_COLOR,
        gradTop: HIGHLIGHT_GRAD_TOP,
        gradBottom: HIGHLIGHT_GRAD_BOT,
        glowColor: HIGHLIGHT_COLOR,
        glowBlur: 18,
        glowAlpha: 0.58,
        oc: HIGHLIGHT_COLOR,
        ow: 0,
        sd: 0,
        shade: false,
        x,
        y,
        rot: 0,
        keys: []
      };
    } else {
      // KATA BESAR SEKUNDER: Putih solid ramping dengan ambient shadow sangat tipis
      el = {
        kind: 'text',
        text: w,
        font,
        px,
        fsp: TRACK * px,
        color: '#FFFFFF',
        oc: '#000000',
        ow: 0,
        sd: 1.1,
        shade: true,
        x,
        y,
        rot: 0,
        keys: []
      };
    }

    let startX = x;
    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let blur0 = it.big ? 13 : 7;
    let rot0 = 0;

    // Timing keyframe terkalibrasi dari JSON (snappy sesuai ritme bicara)
    const animDur = it.big ? 235 : 185;
    const tMid = t + Math.round(animDur * 0.58);
    const tEnd = t + animDur;

    if (it.big) {
      if (bigAnimMode === 0) {
        // 1_Blur_Up.json: naik vertikal halus dengan mikro rebound (-2px)
        startY = y + Math.round(42 * fitScale);
      } else if (bigAnimMode === 1) {
        // 3_Left_Hazy.json & 3_Right_Basic.json: geser horizontal Circular Ease + mikro rotasi 0.23 deg
        const dir = r() > 0.5 ? 1 : -1;
        startX = x + dir * Math.round(56 * fitScale);
        rot0 = dir * 0.23;
      } else {
        // 2.Light_Zoom In.json: scale-in halus dari 82% ke 100% + rise tipis
        startY = y + Math.round(22 * fitScale);
        startSx = 82;
        startSy = 82;
      }
    } else {
      // Kata pendukung: muncul halus dari samping (3_Left_Hazy) atau bawah (1_Basic_Up)
      if (r() > 0.45) {
        startX = x + supSlideDir * Math.round(36 * fitScale);
        rot0 = supSlideDir * 0.23;
      } else {
        startY = y + Math.round(20 * fitScale);
      }
    }

    const midX = x + (startX - x) * 0.12;
    const midY = it.big && bigAnimMode === 0
      ? y - Math.round(2 * fitScale)
      : y + (startY - y) * 0.12;

    el.keys = [
      { t: 0,    a: 0,    blur: blur0,              x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0 },
      { t,       a: 0,    blur: blur0,              x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0 },
      { t: tMid, a: 0.94, blur: Math.round(blur0 * 0.2), x: midX,   y: midY,   sx: 100,     sy: 100,     rot: rot0 * 0.2 },
      { t: tEnd, a: 1,    blur: 0,                  x: x,      y: y,      sx: 100,     sy: 100,     rot: 0 }
    ];

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((row) => {
    if (!row.length) return;
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    // Rata kiri ketat (Left-Aligned) sejajar lurus di tepi kiri blok
    let x = blockStartX;

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      els.push(
        createWordEl(
          it.word,
          fontOf(it),
          pxOf(it),
          x + ww / 2,
          cy + baselineOffset,
          times[it.idx],
          it
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return {
    elements: els,
    box: { top: topY, bottom: y - gap }
  };
}
// ---- preset: EditorialSwiss.txt
// Nama Gaya Sosmed: EditorialSwiss / Swiss Editorial Kinetic Typography
// Karakteristik: 4 mode dinamis (Single Word Difference, 1-Baris Bold-Regular Contrast, 2-Baris Split Top Asimetris, 3-Baris Stacked Editorial), lowercase semua, tracking sangat rapat (-1.5 CapCut), teks putih bersih (#FFFFFF) + highlight Deep Navy (#061E5C) atau Oranye Glow (#FF8C24), serta Blur Out serentak di akhir
// Font Wajib: Helvetica Neue Bold, Helvetica Neue Regular
// Mode Blend: SUBTRACT (aktifkan inverse_auto / .style-inverse_auto untuk mode 1-kata tunggal di atas footage, dan Normal pada mode multi-kata/slide)
// Chunk: 1-4

function capSwissEditorialKinetic(text, o = {}) {
  const cleanText = text.toLowerCase().trim();
  const raw = cleanText.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const durTotal = o.dur || 1500;
  const r = typeof rng === 'function' ? rng(`EditorialSwiss|${cleanText}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, durTotal);

  const FONT_BOLD = 'Helvetica Neue Bold';
  const FONT_REG  = 'Helvetica Neue Regular';
  // Kerapatan huruf setara CapCut Character Spacing -1 s/d -2 (huruf saling merapat seperti referensi "capable")
  const TRACK = -0.062;
  const WORD_SPACE_RATIO = 0.68;
  // Batas lebar aman agar tidak menabrak tepi kiri/kanan layar
  const MAXW = 780;

  const basePx = (o.px || 105) * (o.k || 1);
  let bigPx = Math.round(basePx * 1.32);
  let smallPx = Math.max(Math.round(basePx * 0.58), 32);
  let flatPx = Math.round(basePx * 0.84);

  // Tentukan pola tata letak & ketebalan berdasarkan jumlah kata (Chunk 1-4)
  let layoutMode = 0;
  if (raw.length === 1) {
    layoutMode = 0; // Single Word Center (Difference)
  } else if (raw.length === 2) {
    layoutMode = 2; // 2 Baris Bertumpuk
  } else if (raw.length === 3) {
    layoutMode = r() > 0.4 ? 2 : 1; // Split Top ("what" [kiri] + "you're" [kanan] di atas "capable") atau 1 Baris Contrast
  } else {
    layoutMode = r() > 0.4 ? 3 : 1; // 3 Baris Stacked Editorial atau 1 Baris Contrast
  }

  const rows = [];
  if (layoutMode === 0) {
    // Pola A: Single Word Center
    rows.push([{ word: raw[0], idx: 0, big: true, bold: true, role: 'key' }]);
  } else if (layoutMode === 1) {
    // Pola B: 1 Baris Horizontal Rata Kiri dengan kontras Bold-Regular ("about" Bold, "what's" Reg, "wrong" Bold)
    const lineItems = raw.map((w, i) => {
      const isEdgeOrKey = (i === 0 || i === raw.length - 1 || i === ki);
      return {
        word: w,
        idx: i,
        big: false,
        flat: true,
        bold: isEdgeOrKey,
        role: i === ki ? 'key' : (isEdgeOrKey ? 'accent' : 'filler')
      };
    });
    rows.push(lineItems);
  } else if (layoutMode === 2) {
    // Pola C: 2 Baris Bertumpuk (Split Top persis referensi: "what" & "you're" sama-sama Bold di baris atas)
    if (raw.length === 2) {
      rows.push([{ word: raw[0], idx: 0, big: false, bold: true, role: 'filler' }]);
      rows.push([{ word: raw[1], idx: 1, big: true,  bold: true, role: 'key' }]);
    } else {
      const topWords = raw.filter((_, i) => i !== ki);
      const keyWord = raw[ki];
      rows.push(topWords.map((w) => {
        const origIdx = raw.indexOf(w);
        return { word: w, idx: origIdx, big: false, bold: true, role: 'filler', splitTop: true };
      }));
      rows.push([{ word: keyWord, idx: ki, big: true, bold: true, role: 'key' }]);
    }
  } else {
    // Pola D: 3 Baris Editorial Stacked ("set" kiri atas, "your goals" tengah besar, "high" kanan bawah)
    rows.push([{ word: raw[0], idx: 0, big: false, bold: false, role: 'filler', align: 'left' }]);
    const midWords = raw.slice(1, raw.length - 1).map((w, idx) => ({
      word: w,
      idx: idx + 1,
      big: true,
      bold: true,
      role: 'key'
    }));
    rows.push(midWords);
    rows.push([{ word: raw[raw.length - 1], idx: raw.length - 1, big: false, bold: false, role: 'filler', align: 'right' }]);
  }

  const pxOf = (it) => (it.flat ? flatPx : (it.big ? bigPx : smallPx));
  const fontOf = (it) => (it.bold ? FONT_BOLD : FONT_REG);
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const spaceOf = (it) => widthPx(' ', fontOf(it), pxOf(it)) * WORD_SPACE_RATIO;
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceOf(it) : 0), 0);

  // Auto-fit ketat terhadap MAXW = 780 agar 2 kata besar di baris tengah tidak meluber ke pinggir
  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const fitK = Math.min(1, MAXW / maxRowWidth);
  bigPx = Math.round(bigPx * fitK);
  smallPx = Math.max(Math.round(smallPx * fitK), 28);
  flatPx = Math.round(flatPx * fitK);

  // Tight leading (-11% tinggi baris) agar baris atas & bawah sangat dekat seperti "what you're / capable"
  const gap = Math.round(-basePx * 0.11 * fitK);
  const blockW = Math.max(...rows.map(rowW));
  const cx = o.cx || 540;
  const blockStartX = Math.max(80, Math.min(1080 - 80 - blockW, cx - blockW / 2));

  // Variasi palet warna & animasi dari JSON (1_Blur_Up, 1_Basic_Up, 2.Light_Zoom In)
  const animPreset = Math.floor(r() * 3);
  const slidePalette = Math.floor(r() * 3);
  // 0: Teks Putih Bersih (#FFFFFF) + Keyword Deep Navy Blue persis referensi (#061E5C)
  // 1: Teks Putih Bersih (#FFFFFF) + Transisi Cahaya Oranye Glow (#FF8C24)
  // 2: Semua Teks Putih Bersih (#FFFFFF)
  const isSingleDifference = (layoutMode === 0);

  const createWordEl = (it, x, y, t) => {
    const px = pxOf(it);
    const font = fontOf(it);
    const isKey = (it.role === 'key');

    let color = '#FFFFFF';
    let oc = '#FFFFFF';
    let sd = 0;
    let shade = false;

    if (!isSingleDifference) {
      if (slidePalette === 0) {
        color = isKey ? '#061E5C' : '#FFFFFF';
        oc = isKey ? '#061E5C' : '#FFFFFF';
      } else if (slidePalette === 1) {
        color = isKey ? '#FF8C24' : '#FFFFFF';
        oc = isKey ? '#FF8C24' : '#FFFFFF';
        if (isKey) {
          sd = 14;
          shade = true;
        }
      } else {
        color = '#FFFFFF';
        oc = '#FFFFFF';
      }
    }

    const el = {
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp: TRACK * px,
      color,
      oc,
      ow: 0,
      sd,
      shade,
      x,
      y,
      rot: 0
    };

    // Aktifkan Subtract (Difference) khusus pada mode 1-kata tunggal di atas footage
    if (isSingleDifference) {
      el.blendMode = 'difference';
    }

    // Parameter matematis dari JSON (1_Blur_Up, 1_Basic_Up, 2.Light_Zoom In) + Blur Out serentak
    const yOffset = Math.round(px * (isKey ? 0.55 : 0.42));
    const durIn = isKey ? 230 : 185;
    const outStart = Math.max(t + durIn + 60, durTotal - 160);

    if (animPreset === 0) {
      // 1_Blur_Up: Blur Fade-In + Rebound Up + Blur Out
      const blur0 = isKey ? 18 : 12;
      el.keys = [
        { t: 0,                a: 0, blur: blur0, x, y: y + yOffset, sx: 100, sy: 100 },
        { t,                   a: 0, blur: blur0, x, y: y + yOffset, sx: 100, sy: 100 },
        { t: t + durIn * 0.75, a: 1, blur: 2,     x, y: y - 4,       sx: 100, sy: 100 },
        { t: t + durIn,        a: 1, blur: 0,     x, y: y,           sx: 100, sy: 100 },
        { t: outStart,         a: 1, blur: 0,     x, y: y,           sx: 100, sy: 100 },
        { t: durTotal,         a: 0, blur: 14,    x, y: y - 6,       sx: 100, sy: 100 }
      ];
    } else if (animPreset === 1) {
      // 1_Basic_Up: Clean Slide Up + Rebound Out + Blur Out
      el.keys = [
        { t: 0,                a: 0, blur: 4,  x, y: y + yOffset, sx: 100, sy: 100 },
        { t,                   a: 0, blur: 4,  x, y: y + yOffset, sx: 100, sy: 100 },
        { t: t + durIn * 0.72, a: 1, blur: 0,  x, y: y - 5,       sx: 100, sy: 100 },
        { t: t + durIn,        a: 1, blur: 0,  x, y: y,           sx: 100, sy: 100 },
        { t: outStart,         a: 1, blur: 0,  x, y: y,           sx: 100, sy: 100 },
        { t: durTotal,         a: 0, blur: 14, x, y: y - 6,       sx: 100, sy: 100 }
      ];
    } else {
      // 2.Light_Zoom In: Circular Ease Scale Zoom In + Blur Out
      const s0 = isKey ? 72 : 82;
      const sPeak = isKey ? 103 : 101;
      el.keys = [
        { t: 0,                a: 0, blur: 10, x, y: y + 10, sx: s0,    sy: s0 },
        { t,                   a: 0, blur: 10, x, y: y + 10, sx: s0,    sy: s0 },
        { t: t + durIn * 0.75, a: 1, blur: 0,  x, y: y,      sx: sPeak, sy: sPeak },
        { t: t + durIn,        a: 1, blur: 0,  x, y: y,      sx: 100,   sy: 100 },
        { t: outStart,         a: 1, blur: 0,  x, y: y,      sx: 100,   sy: 100 },
        { t: durTotal,         a: 0, blur: 14, x, y: y,      sx: 96,    sy: 96 }
      ];
    }

    return el;
  };

  const els = [];
  let y = o.top;

  rows.forEach((row) => {
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;

    if (row.length === 2 && row[0].splitTop) {
      // Split Top persis referensi: "what" di ujung kiri blok, "you're" di ujung kanan blok sejajar kata besar di bawah
      const w0 = wOf(row[0]);
      const w1 = wOf(row[1]);
      const baseOff0 = (h - pxOf(row[0])) * 0.35;
      const baseOff1 = (h - pxOf(row[1])) * 0.35;
      els.push(createWordEl(row[0], blockStartX + w0 / 2, cy + baseOff0, times[row[0].idx]));
      els.push(createWordEl(row[1], blockStartX + blockW - w1 / 2, cy + baseOff1, times[row[1].idx]));
    } else if (row.length === 1 && row[0].align === 'right') {
      const ww = wOf(row[0]);
      const baseOff = (h - pxOf(row[0])) * 0.35;
      els.push(createWordEl(row[0], blockStartX + blockW - ww / 2, cy + baseOff, times[row[0].idx]));
    } else {
      let x = isSingleDifference ? (cx - rowW(row) / 2) : blockStartX;
      row.forEach((it) => {
        const ww = wOf(it);
        const baseOff = (h - pxOf(it)) * 0.35;
        els.push(createWordEl(it, x + ww / 2, cy + baseOff, times[it.idx]));
        x += ww + spaceOf(it);
      });
    }

    y += h + gap;
  });

  return { elements: els, box: { top: o.top, bottom: y - gap } };
}

// ---- preset: EditorialTightSans.txt
// Nama Gaya Sosmed: Minimalist Tight-Tracking Sans / Editorial Helvetica Subtract Caption
// Karakteristik: 1-4 baris bertumpuk (stacked hierarchy), skala ekstrem antara keyword & kata pendukung, 100% Bold dengan tight tracking (-0.055em), tanpa drop shadow, muncul halus dari bawah dengan soft fade & blur.
// Font Wajib: 'Helvetica Neue Bold'
// Mode Blend: SUBTRACT (aktifkan inverse_auto / .style-inverse_auto)
// Chunk: 1-5

function capEditorialTightSans(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorialTight|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_BOLD = 'Helvetica Neue Bold';
  const TRACK = -0.055;
  const MAXW = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  // Kontras ukuran ekstrem dengan ketebalan yang sama (semua Bold)
  let bigPx = Math.round(basePx * 1.35);
  let smallPx = Math.max(Math.round(basePx * 0.42), 30);

  // Tentukan kata mana saja yang menjadi penekanan besar (keyword / angka / kata panjang >= 7 huruf)
  const isBigWord = (word, idx) => {
    const clean = word.replace(/[^a-zA-Z0-9]/g, '');
    if (idx === ki) return true;
    if (/^\d+$/.test(clean)) return true;
    if (raw.length >= 4 && clean.length >= 7) return true;
    return false;
  };

  // Susun tata letak dinamis 1-4 baris mengikuti pola video referensi
  const rows = [];
  if (raw.length === 1) {
    // 1 Kata Tunggal (Single Word Punch: "should", "number", "storytelling")
    rows.push([{ word: raw[0], idx: 0, big: true }]);
  } else if (raw.length === 2) {
    // 2 Kata bertumpuk ("number / two", "single / clip", "easy / association")
    const b0 = isBigWord(raw[0], 0);
    const b1 = isBigWord(raw[1], 1);
    if (b0 && b1) {
      rows.push([{ word: raw[0], idx: 0, big: true }]);
      rows.push([{ word: raw[1], idx: 1, big: true }]);
    } else {
      rows.push([{ word: raw[0], idx: 0, big: b0 }]);
      rows.push([{ word: raw[1], idx: 1, big: !b0 ? true : b1 }]);
    }
  } else if (raw.length === 3) {
    // Pola 3 kata: "This [5] is" sejajar 1 baris atau 2 baris bertumpuk ("single clip / B-roll")
    if (ki === 1 && raw[0].length <= 4 && raw[2].length <= 4) {
      rows.push([
        { word: raw[0], idx: 0, big: false },
        { word: raw[1], idx: 1, big: true },
        { word: raw[2], idx: 2, big: false }
      ]);
    } else if (ki === 0) {
      rows.push([{ word: raw[0], idx: 0, big: true }]);
      rows.push([
        { word: raw[1], idx: 1, big: false },
        { word: raw[2], idx: 2, big: false }
      ]);
    } else {
      rows.push([
        { word: raw[0], idx: 0, big: false },
        { word: raw[1], idx: 1, big: false }
      ]);
      rows.push([{ word: raw[2], idx: 2, big: true }]);
    }
  } else {
    // Pola 4-5+ kata bertingkat seperti "follow / for more / branding / content"
    let currentRow = [];
    raw.forEach((word, idx) => {
      const big = isBigWord(word, idx);
      if (big) {
        if (currentRow.length) {
          rows.push(currentRow);
          currentRow = [];
        }
        rows.push([{ word, idx, big: true }]);
      } else {
        currentRow.push({ word, idx, big: false });
        if (currentRow.length >= 2) {
          rows.push(currentRow);
          currentRow = [];
        }
      }
    });
    if (currentRow.length) rows.push(currentRow);
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const wOf = (it) => widthPx(it.word, FONT_BOLD, pxOf(it)) * (1 + TRACK);
  const spaceW = (it) => widthPx(' ', FONT_BOLD, pxOf(it)) * 0.72;
  const rowW = (row) =>
    row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  // Auto-fit terhadap batas lebar aman kanvas (MAXW = 860)
  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const fitScale = Math.min(1, MAXW / maxRowWidth);
  bigPx *= fitScale;
  smallPx *= fitScale;

  // Tight leading (jarak vertikal antar baris sangat rapat)
  const gap = Math.round(-basePx * 0.14 * fitScale);
  const blockW = Math.max(...rows.map(rowW));
  const cx = o.cx || 540;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  // Variasi gerakan halus sesuai video asli: dominan Slide-Up pendek + Soft Fade/Blur (1_Basic_Up & 1_Blur_Up)
  const animVariant = Math.floor(r() * 2);

  const buildWordElement = (w, px, x, y, t, isBig) => {
    const el = {
      kind: 'text',
      text: w,
      font: FONT_BOLD,
      px,
      fsp: TRACK * px,
      color: '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      blendMode: 'difference',
      x,
      y,
      rot: 0
    };

    // Pergeseran naik halus dan pendek (35px - 55px) tanpa scale overshoot
    const offsetY = isBig ? (animVariant === 0 ? 52 : 38) : 28;
    const startY = y + offsetY;
    const startSx = isBig && animVariant === 1 ? 92 : 100;
    const startSy = isBig && animVariant === 1 ? 92 : 100;
    const startBlur = isBig ? 8 : 4;
    const animDur = isBig ? 210 : 170;

    // Kurva ease-out mulus (cepat keluar lalu mendarat lembut tanpa pantulan)
    const midT = t + Math.round(animDur * 0.45);
    const midY = y + offsetY * 0.2;
    const midSx = 100 + (startSx - 100) * 0.2;
    const midSy = 100 + (startSy - 100) * 0.2;
    const midBlur = Math.round(startBlur * 0.2);

    el.keys = [
      { t: 0,           a: 0,   blur: startBlur, x, y: startY, sx: startSx, sy: startSy },
      { t,              a: 0,   blur: startBlur, x, y: startY, sx: startSx, sy: startSy },
      { t: midT,        a: 0.9, blur: midBlur,   x, y: midY,   sx: midSx,   sy: midSy },
      { t: t + animDur, a: 1,   blur: 0,         x, y: y,      sx: 100,     sy: 100 }
    ];

    return el;
  };

  const els = [];
  let y = o.top;

  rows.forEach((row) => {
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    const currentRowW = rowW(row);
    // Rata tengah (center-aligned) per baris
    let x = blockStartX + (blockW - currentRowW) / 2;

    row.forEach((it) => {
      const ww = wOf(it);
      // Penyelarasan baseline/bawah agar kata kecil ("This", "is") sejajar rapi dengan kata besar ("5")
      const baselineOffset = (h - pxOf(it)) * 0.36;
      els.push(
        buildWordElement(
          it.word,
          pxOf(it),
          x + ww / 2,
          cy + baselineOffset,
          times[it.idx],
          it.big
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: o.top, bottom: y - gap } };
}
// ---- preset: ImanStackedGlow.txt
// Nama Gaya Sosmed: Iman Gadzhi Stacked Glow / Editorial Multi-Line Neon Hierarchy
// Karakteristik: Layout dinamis 1-3 baris bertumpuk rapat (tight leading), tracking rapat (-1 CapCut), kombinasi Sans Bold + Sans Regular + Serif Regular/Italic, warna neon berpendar (Magenta, Chartreuse Yellow + White Split, Warm Orange) dengan baris ke-3 menjorok rata kanan.
// Font Wajib: 'Helvetica Neue Bold', 'Helvetica Neue Regular', 'Georgia', 'Instrument Serif Italic'
// Mode Blend: NORMAL (Solid + Colored Outer Glow, tanpa Subtract/Difference)
// Chunk: 1-5

function capImanStackedGlow(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`imanStackedGlowV2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 4 Role Tipografi sesuai hasil bedah frame video:
  const FONT_KEY_BOLD     = 'Helvetica Neue Bold';     // Kata utama besar ("ownership", "great", "happens")
  const FONT_SUP_REG      = 'Helvetica Neue Regular';  // Kata pendukung standar ("Take", "Something", "of your")
  const FONT_TOP_SERIF    = 'Georgia';                 // Variasi baris atas serif tegak ("You can take")
  const FONT_END_ITALIC   = 'Instrument Serif Italic'; // Kata penutup akhir miring ("life.")

  // Kerapatan huruf (Tracking -1 di CapCut -> huruf sangat rapat/hampir menempel)
  const TRACK_BIG   = -0.058;
  const TRACK_SMALL = -0.035;
  const MAXW = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  let bigPx = Math.round(basePx * 1.46);
  let smallPx = Math.max(Math.round(basePx * 0.60), 34);

  // 3 Tema Warna Neon Exact dari Video Referensi:
  // 0: Neon Magenta (#E82BFF + glow #D500F9)
  // 1: Neon Chartreuse Yellow (#E4FF00 + glow #C6FF00) + pasangan kata besar putih solid
  // 2: Warm Sunset Orange (#FF6B00 + glow #FF3D00) + variasi baris atas Serif tegak
  const themeIdx = Math.floor(r() * 3);
  const NEON_THEMES = [
    { color: '#E82BFF', glow: '#D500F9' },
    { color: '#E4FF00', glow: '#C6FF00' },
    { color: '#FF6B00', glow: '#FF3D00' }
  ];
  const activeTheme = NEON_THEMES[themeIdx];

  // Cek apakah ada 2 kata besar berdampingan di baris tengah (pola "great happens" atau "bad happens")
  const hasPairedBig =
    raw.length >= 4 &&
    ki > 0 &&
    ki + 1 < raw.length - 1;
  const flipPairedColor = r() > 0.5; // true: [Putih, Kuning Glow] ("bad happens"), false: [Kuning Glow, Putih] ("great happens")

  // Susun baris (1 hingga 3 baris bertumpuk)
  const rows = [];
  if (raw.length === 1) {
    // Mode 1 kata tunggal penuh ("Responsibility")
    rows.push([{ word: raw[0], idx: 0, role: 'keyword' }]);
  } else if (raw.length === 2) {
    if (ki === 0) {
      rows.push([{ word: raw[0], idx: 0, role: 'keyword' }]);
      rows.push([{ word: raw[1], idx: 1, role: 'support' }]);
    } else {
      rows.push([{ word: raw[0], idx: 0, role: 'support' }]);
      rows.push([{ word: raw[1], idx: 1, role: 'keyword' }]);
    }
  } else if (ki === 0) {
    rows.push([{ word: raw[0], idx: 0, role: 'keyword' }]);
    rows.push(raw.slice(1).map((w, i, arr) => ({
      word: w,
      idx: i + 1,
      role: i === arr.length - 1 ? 'end_italic' : 'support'
    })));
  } else if (ki === raw.length - 1) {
    // Pola 2 baris bertumpuk ("You can take" di atas -> "responsibility" besar di bawah)
    rows.push(raw.slice(0, ki).map((w, i) => ({
      word: w,
      idx: i,
      role: themeIdx === 2 ? 'top_serif' : 'support'
    })));
    rows.push([{ word: raw[ki], idx: ki, role: 'keyword' }]);
  } else {
    // Pola 3 baris bertumpuk ("Take" -> "ownership" -> "of your life")
    const midEnd = hasPairedBig ? ki + 1 : ki;
    rows.push(raw.slice(0, ki).map((w, i) => ({
      word: w,
      idx: i,
      role: 'support'
    })));

    if (hasPairedBig) {
      rows.push([
        { word: raw[ki],     idx: ki,     role: flipPairedColor ? 'keyword_white' : 'keyword' },
        { word: raw[ki + 1], idx: ki + 1, role: flipPairedColor ? 'keyword' : 'keyword_white' }
      ]);
    } else {
      rows.push([{ word: raw[ki], idx: ki, role: 'keyword' }]);
    }

    rows.push(raw.slice(midEnd + 1).map((w, i, arr) => ({
      word: w,
      idx: midEnd + 1 + i,
      // Kata paling akhir memakai Serif Italic halus seperti kata "life." di frame 00:02.75
      role: i === arr.length - 1 ? 'end_italic' : 'support'
    })));
  }

  const isBigRole = (role) => role === 'keyword' || role === 'keyword_white';
  const pxOf = (it) => {
    if (isBigRole(it.role)) return bigPx;
    if (it.role === 'end_italic') return Math.round(smallPx * 1.08);
    if (it.role === 'top_serif') return Math.round(smallPx * 1.04);
    return smallPx;
  };
  const fontOf = (it) => {
    if (isBigRole(it.role)) return FONT_KEY_BOLD;
    if (it.role === 'top_serif') return FONT_TOP_SERIF;
    if (it.role === 'end_italic') return FONT_END_ITALIC;
    return FONT_SUP_REG;
  };
  const trackOf = (it) => (isBigRole(it.role) ? TRACK_BIG : TRACK_SMALL);
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * (isBigRole(it.role) ? 0.68 : 0.80);
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  // Auto-fit terhadap batas lebar aman kanvas MAXW = 860
  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const scaleFit = Math.min(1, MAXW / maxRowWidth);
  bigPx *= scaleFit;
  smallPx *= scaleFit;

  const blockW = Math.max(...rows.map(rowW));
  const cx = o.cx || 540;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  // Jarak antar baris sangat rapat (leading negatif agar baris menempel padat seperti di video)
  const gap = Math.round(-basePx * 0.17 * scaleFit);

  // Ekstraksi kurva keyframe dari 1_Blur_Up.json & 3_Right_Basic.json
  const buildWordElement = (it, xCenter, yCenter, tStart, rowIdx) => {
    const big = isBigRole(it.role);
    const px = pxOf(it);
    const font = fontOf(it);
    const track = trackOf(it);

    let startX = xCenter;
    let startY = yCenter;
    let blur0 = big ? 14 : 8;
    let animDur = big ? 230 : 185;

    if (big) {
      // Kurva 1_Blur_Up.json: naik vertikal pendek dari bawah dengan blur fade-in cepat
      startY = yCenter + Math.round(46 * scaleFit);
    } else if (rowIdx === 0) {
      // Baris pengantar atas ("Take", "Something", "Radical"): muncul lembut di tempat / naik sangat tipis
      startY = yCenter + Math.round(14 * scaleFit);
      blur0 = 10;
    } else {
      // Baris penutup bawah ("of your life", "on your life."): geser halus kiri-ke-kanan (3_Right_Basic.json)
      startX = xCenter - Math.round(36 * scaleFit);
      blur0 = 6;
    }

    // Warna & Outer Glow sesuai role kata
    let textColor = '#FFFFFF';
    let glowColor = '#000000';
    let shadowBlur = 10;

    if (it.role === 'keyword') {
      textColor = activeTheme.color;
      glowColor = activeTheme.glow;
      shadowBlur = 28; // Pendaran cahaya neon lebar khas video
    } else if (it.role === 'keyword_white') {
      textColor = '#FFFFFF';
      glowColor = '#000000';
      shadowBlur = 12;
    }

    // Rasio percepatan alpha dari 1_Blur_Up.json (right_control.y = 0.89 di ~34% durasi)
    const midT = tStart + Math.round(animDur * 0.34);

    return {
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp: track * px,
      color: textColor,
      oc: glowColor,
      ow: 0,
      sd: shadowBlur,
      shade: true,
      x: xCenter,
      y: yCenter,
      rot: 0,
      keys: [
        { t: 0,                a: 0,    blur: blur0,                    x: startX, y: startY, sx: 102, sy: 102 },
        { t: tStart,           a: 0,    blur: blur0,                    x: startX, y: startY, sx: 102, sy: 102 },
        { t: midT,             a: 0.89, blur: Math.round(blur0 * 0.30), x: xCenter + (startX - xCenter) * 0.18, y: yCenter + (startY - yCenter) * 0.18, sx: 100.4, sy: 100.4 },
        { t: tStart + animDur, a: 1,    blur: 0,                        x: xCenter, y: yCenter, sx: 100, sy: 100 }
      ]
    };
  };

  const els = [];
  let y = o.top || 780;
  const keywordRowWidth = rows.length >= 2 ? rowW(rows[rows.length === 3 ? 1 : rows.length - 1]) : blockW;

  rows.forEach((row, rIdx) => {
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    const currentW = rowW(row);

    // Penempatan asimetris bertingkat persis seperti di video:
    let x = blockStartX;
    if (rows.length === 1) {
      // 1 baris tunggal ("Responsibility"): center terhadap cx
      x = cx - currentW / 2;
    } else if (rows.length === 3 && rIdx === 2) {
      // Baris ke-3 ("of your life" / "on your life."): rata kanan sejajar ujung kanan keyword baris 2
      const targetRightEdge = blockStartX + Math.max(keywordRowWidth, currentW);
      x = Math.max(blockStartX + 32 * scaleFit, targetRightEdge - currentW);
    } else if (rows.length === 2 && rIdx === 0 && !isBigRole(row[0].role)) {
      // Baris atas pada layout 2 baris ("You can take" di atas "responsibility"): geser sedikit ke tengah
      x = blockStartX + Math.max(0, (blockW - currentW) * 0.24);
    }

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.36;
      els.push(
        buildWordElement(
          it,
          x + ww / 2,
          cy + baselineOffset,
          times[it.idx],
          rIdx
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return {
    elements: els,
    box: { top: o.top || 780, bottom: y - gap }
  };
}
// ---- preset: KineticSandwich.txt
// Nama Gaya Sosmed: Kinetic Anchor Overlap / Iman Gadzhi Retention Captions
// Karakteristik: Keyword raksasa muncul duluan sebagai jangkar dengan tracking rapat (-1 CapCut) & glow halus, lalu kata pendukung tipis menempel/menumpuk asimetris di atas, bawah, samping, atau di layer depan keyword
// Font Wajib: 'Helvetica Neue Bold' (Keyword) dan 'Helvetica Neue Regular' (Kata Pendukung)
// Mode Blend: Normal (tidak menggunakan Subtract/Difference; menggunakan warna solid kontras dengan soft glow/shadow)
// Chunk: 1-4

function capKineticAnchorOverlap(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`kineticOverlapV2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_BOLD = 'Helvetica Neue Bold';
  const FONT_REG  = 'Helvetica Neue Regular';
  // Kerapatan huruf setara CapCut -1 s/d -2
  const TRACK_BIG = -0.055;
  const TRACK_SM  = -0.035;
  const MAXW      = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  // Kontras ukuran ekstrem sesuai video (~2.5x lebih besar untuk keyword utama)
  let bigPx   = Math.round(basePx * 1.52);
  let smallPx = Math.max(Math.round(basePx * 0.54), 32);

  // Pilih tema warna berdasarkan visual video referensi:
  // 0: Royal Electric Blue (#0A66FF) + glow biru lembut (dominan di video: Best, getting, BOOST, CTR, Trigger)
  // 1: Crimson Deep Red (#C81D18) + glow merah gelap (gaya klimaks belakang: VIRAL)
  // 2: Pure White (#FFFFFF) + soft dark shadow (gaya di atas layar biru: Writing, Ultimately)
  const colorRoll = r();
  let kwColor = '#0A66FF';
  let kwGlow  = '#003D99';
  let kwSd    = 12;

  if (colorRoll > 0.78) {
    kwColor = '#C81D18';
    kwGlow  = '#5E0606';
    kwSd    = 14;
  } else if (colorRoll > 0.60) {
    kwColor = '#FFFFFF';
    kwGlow  = '#000000';
    kwSd    = 6;
  }

  // Pilih salah satu dari 4 pola tata letak asli yang muncul di video:
  // Mode 0 (Asymmetric Top/Bottom Overlap - "Best / ways / to start", "Trigger / the / algorithm"):
  //   Keyword raksasa di tengah, kata pendukung menempel rapat/memotong tepi atas kanan & bawah keyword
  // Mode 1 (Side-Flush + Top-Right Cap - "more | getting / views"):
  //   Kata sebelum keyword sejajar di samping kiri, kata setelah keyword menempel di atas kanan
  // Mode 2 (Left-Aligned Editorial Stack - "Which can / BOOST", "on / VIDEOS / your"):
  //   Rata kiri dengan keyword ALL CAPS biru + kata pendukung menempel di atas/bawah
  // Mode 3 (Foreground Sub-Phrase over Monumental Backdrop Keyword - "potentially go" di depan + "VIRAL" raksasa di belakang):
  //   Kata pendukung berjajar 1 baris horizontal di layer depan menutupi bagian tengah keyword raksasa di belakang
  let layoutMode = 0;
  if (raw.length === 1) {
    layoutMode = 0;
  } else {
    const mRoll = r();
    if (mRoll < 0.38) layoutMode = 0;
    else if (mRoll < 0.62) layoutMode = 1;
    else if (mRoll < 0.84) layoutMode = 2;
    else layoutMode = 3;
  }

  // Paksa tema merah gelap jika masuk ke Mode 3 agar identik dengan adegan "potentially go / VIRAL"
  if (layoutMode === 3 && colorRoll > 0.45) {
    kwColor = '#C81D18';
    kwGlow  = '#4A0404';
    kwSd    = 14;
  }

  const kwWordRaw = raw[ki];
  const preWords  = raw.slice(0, ki).map((w, i) => ({ word: w, idx: i, big: false }));
  const postWords = raw.slice(ki + 1).map((w, i) => ({ word: w, idx: ki + 1 + i, big: false }));
  const subWords  = [...preWords, ...postWords];

  // Kapitalisasi ALL CAPS pada kata kunci pendek berdaya ledak tinggi (BOOST, CTR, VIDEOS, VIRAL)
  const makeCaps =
    layoutMode === 2 ||
    layoutMode === 3 ||
    (kwWordRaw.length <= 6 && r() > 0.55);
  const kwText = makeCaps ? kwWordRaw.toUpperCase() : kwWordRaw;

  if (layoutMode === 3) {
    bigPx = Math.round(bigPx * 1.25);
  }

  const wBig = (txt, px) => widthPx(txt, FONT_BOLD, px) * (1 + TRACK_BIG);
  const wSm  = (txt, px) => widthPx(txt, FONT_REG, px) * (1 + TRACK_SM);
  const spSm = (px) => widthPx(' ', FONT_REG, px) * 0.68;

  // Hitung estimasi lebar blok untuk Auto-Fit MAXW = 860
  let estBlockW = wBig(kwText, bigPx);
  if (layoutMode === 1 && preWords.length) {
    const preW = preWords.reduce((a, it, j) => a + wSm(it.word, smallPx) + (j ? spSm(smallPx) : 0), 0);
    estBlockW += preW + spSm(smallPx) * 0.9;
  } else if (layoutMode === 3 && subWords.length) {
    const subLineW = subWords.reduce((a, it, j) => a + wSm(it.word, smallPx) + (j ? spSm(smallPx) : 0), 0);
    estBlockW = Math.max(estBlockW, subLineW);
  }

  const k = Math.min(1, MAXW / Math.max(estBlockW, 1));
  bigPx   *= k;
  smallPx *= k;

  const finalKwW = wBig(kwText, bigPx);
  const cx = layoutMode === 2 ? Math.min(o.cx || 540, 380) : (o.cx || 540);
  const baseTop = o.top || 780;

  // Variasi animasi dari ekstraksi JSON:
  // bigMode: 0 = 1_Blur_Up (Y +115px -> 0, Rebound Out), 1 = 1_Blur_Down (Y -110px -> 0, Rebound Out), 2 = 2.Light_Zoom In (Scale 44% -> 100%, Circular Ease)
  const bigMode   = Math.floor(r() * 3);
  // smallMode: 0 = 3_Left_Hazy (X +150px -> 0, Circular Ease), 1 = 3_Right_Hazy (X -140px -> 0, Circular Ease)
  const smallMode = Math.floor(r() * 2);

  const kwTime = times[ki];

  const buildEl = (txt, isBig, x, y, t, zFront) => {
    const font  = isBig ? FONT_BOLD : FONT_REG;
    const px    = isBig ? bigPx : smallPx;
    const track = isBig ? TRACK_BIG : TRACK_SM;

    const el = {
      kind: 'text',
      text: txt,
      font,
      px,
      fsp: track * px,
      color: isBig ? kwColor : '#FFFFFF',
      oc: isBig ? kwGlow : '#000000',
      ow: 0,
      sd: isBig ? kwSd : 4,
      shade: true,
      x,
      y,
      rot: 0
    };

    let startX = x;
    let startY = y;
    let startScale = 100;
    let blur0 = isBig ? 18 : 11;
    let animDur = isBig ? 200 : 170;

    if (isBig) {
      if (bigMode === 0) {
        // 1_Blur_Up (KFTypePositionY -0.1258 -> 0 + Blur Fade-In)
        startY = y + Math.round(115 * k);
        startScale = 96;
      } else if (bigMode === 1) {
        // 1_Blur_Down (KFTypePositionY 0.1212 -> 0 + Blur Fade-In)
        startY = y - Math.round(110 * k);
        startScale = 96;
      } else {
        // 2.Light_Zoom In (KFTypeScaleX 0.404 -> 1.22 + Firefly River-In)
        startScale = 44;
        blur0 = 14;
        animDur = 220;
      }
    } else {
      if (smallMode === 0) {
        // 3_Left_Hazy (KFTypePositionX 0.8157 -> 0 + Hazy Drop)
        startX = x + Math.round(150 * k);
        startScale = 112;
      } else {
        // 3_Right_Hazy (KFTypePositionX -0.7701 -> 0 + Hazy Drop)
        startX = x - Math.round(140 * k);
        startScale = 112;
      }
    }

    const midT  = Math.round(t + animDur * 0.72);
    const endT  = t + animDur;
    const overX = isBig ? x : x + (x - startX) * 0.04;
    const overY = isBig && bigMode < 2 ? y + (y - startY) * 0.05 : y;
    const overS = isBig && bigMode === 2 ? 103 : 100;

    el.keys = [
      { t: 0,    a: 0,    blur: blur0, x: startX, y: startY, sx: startScale, sy: startScale },
      { t,       a: 0,    blur: blur0, x: startX, y: startY, sx: startScale, sy: startScale },
      { t: midT, a: 0.94, blur: 2,     x: overX,  y: overY,  sx: overS,      sy: overS },
      { t: endT, a: 1,    blur: 0,     x: x,      y: y,      sx: 100,        sy: 100 }
    ];

    return { el, zFront };
  };

  const items = [];
  let minTop = baseTop;
  let maxBot = baseTop + bigPx;

  const placeSubRow = (list, anchorCenterX, rowCenterY, alignMode, delayBase) => {
    if (!list.length) return;
    const rowW = list.reduce((a, it, j) => a + wSm(it.word, smallPx) + (j ? spSm(smallPx) : 0), 0);
    let curX = anchorCenterX - rowW / 2;
    if (alignMode === 'left') curX = anchorCenterX;
    if (alignMode === 'right') curX = anchorCenterX - rowW;

    list.forEach((it, idx) => {
      const ww = wSm(it.word, smallPx);
      const t = Math.max(times[it.idx], kwTime + delayBase + idx * 55);
      items.push(buildEl(it.word, false, curX + ww / 2, rowCenterY, t, true));
      curX += ww + spSm(smallPx);
    });
    minTop = Math.min(minTop, rowCenterY - smallPx * 0.6);
    maxBot = Math.max(maxBot, rowCenterY + smallPx * 0.6);
  };

  if (layoutMode === 0) {
    // Pola 0: Keyword raksasa di tengah ("Best" / "Trigger"), kata pendukung menempel rapat di atas-kanan & bawah-tengah
    const kwX = Math.max(55 + finalKwW / 2, Math.min(1080 - 55 - finalKwW / 2, cx));
    const kwY = baseTop + bigPx * 0.55;
    items.push(buildEl(kwText, true, kwX, kwY, kwTime, false));

    // Kata sebelum keyword menempel tepat di tepi atas kanan keyword (seperti "ways" di atas "Best")
    placeSubRow(preWords, kwX + finalKwW * 0.46, kwY - bigPx * 0.44, 'right', 90);
    // Kata setelah keyword menempel tepat di bawah memotong baseline keyword (seperti "to start" / "the algorithm")
    placeSubRow(postWords, kwX + finalKwW * 0.05, kwY + bigPx * 0.44, 'center', 135);

  } else if (layoutMode === 1) {
    // Pola 1: Kata sebelum keyword sejajar di samping kiri ("more"), keyword raksasa di kanan ("getting"), kata setelahnya menempel di atas kanan ("views")
    const preW = preWords.reduce((a, it, j) => a + wSm(it.word, smallPx) + (j ? spSm(smallPx) : 0), 0);
    const totalW = (preW ? preW + spSm(smallPx) * 0.8 : 0) + finalKwW;
    const blockStartX = Math.max(55, Math.min(1080 - 55 - totalW, cx - totalW / 2));

    const kwY = baseTop + bigPx * 0.55;
    const kwX = blockStartX + (preW ? preW + spSm(smallPx) * 0.8 : 0) + finalKwW / 2;
    items.push(buildEl(kwText, true, kwX, kwY, kwTime, false));

    if (preWords.length) {
      placeSubRow(preWords, blockStartX, kwY + bigPx * 0.04, 'left', 85);
    }
    if (postWords.length) {
      placeSubRow(postWords, kwX + finalKwW * 0.48, kwY - bigPx * 0.43, 'right', 130);
    }

  } else if (layoutMode === 2) {
    // Pola 2: Side-stack rata kiri ("Which can / BOOST" atau "on / VIDEOS / your")
    const blockStartX = Math.max(60, Math.min(1080 - 60 - finalKwW, cx - finalKwW / 2));
    const kwY = baseTop + (preWords.length ? smallPx * 0.75 : 0) + bigPx * 0.5;
    items.push(buildEl(kwText, true, blockStartX + finalKwW / 2, kwY, kwTime, false));

    placeSubRow(preWords, blockStartX, kwY - bigPx * 0.54, 'left', 85);
    placeSubRow(postWords, blockStartX + finalKwW * 0.55, kwY + bigPx * 0.48, 'center', 130);

  } else {
    // Pola 3: Keyword monumental di layer belakang ("VIRAL"), kata pendukung berjajar 1 baris horizontal di layer depan ("potentially go")
    const kwX = Math.max(55 + finalKwW / 2, Math.min(1080 - 55 - finalKwW / 2, cx));
    const kwY = baseTop + bigPx * 0.55;
    items.push(buildEl(kwText, true, kwX, kwY, kwTime, false));

    placeSubRow(subWords, kwX, kwY - bigPx * 0.04, 'center', 75);
  }

  // Render Z-Index: Keyword di belakang (zFront: false), kata pendukung di depan (zFront: true)
  const els = [
    ...items.filter((it) => !it.zFront).map((it) => it.el),
    ...items.filter((it) => it.zFront).map((it) => it.el)
  ];

  return {
    elements: els,
    box: {
      top: Math.round(minTop),
      bottom: Math.round(maxBot)
    }
  };
}
// ---- preset: SwissKineticImpact.txt
// Nama Gaya Sosmed: Nero Editorial Mixed-Typography / Dynamic Multi-Mode Captions
// Karakteristik: 3 pola tata letak dinamis (1. Stacked keyword raksasa + pendukung rata kiri atas; 2. Stacked keyword Sans Bold atas + aksen Serif Italic bawah; 3. 1 baris berjarak kata lebar), all-lowercase, tight tracking (-0.055 pada Sans Bold), palet Putih & Biru Dongker (#0A2463).
// Font Wajib: 'Helvetica Neue Bold' dan 'Instrument Serif Italic'
// Mode Blend: Normal (mendukung warna aksen #0A2463 dan #FFFFFF bersih; tanpa stroke/bayangan kasar)
// Chunk: 1-4

function capNeroEditorial(text, o = {}) {
  const rawOrig = text.trim().split(/\s+/).filter(Boolean);
  if (!rawOrig.length) return { elements: [], box: null };

  // All lowercase sesuai referensi, pertahankan kapitalisasi hanya untuk kata ganti tunggal "I"
  const raw = rawOrig.map((w) => (w === 'I' || w === "I'm" || w === "I'll" || w === "I've" ? w : w.toLowerCase()));
  const cleanKey = raw.join(' ');

  const r = typeof rng === 'function' ? rng(`nero_editorial|${cleanKey}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_BOLD = 'Helvetica Neue Bold';
  const FONT_SERIF_IT = 'Instrument Serif Italic';

  const TRACK_BOLD = -0.055; // Rapat (setara -1 sampai -2 di CapCut, seperti "smartest" & "absolute")
  const TRACK_SERIF = -0.015; // Natural agar ekor huruf miring serif tidak bertabrakan (seperti "certainty")
  const MAXW = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  let bigPx = Math.round(basePx * 1.35);
  let smallSansPx = Math.max(Math.round(basePx * 0.50), 34);
  let smallSerifPx = Math.max(Math.round(basePx * 0.54), 36);
  let wideRowPx = Math.max(Math.round(basePx * 0.68), 44);

  // Tentukan 1 dari 3 mode tata letak berdasarkan struktur kata & referensi visual:
  // Mode 0: Stacked Top-Support + Bottom-Keyword (contoh: "the" kecil rata kiri di atas "smartest" besar)
  // Mode 1: Stacked Top-Keyword Sans Bold + Bottom-Accent Serif Italic (contoh: "absolute" besar + "certainty" serif italic rata tengah di bawah)
  // Mode 2: 1 Baris Wide-Spaced / Single Focus (contoh: "want   to   know" berjarak kata lebar, atau 1 kata tunggal)
  let layoutMode = 2;
  if (raw.length === 1) {
    layoutMode = 2;
  } else if (raw.length === 2) {
    // Jika kata pertama adalah keyword (ki === 0) atau acak seimbang antara Mode 0 & Mode 1
    layoutMode = ki === 0 ? 1 : r() > 0.45 ? 0 : 1;
  } else if (raw.length === 3) {
    // Pola "want to know" / "there's no absolute" (1 baris wide-spaced) vs stacked
    layoutMode = r() > 0.38 ? 2 : ki === 0 ? 1 : 0;
  } else {
    // 4+ kata: bisa 1 baris wide/ketikan atau stacked
    layoutMode = r() > 0.45 ? 2 : 0;
  }

  // Susun baris & atribut tipografi tiap kata
  const topRow = [];
  const botRow = [];
  let wordSpaceMult = 0.85;

  if (layoutMode === 0) {
    // Mode 0: Pendukung Sans Bold kecil di atas (rata kiri) + Keyword Sans Bold raksasa di bawah
    const splitAt = ki > 0 ? ki : 1;
    for (let i = 0; i < splitAt; i++) {
      topRow.push({ word: raw[i], idx: i, role: 'support_top' });
    }
    for (let i = splitAt; i < raw.length; i++) {
      botRow.push({ word: raw[i], idx: i, role: i === ki || i === splitAt ? 'keyword' : 'support_top' });
    }
    wordSpaceMult = 0.85;
  } else if (layoutMode === 1) {
    // Mode 1: Keyword Sans Bold raksasa di atas + Pendukung Serif Italic di bawah (rata tengah)
    topRow.push({ word: raw[0], idx: 0, role: 'keyword' });
    for (let i = 1; i < raw.length; i++) {
      botRow.push({ word: raw[i], idx: i, role: 'serif_sub' });
    }
    wordSpaceMult = 0.92;
  } else {
    // Mode 2: 1 Baris (kata tunggal atau 2-4 kata sejajar dengan spasi antar kata lebar)
    raw.forEach((word, idx) => {
      topRow.push({
        word,
        idx,
        role: raw.length === 1 ? 'keyword' : 'wide_line',
      });
    });
    // Jarak antar kata lebar seperti foto "want   to   know"
    wordSpaceMult = raw.length >= 2 ? 2.15 : 0.85;
  }

  const fontOf = (it) => (it.role === 'serif_sub' ? FONT_SERIF_IT : FONT_BOLD);
  const trackOf = (it) => (it.role === 'serif_sub' ? TRACK_SERIF : TRACK_BOLD);
  const pxOf = (it) => {
    if (it.role === 'keyword') return bigPx;
    if (it.role === 'support_top') return smallSansPx;
    if (it.role === 'serif_sub') return smallSerifPx;
    return wideRowPx;
  };

  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const rowW = (row) =>
    row.reduce(
      (acc, it, j) => acc + wOf(it) + (j ? widthPx(' ', fontOf(it), pxOf(it)) * wordSpaceMult : 0),
      0
    );

  // Auto-fit terhadap MAXW = 860
  const maxRowWidth = Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0, 1);
  const k = Math.min(1, MAXW / maxRowWidth);
  bigPx *= k;
  smallSansPx *= k;
  smallSerifPx *= k;
  wideRowPx *= k;

  // Jarak antar baris menempel rapat seperti di referensi "the / smartest" dan "absolute / certainty"
  const gap = layoutMode === 1 ? Math.round(-basePx * 0.06 * k) : Math.round(-basePx * 0.10 * k);

  const topW = rowW(topRow);
  const botW = botRow.length ? rowW(botRow) : 0;
  const blockW = Math.max(topW, botW);
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, (o.cx || 540) - blockW / 2));

  // Palet Warna (sesuai request: seluruh teks hitam diganti ke Putih #FFFFFF; kata kunci utama memakai Biru Dongker #0A2463 atau Putih #FFFFFF)
  const useNavyAccent = r() > 0.35;
  const keywordColor = useNavyAccent ? '#0A2463' : '#FFFFFF';
  const supportColor = '#FFFFFF';

  // Ekstraksi parameter animasi dari preset JSON (3. Left_Keyboard, 1_Basic_Up, 1_Keyboard_Up):
  // - Kata kunci: slide up vertikal halus + fade-in mulus (Circular Ease, tanpa pantulan)
  // - Kata pendukung / wide line: geser halus dari kiri ke kanan / word-by-word reveal lembut
  const makeWord = (it, px, x, y, t) => {
    const isKeyword = it.role === 'keyword';
    const isWhite = !isKeyword || keywordColor === '#FFFFFF';
    const color = isKeyword ? keywordColor : supportColor;

    const el = {
      kind: 'text',
      text: it.word,
      font: fontOf(it),
      px,
      fsp: trackOf(it) * px,
      color,
      oc: color,
      ow: 0,
      // Efek cahaya/glow tipis khusus untuk teks putih agar tetap terbaca bersih
      sd: isWhite ? 2 : 0,
      shade: isWhite,
      x,
      y,
      rot: 0,
    };

    if (isKeyword) {
      // Gerakan masuk vertikal halus (dari bawah ke atas + fade-in lembut)
      const durIn = 210;
      const dy0 = Math.round(32 * k);
      el.keys = [
        { t: 0, a: 0, blur: 6, x, y: y + dy0, sx: 100, sy: 100 },
        { t, a: 0, blur: 6, x, y: y + dy0, sx: 100, sy: 100 },
        { t: t + durIn, a: 1, blur: 0, x, y, sx: 100, sy: 100 },
      ];
    } else if (layoutMode === 2) {
      // Kemunculan berurutan per kata (word-by-word soft reveal pada baris "want to know")
      const durIn = 150;
      const dx0 = Math.round(-16 * k);
      el.keys = [
        { t: 0, a: 0, blur: 4, x: x + dx0, y, sx: 100, sy: 100 },
        { t, a: 0, blur: 4, x: x + dx0, y, sx: 100, sy: 100 },
        { t: t + durIn, a: 1, blur: 0, x, y, sx: 100, sy: 100 },
      ];
    } else {
      // Kata pendukung atas/bawah pada mode stacked: geser horizontal halus + fade-in
      const durIn = 175;
      const dx0 = Math.round(-22 * k);
      el.keys = [
        { t: 0, a: 0, blur: 4, x: x + dx0, y, sx: 100, sy: 100 },
        { t, a: 0, blur: 4, x: x + dx0, y, sx: 100, sy: 100 },
        { t: t + durIn, a: 1, blur: 0, x, y, sx: 100, sy: 100 },
      ];
    }

    return el;
  };

  const els = [];
  let y = o.top;

  const placeRow = (row, rowIdx) => {
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    const rw = rowW(row);

    // Aturan perataan per baris sesuai referensi foto:
    // - Mode 0 baris atas ("the" di atas "smartest"): rata kiri sejajar blok kata utama (sedikit menjorok +18px agar selaras dengan huruf ke-2 kata bawah seperti di foto)
    // - Mode 1 & Mode 2: rata tengah
    let x = blockStartX + (blockW - rw) / 2;
    if (layoutMode === 0 && rowIdx === 0) {
      x = blockStartX + Math.round(18 * k);
    }

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      els.push(makeWord(it, pxOf(it), x + ww / 2, cy + baselineOffset, times[it.idx]));
      x += ww + widthPx(' ', fontOf(it), pxOf(it)) * wordSpaceMult;
    });

    y += h + gap;
  };

  placeRow(topRow, 0);
  if (botRow.length) placeRow(botRow, 1);

  return { elements: els, box: { top: o.top, bottom: y - gap } };
}
// ---- preset: Tumpuk3Lime.txt
// Nama Gaya Sosmed: Stacked Editorial Contrast / Asymmetric 3-Tier Hook Caption
// Karakteristik: 3-tier asymmetric stack (Baris 1 Regular menjorok dalam, Baris 2 Keyword 1-2 kata raksasa Bold Lime, Baris 3 Regular rata kanan)
// Font Wajib: 'Inter Bold' dan 'Inter Regular' (Character Spacing rapat setara -1 CapCut)
// Mode Blend: NORMAL (Solid White #FFFFFF & Neon Lime #C6F52B dengan soft outer glow, tanpa efek Subtract)
// Chunk: 4-7
function capTumpuk3Lime(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`tumpuk3lime|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_BOLD = 'Inter Bold';
  const FONT_REG  = 'Inter Regular';
  const TRACK_BIG = -0.068; // Rapat setara Character Spacing -1/-2 CapCut
  const TRACK_SUB = -0.055;
  const MAXW = 860;

  const COLOR_SUB = '#FFFFFF';
  const COLOR_KEY = '#C6F52B'; // Hijau lime terang dengan efek glow seperti referensi

  const basePx = (o.px || 105) * (o.k || 1);
  let bigPx   = Math.round(basePx * 1.24);
  let smallPx = Math.max(Math.round(basePx * 0.46), 32);

  // Distribusi kata menjadi 3 tingkat (mengikuti pola video referensi):
  // - Baris 2 (Tengah): 1 kata keyword (atau 2 kata berdampingan jika panjang frasa >= 5 kata dan kata setelah keyword penting, misal "Camera Stresses", "You record", "Your plate")
  // - Baris 1 (Atas): Kata-kata sebelum keyword (jika >= 4 kata, terpecah cluster kiri & kanan atas)
  // - Baris 3 (Bawah): Kata-kata setelah keyword
  const topLeft = [];
  const topRight = [];
  const midRow = [];
  const botRow = [];

  if (raw.length === 1) {
    midRow.push({ word: raw[0], idx: 0, big: true, lime: true });
  } else if (raw.length === 2) {
    if (ki === 0) {
      midRow.push({ word: raw[0], idx: 0, big: true, lime: true });
      botRow.push({ word: raw[1], idx: 1, big: false, lime: false });
    } else {
      topLeft.push({ word: raw[0], idx: 0, big: false, lime: false });
      midRow.push({ word: raw[1], idx: 1, big: true, lime: true });
    }
  } else {
    // Cek apakah kata tepat setelah keyword juga ikut menjadi bagian frasa utama raksasa (2 kata di baris tengah)
    const nextWord = raw[ki + 1] ? raw[ki + 1].replace(/[^a-zA-Z0-9]/g, '') : '';
    const pairKey = raw.length >= 4 && ki + 1 < raw.length && nextWord.length >= 4 && (raw.length - (ki + 1) >= 2 || ki >= 3);
    const keyEnd = pairKey ? ki + 1 : ki;

    const before = [];
    const after = [];
    for (let i = 0; i < raw.length; i++) {
      if (i < ki) before.push({ word: raw[i], idx: i, big: false, lime: false });
      else if (i >= ki && i <= keyEnd) midRow.push({ word: raw[i], idx: i, big: true, lime: true });
      else after.push({ word: raw[i], idx: i, big: false, lime: false });
    }

    // Jika baris atas punya >= 4 kata (seperti "If the ... have to"), pecah menjadi cluster kiri & kanan di atas keyword
    if (before.length >= 4) {
      const splitAt = Math.ceil(before.length / 2);
      topLeft.push(...before.slice(0, splitAt));
      topRight.push(...before.slice(splitAt));
    } else {
      topLeft.push(...before);
    }

    // Pada baris bawah (seperti "your value"), beri highlight Bold + Lime pada kata kunci penutup jika hanya 2 kata & berakhiran kata benda/penting
    after.forEach((item, idx) => {
      const isLast = idx === after.length - 1;
      const cleanW = item.word.replace(/[^a-zA-Z0-9]/g, '');
      const highlightEnd = after.length === 2 && isLast && cleanW.length >= 5 && ki <= 1;
      botRow.push({
        ...item,
        big: false,
        lime: highlightEnd,
        forceBold: highlightEnd
      });
    });
  }

  const pxOf    = (it) => (it.big ? bigPx : smallPx);
  const fontOf  = (it) => (it.big || it.forceBold ? FONT_BOLD : FONT_REG);
  const trackOf = (it) => (it.big ? TRACK_BIG : TRACK_SUB);
  const wOf     = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const spaceOf = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.68;
  const rowW    = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceOf(it) : 0), 0);

  // Hitung lebar maksimum baris untuk auto-fit MAXW = 860
  const wTopInit = (topLeft.length ? rowW(topLeft) : 0) + (topRight.length ? rowW(topRight) + 56 : 0);
  const wMidInit = midRow.length ? rowW(midRow) : 0;
  const wBotInit = botRow.length ? rowW(botRow) : 0;

  const maxRowWidth = Math.max(wTopInit, wMidInit, wBotInit, 1);
  const scaleFit = Math.min(1, MAXW / maxRowWidth);
  bigPx   = Math.round(bigPx * scaleFit);
  smallPx = Math.round(smallPx * scaleFit);

  // Jarak antar baris negatif agar baris atas & bawah menempel/menyentuh baris keyword tengah
  const gap = Math.round(-basePx * 0.18 * scaleFit);

  const finalWTop = (topLeft.length ? rowW(topLeft) : 0) + (topRight.length ? rowW(topRight) + 48 * scaleFit : 0);
  const finalWMid = midRow.length ? rowW(midRow) : 0;
  const finalWBot = botRow.length ? rowW(botRow) : 0;
  const blockW = Math.max(finalWTop, finalWMid, finalWBot);

  const cx = o.cx !== undefined ? o.cx : 540;
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, cx - blockW / 2));

  // Variasi animasi masuk dari JSON:
  // 0 = 1_Blur_Up (Blur slide-up lembut + fade)
  // 1 = 2.Light_Zoom In (Light scale zoom-in bersih)
  // 2 = 6.Up Bounce_Basic (Elastic vertical overshoot tipis)
  const keyAnimMode = Math.floor(r() * 3);

  const makeWord = (it, x, y, t, isFirstMidWord = false) => {
    const isBig = it.big;
    const px = pxOf(it);
    const font = fontOf(it);
    const track = trackOf(it);

    // Kapitalisasi sesuai referensi: kata pertama di baris keyword diawali huruf kapital, kata kedua di baris keyword mengikuti aslinya (misal "You record", "Your plate", "Camera Stresses")
    const label = isFirstMidWord
      ? it.word.charAt(0).toUpperCase() + it.word.slice(1)
      : it.word;

    const el = {
      kind: 'text',
      text: label,
      font,
      px,
      fsp: track * px,
      color: it.lime ? COLOR_KEY : COLOR_SUB,
      oc: it.lime ? '#B5F000' : '#000000',
      ow: 0,
      sd: 16,      // Efek glow/cahaya lembut seperti di video referensi
      shade: true,
      x,
      y,
      rot: 0,
      keys: []
    };

    if (isBig) {
      if (keyAnimMode === 0) {
        // 1_Blur_Up
        const dy = Math.round(46 * scaleFit);
        el.keys = [
          { t: 0,       a: 0, blur: 16, x, y: y + dy, sx: 88,  sy: 88 },
          { t,          a: 0, blur: 16, x, y: y + dy, sx: 88,  sy: 88 },
          { t: t + 240, a: 1, blur: 0,  x, y,        sx: 100, sy: 100 }
        ];
      } else if (keyAnimMode === 1) {
        // 2.Light_Zoom In
        el.keys = [
          { t: 0,       a: 0, blur: 12, x, y, sx: 40,  sy: 40 },
          { t,          a: 0, blur: 12, x, y, sx: 40,  sy: 40 },
          { t: t + 140, a: 1, blur: 2,  x, y, sx: 94,  sy: 94 },
          { t: t + 260, a: 1, blur: 0,  x, y, sx: 100, sy: 100 }
        ];
      } else {
        // 6.Up Bounce_Basic
        const dyStart = Math.round(56 * scaleFit);
        const dyOver1 = Math.round(-16 * scaleFit);
        const dyOver2 = Math.round(7 * scaleFit);
        el.keys = [
          { t: 0,       a: 0, blur: 12, x, y: y + dyStart, sx: 82,  sy: 82 },
          { t,          a: 0, blur: 12, x, y: y + dyStart, sx: 82,  sy: 82 },
          { t: t + 130, a: 1, blur: 0,  x, y: y + dyOver1, sx: 103, sy: 103 },
          { t: t + 210, a: 1, blur: 0,  x, y: y + dyOver2, sx: 98,  sy: 98 },
          { t: t + 290, a: 1, blur: 0,  x, y,           sx: 100, sy: 100 }
        ];
      }
    } else {
      // 3_Left_Hazy untuk kata pendukung
      const dx = Math.round(34 * scaleFit);
      el.keys = [
        { t: 0,       a: 0, blur: 10, x: x - dx, y, sx: 100, sy: 100 },
        { t,          a: 0, blur: 10, x: x - dx, y, sx: 100, sy: 100 },
        { t: t + 200, a: 1, blur: 0,  x,        y, sx: 100, sy: 100 }
      ];
    }

    return el;
  };

  const els = [];
  let y = o.top !== undefined ? o.top : 780;

  // 1. Baris Atas (Menjorok ke dalam ~14% lebar blok, atau terpecah kiri-kanan jika >= 4 kata)
  if (topLeft.length || topRight.length) {
    const allTop = [...topLeft, ...topRight];
    const rh = Math.max(...allTop.map(pxOf));
    const cy = y + rh / 2;
    const indentX = blockW * 0.14;

    if (topLeft.length) {
      let curX = blockStartX + indentX;
      topLeft.forEach((it) => {
        const ww = wOf(it);
        els.push(makeWord(it, curX + ww / 2, cy, times[it.idx], false));
        curX += ww + spaceOf(it);
      });
    }

    if (topRight.length) {
      const rwRight = rowW(topRight);
      let curX = blockStartX + blockW - rwRight - indentX * 0.6;
      topRight.forEach((it) => {
        const ww = wOf(it);
        els.push(makeWord(it, curX + ww / 2, cy, times[it.idx], false));
        curX += ww + spaceOf(it);
      });
    }

    y += rh + gap;
  }

  // 2. Baris Tengah (1-2 Kata Keyword Raksasa - Center Block)
  if (midRow.length) {
    const rw = rowW(midRow);
    const rh = Math.max(...midRow.map(pxOf));
    const cy = y + rh / 2;
    let curX = blockStartX + (blockW - rw) / 2;

    midRow.forEach((it, mIdx) => {
      const ww = wOf(it);
      els.push(makeWord(it, curX + ww / 2, cy, times[it.idx], mIdx === 0));
      curX += ww + spaceOf(it);
    });

    y += rh + gap;
  }

  // 3. Baris Bawah (Rata kanan sejajar tepi kanan keyword)
  if (botRow.length) {
    const rw = rowW(botRow);
    const rh = Math.max(...botRow.map(pxOf));
    const cy = y + rh / 2;
    let curX = blockStartX + (blockW - rw);

    botRow.forEach((it) => {
      const ww = wOf(it);
      els.push(makeWord(it, curX + ww / 2, cy, times[it.idx], false));
      curX += ww + spaceOf(it);
    });

    y += rh + gap;
  }

  return {
    elements: els,
    box: {
      top: o.top !== undefined ? o.top : 780,
      bottom: y - gap
    }
  };
}
// ---- preset: EditorialDual.txt
// Nama Gaya Sosmed: Editorial Minimalist / Dynamic Dual-Typography Kinetic Captions (Devin Jatho / Creator Style)
// Karakteristik: Hirarki 3-tier tipografi (Sans Bold keyword raksasa, Sans Medium spread-justified pendukung atas, Condensed Serif Italic ramping untuk penekanan emosional), highlight hijau/merah pada keyword, tanpa stroke/background bar.
// Font Wajib: 'Inter Bold', 'Inter Medium', dan 'Instrument Serif Italic'
// Mode Blend: NORMAL (teks solid dengan soft ambient shadow tipis)
// Chunk: 1-3

function capEditorialDual(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorialDualV2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 3-Tier Font Hierarchy sesuai analisis frame-by-frame video
  const FONT_KEY_SANS   = 'Inter Bold';              // Keyword utama & angka ($50/h, coincidence, editors)
  const FONT_FLOW_SANS  = 'Inter SemiBold';          // Kata tunggal/frasa beruntun (if they don't, negotiate, remember this:)
  const FONT_SUP_SANS   = 'Inter Medium';            // Kata pendukung kecil di atas keyword (It's not a, best paid, My name is)
  const FONT_EMPH_SERIF = 'Instrument Serif Italic'; // Kata penekanan emosional/puitis (don't, editing., Antonio, mission, percentage)

  const TRACK_SANS  = -0.052;
  const TRACK_SERIF = -0.035;
  const MAXW = 860;

  const basePx = (o.px || 105) * (o.k || 1);
  // Skala ukuran per kategori kata:
  let keySansPx  = Math.round(basePx * 1.42);              // Keyword raksasa (coincidence, editors, $50/h)
  let keySerifPx = Math.round(basePx * 1.48);              // Keyword Serif Italic (don't, editing., Antonio, percentage)
  let flowPx     = Math.round(basePx * 0.88);              // Kata tunggal/frasa beruntun (remember this:, negotiate)
  let supPx      = Math.max(Math.round(basePx * 0.46), 30);// Kata pendukung atas (It's not a, best paid)

  // Tentukan mode visual segmen ini berdasarkan jumlah kata & variasi acak deterministik
  // Mode 0: Stacked 2 Baris (Pendukung Sans Medium spread di atas + Keyword Sans Bold raksasa di bawah)
  // Mode 1: Stacked 2 Baris (Pendukung Sans Medium/Serif Italic di atas + Keyword Serif Italic besar di bawah, seperti "My name is / Antonio")
  // Mode 2: Single-Line Editorial Serif Italic (1-2 kata penekanan puitis seperti "don't", "editing.", "percentage", "of a", "business.")
  // Mode 3: Single-Line Clean Sans SemiBold (1-3 kata naratif cepat seperti "if they don't", "even", "getting", "into", "remember this:")
  const colorVariant = Math.floor(r() * 5); // 0-2: Putih (#FFFFFF), 3: Hijau Neon (#1ED760), 4: Merah Terang (#EF4444)
  let layoutMode;

  if (raw.length >= 3) {
    layoutMode = r() > 0.35 ? 0 : 1;
  } else if (raw.length === 2) {
    layoutMode = r() > 0.45 ? 3 : 2;
  } else {
    layoutMode = r() > 0.42 ? 2 : 3;
  }

  const topRow = [];
  const botRow = [];

  if (layoutMode === 0 || layoutMode === 1) {
    // Mode 2 Baris Bertumpuk (Stacked Hierarchy)
    const useSerifKeyword = layoutMode === 1;
    const splitIdx = ki > 0 ? ki : 1;

    for (let i = 0; i < splitIdx; i++) {
      topRow.push({
        word: raw[i],
        idx: i,
        role: 'support',
        font: (!useSerifKeyword && r() > 0.72) ? FONT_EMPH_SERIF : FONT_SUP_SANS,
        px: supPx,
        track: TRACK_SANS
      });
    }
    for (let i = splitIdx; i < raw.length; i++) {
      const isMainKey = i === ki || (ki === 0 && i === splitIdx);
      botRow.push({
        word: raw[i],
        idx: i,
        role: isMainKey ? 'keyword' : 'subkey',
        font: useSerifKeyword ? FONT_EMPH_SERIF : FONT_KEY_SANS,
        px: useSerifKeyword ? keySerifPx : keySansPx,
        track: useSerifKeyword ? TRACK_SERIF : TRACK_SANS
      });
    }
  } else if (layoutMode === 2) {
    // Mode Single-Line Condensed Serif Italic (elegan & dramatis)
    raw.forEach((word, idx) => {
      topRow.push({
        word,
        idx,
        role: idx === ki ? 'keyword' : 'flow_serif',
        font: FONT_EMPH_SERIF,
        px: raw.length === 1 ? keySerifPx : Math.round(keySerifPx * 0.86),
        track: TRACK_SERIF
      });
    });
  } else {
    // Mode Single-Line Clean Sans SemiBold (naratif cepat & tegas)
    raw.forEach((word, idx) => {
      const isMain = idx === ki && raw.length === 1;
      topRow.push({
        word,
        idx,
        role: isMain ? 'keyword' : 'flow_sans',
        font: isMain ? FONT_KEY_SANS : FONT_FLOW_SANS,
        px: isMain ? Math.round(keySansPx * 0.85) : flowPx,
        track: TRACK_SANS
      });
    });
  }

  const wOf = (it) => widthPx(it.word, it.font, it.px) * (1 + it.track);
  const spaceW = (it) => widthPx(' ', it.font, it.px) * 0.78;
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0, 1);
  const fitScale = Math.min(1, MAXW / maxRowWidth);

  // Terapkan auto-fit ke semua item
  [...topRow, ...botRow].forEach((it) => {
    it.px = Math.round(it.px * fitScale);
  });

  // Jarak antar baris rapat (tight leading) seperti di video
  const gap = Math.round(-basePx * 0.10 * fitScale);
  const blockW = Math.max(rowW(topRow), botRow.length ? rowW(botRow) : 0);
  const blockStartX = Math.max(50, Math.min(1080 - 50 - blockW, (o.cx || 540) - blockW / 2));

  // Warna highlight keyword (hanya aktif pada role 'keyword' / 'subkey')
  const getKeywordColor = (role) => {
    if (role !== 'keyword' && role !== 'subkey') return '#FFFFFF';
    if (colorVariant === 3) return '#1ED760'; // Hijau neon ("editors")
    if (colorVariant === 4) return '#EF4444'; // Merah terang ("$50/h", "$100/video")
    return '#FFFFFF';
  };

  // Parameter keyframe diekstrak dari 1_Basic_Up.json, 1_Blur_Up.json, dan 2.Light_Zoom In.json
  const yOffsetUp = Math.round(121 * (o.k || 1) * fitScale); // -0.125874 * 960px CapCut NDC
  const motionVariant = Math.floor(r() * 3); // 0: Basic/Blur Up, 1: Light Zoom In + Blur, 2: Snappy Micro-Pop

  const createWordElement = (it, x, y, t) => {
    const isKeyword = it.role === 'keyword' || it.role === 'subkey';
    const textColor = getKeywordColor(it.role);
    const animDur = isKeyword ? 310 : 240;

    const el = {
      kind: 'text',
      text: it.word,
      font: it.font,
      px: it.px,
      fsp: it.track * it.px,
      color: textColor,
      oc: '#000000',
      ow: 0,
      sd: 5,
      shade: true,
      x,
      y,
      rot: 0
    };

    if (isKeyword && motionVariant === 1) {
      // Kombinasi 2.Light_Zoom In (Circular Ease scale-up) + 1_Blur_Up
      el.keys = [
        { t: 0,           a: 0, blur: 12, x, y: y + Math.round(yOffsetUp * 0.25), sx: 46,  sy: 46 },
        { t,              a: 0, blur: 12, x, y: y + Math.round(yOffsetUp * 0.25), sx: 46,  sy: 46 },
        { t: t + animDur, a: 1, blur: 0,  x, y,                                   sx: 100, sy: 100 }
      ];
    } else if (motionVariant === 2 && !isKeyword) {
      // Muncul cepat di tempat dengan subtle scale & blur fade (seperti kata beruntun 00:22 - 00:33)
      el.keys = [
        { t: 0,           a: 0, blur: 6, x, y, sx: 88,  sy: 88 },
        { t,              a: 0, blur: 6, x, y, sx: 88,  sy: 88 },
        { t: t + animDur, a: 1, blur: 0, x, y, sx: 100, sy: 100 }
      ];
    } else {
      // 1_Basic_Up & 1_Blur_Up (geser vertikal +121px dengan kurva Rebound Out & fade cepat)
      const startBlur = isKeyword ? 10 : 5;
      const startY = y + (isKeyword ? Math.round(yOffsetUp * 0.85) : Math.round(yOffsetUp * 0.50));

      el.keys = [
        { t: 0,                              a: 0,    blur: startBlur, x, y: startY,                          sx: 100, sy: 100 },
        { t,                                 a: 0,    blur: startBlur, x, y: startY,                          sx: 100, sy: 100 },
        { t: t + Math.round(animDur * 0.45), a: 0.92, blur: 2,         x, y: y + Math.round(yOffsetUp * 0.06), sx: 100, sy: 100 },
        { t: t + animDur,                    a: 1,    blur: 0,         x, y,                                  sx: 100, sy: 100 }
      ];
    }

    return el;
  };

  const els = [];
  let y = o.top;

  const placeRow = (row, isTopStackedRow) => {
    const h = Math.max(...row.map((it) => it.px));
    const cy = y + h / 2;
    const currentRowW = rowW(row);

    // Jika baris atas pada mode 2 baris bertumpuk memiliki >= 2 kata (seperti "It's   not a" atau "best   paid"),
    // rentangkan jarak antar kata agar tepi kiri & kanannya sejajar dengan blok keyword di bawahnya!
    if (isTopStackedRow && botRow.length > 0 && row.length >= 2 && blockW > currentRowW) {
      const totalWordsW = row.reduce((acc, it) => acc + wOf(it), 0);
      const dynamicGap = (blockW - totalWordsW) / (row.length - 1);
      let x = blockStartX;

      row.forEach((it) => {
        const ww = wOf(it);
        const baselineOffset = (h - it.px) * 0.35;
        els.push(createWordElement(it, x + ww / 2, cy + baselineOffset, times[it.idx]));
        x += ww + dynamicGap;
      });
    } else {
      // Rata tengah standar untuk baris keyword bawah maupun mode 1 baris
      let x = blockStartX + (blockW - currentRowW) / 2;
      row.forEach((it) => {
        const ww = wOf(it);
        const baselineOffset = (h - it.px) * 0.35;
        els.push(createWordElement(it, x + ww / 2, cy + baselineOffset, times[it.idx]));
        x += ww + spaceW(it);
      });
    }

    y += h + gap;
  };

  placeRow(topRow, true);
  if (botRow.length) placeRow(botRow, false);

  return { elements: els, box: { top: o.top, bottom: y - gap } };
}

const CAP_TEMPLATES = {
  cap_tumpuk2(text, o) { return capTumpuk2(text, o); },
  // Small lead-in words, then the key word big; anything after it small again.
  cap_susun(text, o) {
    const px = (o.px || 150) * (o.k || 1);
    return capBuild(text, o, {
      rows: (w, k) => [
        { words: w.slice(0, k), idx: w.slice(0, k).map((_, i) => i), font: 'Open Sauce Two Bold', px: px * 0.36, color: '#ffffff', lh: 1.15 },
        { words: [w[k]], idx: [k], font: 'Open Sauce Two ExtraBold', px, color: '#ffffff', lh: 1.08 },
        { words: w.slice(k + 1), idx: w.slice(k + 1).map((_, i) => k + 1 + i), font: 'Open Sauce Two Bold', px: px * 0.36, color: '#ffffff', lh: 1.15 },
      ],
    });
  },
  // White words, key word large and glowing: orange, lime or white.
  cap_glow(text, o) { return capGlow(text, o, '#ff8a1f', '#ff6a00'); },
  cap_glow_lime(text, o) { return capGlow(text, o, '#c8ff2e', '#8fe000'); },
  cap_glow_putih(text, o) { return capGlow(text, o, '#ffffff', '#ffffff'); },
  // [CAP-FOKUS] keynote look: staggered lines, blur-in words, orange key word
  cap_fokus_oranye(text, o) { return capFocus(text, o, 'oranye'); },
  // [CAP-FOKUS] same, key word italic (or a 3+ word second line in capitals)
  cap_fokus_miring(text, o) { return capFocus(text, o, 'miring'); },
  // [CAP-ACAK] scattered lyric look: narrow small words + Bootzy big words
  cap_acak_bootzy(text, o) { return capAcak(text, o, 'bootzy'); },
  // [CAP-ACAK] same, big words in Open Sauce squeezed narrow, lowercase
  cap_acak_sauce(text, o) { return capAcak(text, o, 'sauce'); },
  // [SAUCE-MIX] one family, mixed 1–3 word cues, key word sometimes italic
  cap_sauce_mix(text, o) { return capSauceMix(text, o); },
  cap_quote(text, o) { return capQuote(text, o); },
  cap_estetik(text, o) { return capEstetik(text, o); },
  // Left-aligned stack: small sans lead, key word as big caps (long words) or
  // a glowing serif italic (short words), tail small and indented.
  cap_campur(text, o) {
    const px = (o.px || 150) * (o.k || 1);
    return capBuild(text, o, {
      left: true, maxW: 860,
      rows: (w, k) => {
        const big = w[k].length >= 6;
        return [
          { words: w.slice(0, k), idx: w.slice(0, k).map((_, i) => i), font: 'Open Sauce Two Bold', px: px * 0.4, color: '#ffffff', lh: 1.2 },
          big
            ? { words: [w[k].toUpperCase()], idx: [k], font: 'Anton', px, color: '#ffffff', lh: 1.02, indent: 30 }
            : { words: [w[k]], idx: [k], font: "Editor'sNote-MediumItalic", px: px * 0.92, color: '#ffb547', glow: '#ff7a00', lh: 1.0, indent: 30 },
          { words: w.slice(k + 1), idx: w.slice(k + 1).map((_, i) => k + 1 + i), font: 'Open Sauce Two Bold', px: px * 0.4, color: '#ffffff', lh: 1.2, indent: 70 },
        ];
      },
    });
  },
};
Object.assign(TEMPLATES, CAP_TEMPLATES);
CHUNK_RULES['cap_cleanblurreveal'] = { min: 1, max: 4 };
CHUNK_RULES['cap_cleaneditorial'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorialcontrast'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorialdual'] = { min: 1, max: 3 };
CHUNK_RULES['cap_editorialemphasis'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorialminimal'] = { min: 1, max: 3 };
CHUNK_RULES['cap_editorialmix'] = { min: 1, max: 5 };
CHUNK_RULES['cap_editorialscript'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorialscriptmix'] = { min: 1, max: 6 };
CHUNK_RULES['cap_editorialstacked'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorialswiss'] = { min: 1, max: 4 };
CHUNK_RULES['cap_editorialtightsans'] = { min: 1, max: 5 };
CHUNK_RULES['cap_imanstackedglow'] = { min: 1, max: 5 };
CHUNK_RULES['cap_kineticsandwich'] = { min: 1, max: 4 };
CHUNK_RULES['cap_swisskineticimpact'] = { min: 1, max: 4 };
CHUNK_RULES['cap_tumpuk3lime'] = { min: 4, max: 7 };
// [CHUNK-RULE] generated from the '// Chunk:' header of each preset file
TEMPLATES['cap_editorialdual'] = function (t, o) { return capEditorialDual(t, o); };

TEMPLATES['cap_cleanblurreveal'] = function (t, o) { return capCleanBlurReveal(t, o); };
TEMPLATES['cap_cleaneditorial'] = function (t, o) { return capCleanEditorial(t, o); };
TEMPLATES['cap_editorialcontrast'] = function (t, o) { return capEditorialContrast(t, o); };
TEMPLATES['cap_editorialemphasis'] = function (t, o) { return capStackedGlowEmphasis(t, o); };
TEMPLATES['cap_editorialminimal'] = function (t, o) { return capEditorialMinimal(t, o); };
TEMPLATES['cap_editorialmix'] = function (t, o) { return capEditorialMix(t, o); };
TEMPLATES['cap_editorialscript'] = function (t, o) { return capEditorialScript(t, o); };
TEMPLATES['cap_editorialscriptmix'] = function (t, o) { return capEditorialScriptMix(t, o); };
TEMPLATES['cap_editorialstacked'] = function (t, o) { return capEditorialStacked(t, o); };
TEMPLATES['cap_editorialswiss'] = function (t, o) { return capSwissEditorialKinetic(t, o); };
TEMPLATES['cap_editorialtightsans'] = function (t, o) { return capEditorialTightSans(t, o); };
TEMPLATES['cap_imanstackedglow'] = function (t, o) { return capImanStackedGlow(t, o); };
TEMPLATES['cap_kineticsandwich'] = function (t, o) { return capKineticAnchorOverlap(t, o); };
TEMPLATES['cap_swisskineticimpact'] = function (t, o) { return capNeroEditorial(t, o); };
TEMPLATES['cap_tumpuk3lime'] = function (t, o) { return capTumpuk3Lime(t, o); };

// ---- preset: AntonioEditorial.txt
// Nama Gaya Sosmed : Antonio Premiere Clean Editorial / Mixed Sans & Serif Italic Captions
// Karakteristik : 5 pola kemunculan dinamis (1-row mixed-weight inline, single-word focus, stacked big-over-small, stacked small-over-serif, & scattered position), tracking ketat (-0.055), spasi kata rapat (0.52x), transisi halus berbasis Rebound Out & Circular Ease.
// Font Wajib : Helvetica Neue Medium, Helvetica Neue Regular, Helvetica Neue Light, Times New Roman Italic
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, monokrom bersih #FFFFFF; gunakan inverse_auto jika background video putih terang)
// Chunk: 1-5
//
// CHANGELOG v4 (fix pattern variety):
// - antonioEstKeyIndex di-override langsung di file ini agar pattern 0/1/2/3 muncul bervariasi
//   sesuai referensi video Antonio, bukan hanya Pattern 3 terus
// - Distribusi pattern target:
//     1 kata              → Pattern 0 (centered serif) atau 4 (scattered) — seperti "here", "seeing"
//     2 kata              → Pattern 1 (1 baris inline) atau 2 (tumpuk besar-atas)
//     3 kata              → Pattern 1, 2, atau 3 bergantian
//     4-5 kata            → Pattern 2 (keyword awal, besar atas) ATAU Pattern 3 (keyword akhir, besar bawah)
//     6+ kata             → Pattern 2 atau Pattern 3
// - Semua fix v3 tetap dipertahankan

// ─────────────────────────────────────────────────────────────────
// OVERRIDE antonioEstKeyIndex — agar keyword position bervariasi
// sehingga Pattern 0, 1, 2, 3 semua bisa muncul
// ─────────────────────────────────────────────────────────────────
// Cara kerja:
//   ki = 0              → Pattern 2 (keyword besar di atas)
//   ki = last           → Pattern 3 (keyword besar di bawah)  ← yang selalu muncul sebelumnya
//   ki = tengah         → Pattern 1 (1 baris inline mixed-weight)
//
// Target distribusi per panjang chunk:
//   1 kata  → ki selalu 0 (pattern 0/4 ditentukan dari raw.length===1)
//   2 kata  → 50% ki=0 (pattern 2), 50% ki=1 (pattern 1 atau 3)
//   3 kata  → 40% ki=0 (P2), 30% ki=1 (P1), 30% ki=2 (P3)
//   4+ kata → 35% ki=0 (P2), 30% ki=mid (P1), 35% ki=last (P3)
// ─────────────────────────────────────────────────────────────────
function antonioEstKeyIndex(raw) {
  const n = raw.length;
  if (n <= 1) return 0;

  // [DETERMINISTIC-PATTERN] Seeded by the cue text, never Math.random(): preview
  // and burn each call layout() separately, so a random draw gave a different
  // pattern in the export than in the preview for the same caption. Own rng so
  // the jitter stream `r` in capAntonioEditorial is not shifted.
  const r = rng(`antonio_key|${raw.join(' ')}`)();

  if (n === 2) {
    return r < 0.50 ? 0 : 1;
  }

  if (n === 3) {
    if (r < 0.40) return 0;          // → Pattern 2: keyword besar atas
    if (r < 0.70) return 1;          // → Pattern 1: inline 1 baris
    return 2;                        // → Pattern 3: keyword besar bawah
  }

  // 4+ kata: TIDAK pakai Pattern 1 (inline) — terlalu panjang untuk 1 baris
  // Hanya Pattern 2 (keyword atas) atau Pattern 3 (keyword bawah)
  if (r < 0.45) return 0;           // → Pattern 2: keyword besar atas
  return n - 1;                     // → Pattern 3: keyword besar bawah
}

// ─────────────────────────────────────────────────────────────────

function capAntonioEditorial(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`antonio_editorial_v2|${text}`) : Math.random;
  const ki = antonioEstKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 4 Tier Ketebalan Font persis seperti video:
  // 1. Serif Italic untuk keyword emosional/aksi ("building", "brands", "Antonio", "teaching")
  // 2. Sans Medium untuk keyword penekanan dalam 1 baris ("super", "plugin", "make", "editing")
  // 3. Sans Light untuk kata pendamping SEUKURAN dalam 1 baris yang sama ("no ... needed")
  // 4. Sans Regular/Light kecil untuk sub-baris bertumpuk ("clean captions", "and directly inside")
  const FONT_SERIF_KEY   = 'Times New Roman Italic';
  const FONT_SANS_KEY    = 'Helvetica Neue Medium';
  const FONT_SANS_INLINE = 'Helvetica Neue Light';
  const FONT_SUB_SMALL   = 'Helvetica Neue Regular';

  const TRACK      = -0.055; // Kerapatan huruf sangat rapat
  const SPACE_MULT = 0.52;   // Jarak antar kata rapat (0.52x spasi normal)
  const MAXW       = 860;

  const cx     = o.cx  ?? 540;
  const topY   = o.top ?? 1180;
  const basePx = (o.px || 105) * (o.k || 1);

  let bigPx   = Math.round(basePx * 0.74);
  let smallPx = Math.max(Math.round(basePx * 0.31), 25);

  const keyWordClean     = raw[ki].toLowerCase().replace(/[^a-z]/g, '');
  const isProperOrAction = /^[A-Z]/.test(raw[ki]) && ki > 0 || keyWordClean.length >= 6;

  // ─────────────────────────────────────────────────────────────────
  // FIX 1: Tentukan PATTERN lebih dulu, baru tentukan keyTier
  // ─────────────────────────────────────────────────────────────────
  // Pattern 0: 1 Kata Tunggal Terpusat ("that", "screen", "seeing", "here")
  // Pattern 1: 1 Baris Horizontal Sejajar Mixed-Weight ("no [plugin] needed")
  // Pattern 2: 2 Baris — Utama Besar di Atas + Pendukung Kecil di Bawah ("super / clean captions")
  // Pattern 3: 2 Baris — Pengantar Kecil di Atas + Keyword Serif Besar di Bawah ("my name is / Antonio")
  // Pattern 4: Scattered / Off-Center Placement

  let pattern = 1;
  if (raw.length === 1) {
    pattern = r() > 0.72 ? 4 : 0;
  } else if (raw.length >= 4) {
    pattern = (ki >= raw.length - 1) ? 3 : (ki === 0 ? 2 : 1);
  } else if (raw.length === 3) {
    if (ki === 0)              pattern = 2;
    else if (ki === 2)         pattern = 3;
    else                       pattern = 1;
  } else {
    // 2 kata
    pattern = ki === 0 ? 2 : (r() > 0.45 ? 1 : 3);
  }

  // ─────────────────────────────────────────────────────────────────
  // FIX 2: keyTier berdasarkan Pattern (bukan sebelum pattern)
  // ─────────────────────────────────────────────────────────────────
  // Pattern 0 / 4  → kata tunggal fokus → serif italic 88%
  //                   (seperti "here", "seeing", "screen" di video)
  // Pattern 1      → inline 1 baris     → SELALU sans_key (Helvetica Neue Medium)
  //                   serif italic di dalam 1 baris akan merusak keseimbangan visual
  //                   contoh: "no [plugin] needed" → plugin = sans medium, bukan serif
  // Pattern 2 / 3  → keyword menonjol   → serif italic jika proper/aksi (75%), lainnya (35%)
  //                   contoh serif: "teaching", "Antonio"
  //                   contoh sans:  "super", "online"

  let useSerifForKey;
  if (pattern === 0 || pattern === 4) {
    // FIX: naikkan dari ~35% → 88% agar "here", "seeing" dll selalu serif seperti di video
    useSerifForKey = r() > 0.12;
  } else if (pattern === 1) {
    // FIX: pattern inline 1 baris TIDAK memakai serif italic untuk keyword
    useSerifForKey = false;
  } else {
    // Pattern 2 / 3: serif untuk kata emosional/aksi/proper
    useSerifForKey = isProperOrAction ? r() > 0.25 : r() > 0.65;
  }
  const keyTier = useSerifForKey ? 'serif_key' : 'sans_key';

  // ─────────────────────────────────────────────────────────────────
  // Susun baris (topRow & botRow)
  // ─────────────────────────────────────────────────────────────────
  const topRow = [];
  const botRow = [];
  let rowOffsetX = 0;

  if (pattern === 0 || pattern === 4) {
    // 1 Kata Tunggal
    botRow.push({ word: raw[0], idx: 0, big: true, isKey: true, tier: keyTier });
    if (pattern === 4) {
      rowOffsetX = (r() > 0.5 ? 1 : -1) * Math.round(145 * (o.k || 1));
    }

  } else if (pattern === 1) {
    // 1 Baris Horizontal: SEMUA kata ukuran besar, keyword lebih tebal
    // keyword → sans_key (Helvetica Neue Medium)
    // sisanya → sans_inline (Helvetica Neue Light)
    for (let i = 0; i < raw.length; i++) {
      const isKey = i === ki;
      botRow.push({
        word: raw[i], idx: i, big: true, isKey,
        tier: isKey ? keyTier : 'sans_inline'
      });
    }

  } else if (pattern === 2) {
    // 2 Baris Bertumpuk: Utama Besar di Atas + Pendukung Kecil di Bawah
    //
    // FIX 3: splitAt yang lebih natural
    // Untuk 3 kata (mis. "super / clean captions"):
    //   splitAt = ki + 1 → "super" sendiri di atas, "clean captions" di bawah
    // Untuk 4+ kata (mis. "no plugin needed / and directly inside"):
    //   splitAt = titik tengah (ceil(n/2)) tapi pastikan keyword masuk baris atas
    //   → "no plugin needed" (3 kata) di atas, "and directly inside" (3 kata) di bawah
    let splitAt;
    if (ki === 0) {
      // Keyword di posisi pertama → tampilkan sendiri di baris atas
      // Contoh: "teaching" sendiri atas / "others how to do the same" bawah
      //         "super" sendiri atas / "clean captions" bawah
      splitAt = 1;
    } else if (raw.length <= 3) {
      // Kata sedikit, keyword bukan di awal: split tepat setelah keyword
      splitAt = Math.min(ki + 1, raw.length - 1);
    } else {
      // 4+ kata, keyword bukan di awal: ambil midpoint natural tapi keyword harus masuk baris atas
      // Contoh: "no PLUGIN needed and directly inside" (ki=1, 6 kata)
      //   idealSplit=3 → topRow=["no","plugin","needed"], botRow=["and","directly","inside"]
      const idealSplit = Math.min(Math.ceil(raw.length / 2), 3);
      splitAt = Math.min(
        Math.max(ki + 1, idealSplit),
        Math.min(3, raw.length - 1)
      );
    }

    for (let i = 0; i < splitAt; i++) {
      const isKey = i === ki;
      topRow.push({
        word: raw[i], idx: i, big: true, isKey,
        tier: isKey ? keyTier : 'sans_inline'
      });
    }
    for (let i = splitAt; i < raw.length; i++) {
      botRow.push({ word: raw[i], idx: i, big: false, isKey: false, tier: 'sub_small' });
    }

    // Sesekali geser sedikit ke kanan seperti frame "teaching / others how to do the same"
    if (r() > 0.65) {
      rowOffsetX = Math.round(95 * (o.k || 1));
    }

  } else if (pattern === 3) {
    // 2 Baris Bertumpuk: Pengantar Kecil di Atas + Keyword Besar di Bawah
    // contoh: "my name is" (kecil) / "Antonio" (besar serif)
    for (let i = 0; i < ki; i++) {
      topRow.push({ word: raw[i], idx: i, big: false, isKey: false, tier: 'sub_small' });
    }
    for (let i = ki; i < raw.length; i++) {
      const isKey = i === ki;
      botRow.push({
        word: raw[i], idx: i, big: true, isKey,
        tier: isKey ? keyTier : 'sans_inline'
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Helper: ukuran & font per item
  // ─────────────────────────────────────────────────────────────────
  const pxOf   = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => {
    if (it.tier === 'serif_key')   return FONT_SERIF_KEY;
    if (it.tier === 'sans_key')    return FONT_SANS_KEY;
    if (it.tier === 'sans_inline') return FONT_SANS_INLINE;
    return FONT_SUB_SMALL;
  };

  const spaceW  = (it) => widthPx(' ', fontOf(it), pxOf(it)) * SPACE_MULT;
  const wOf     = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const rowW    = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  // Fit scale: pastikan tidak melebihi lebar maksimum
  const maxRowWidth  = Math.max(topRow.length ? rowW(topRow) : 0, botRow.length ? rowW(botRow) : 0, 1);
  const targetMaxW   = Math.min(MAXW, 740);
  const fitScale     = Math.min(1, targetMaxW / maxRowWidth);
  bigPx   *= fitScale;
  smallPx *= fitScale;

  // Jarak antar baris: rapat menempel (-8% dari basePx)
  const gap = Math.round(-basePx * 0.08 * fitScale);

  // ─────────────────────────────────────────────────────────────────
  // 4 Mode Animasi
  // 0: 1_Blur_Up.json     – Rebound Out Y + Blur Fade-In
  // 1: 1_Basic_Up.json    – Rebound Out Y crisp tanpa blur
  // 2: 2.Light_Zoom In    – Circular Ease scale 42%→102%→100% + rotasi
  // 3: 3_Left_Hazy.json   – Circular Ease X slide + Hazy Drop scale 132%→100%
  // ─────────────────────────────────────────────────────────────────
  const animMode = Math.floor(r() * 4);
  const hDir     = r() > 0.5 ? 1 : -1;

  const createWordEl = (w, font, px, x, y, t, isBig, isKey) => {
    const el = {
      kind: 'text',
      text:  w,
      font,
      px,
      fsp:   TRACK * px,
      color: '#FFFFFF',
      oc:    '#000000',
      ow:    0,
      sd:    0,
      shade: false,
      x,
      y,
      rot:   0,
      keys:  []
    };

    let startX  = x;
    let startY  = y;
    let startSx = 100;
    let startSy = 100;
    let midSx   = 100;
    let midSy   = 100;
    let blur0   = 0;
    let rot0    = 0;

    // Sub-baris kecil muncul menyusul halus (+45ms) setelah baris utama mendarat
    const animDur = isBig ? 235 : 185;
    const tStart  = t + (isBig ? 0 : 45);
    const tMid    = tStart + Math.round(animDur * 0.58);
    const tEnd    = tStart + animDur;

    if (animMode === 0) {
      // 1_Blur_Up: Rebound Out Y + Blur Fade-In
      startY = y + Math.round((isBig ? 42 : 24) * fitScale);
      blur0  = isBig ? 14 : 8;
    } else if (animMode === 1) {
      // 1_Basic_Up: Rebound Out Y tajam
      startY = y + Math.round((isBig ? 36 : 20) * fitScale);
      blur0  = 0;
    } else if (animMode === 2) {
      // 2_Light_Zoom In: Circular Ease scale + rotasi
      startSx = isBig ? 44 : 70;
      startSy = startSx;
      midSx   = isBig ? 102 : 100;
      midSy   = midSx;
      rot0    = isKey ? 0.12 * hDir : 0;
      blur0   = isBig ? 6 : 3;
    } else {
      // 3_Left_Hazy: Circular Ease slide horizontal + Hazy Drop scale
      startX  = x + hDir * Math.round((isBig ? 58 : 32) * fitScale);
      startSx = isBig ? 130 : 112;
      startSy = startSx;
      rot0    = isKey ? 0.14 * hDir : 0.04 * hDir;
      blur0   = isBig ? 12 : 7;
    }

    const midX = x + (startX - x) * 0.11;
    const midY = (animMode === 0 || animMode === 1)
      ? y - Math.round(2 * fitScale)
      : y + (startY - y) * 0.11;

    el.keys = [
      { t: 0,      a: 0,    blur: blur0,                    x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0        },
      { t: tStart, a: 0,    blur: blur0,                    x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0        },
      { t: tMid,   a: 0.92, blur: Math.round(blur0 * 0.18), x: midX,   y: midY,   sx: midSx,   sy: midSy,   rot: rot0 * 0.15 },
      { t: tEnd,   a: 1,    blur: 0,                        x,          y,          sx: 100,     sy: 100,     rot: 0           }
    ];

    return el;
  };

  // ─────────────────────────────────────────────────────────────────
  // Render baris ke elemen
  // ─────────────────────────────────────────────────────────────────
  const els = [];
  let   y   = topY;

  const placeRow = (row) => {
    if (!row.length) return;
    const rw  = rowW(row);
    const h   = Math.max(...row.map(pxOf));
    const cy  = y + h / 2;
    const targetCx = cx + rowOffsetX;
    let   x   = Math.max(70, Math.min(1080 - 70 - rw, targetCx - rw / 2));

    row.forEach((it) => {
      const ww = wOf(it);
      // Penyelarasan baseline presisi: Serif Italic & Sans-Serif sejajar rapi dalam 1 baris
      const baselineOffset = (h - pxOf(it)) * 0.36;
      els.push(
        createWordEl(
          it.word,
          fontOf(it),
          pxOf(it),
          x + ww / 2,
          cy + baselineOffset,
          times[it.idx],
          it.big,
          it.isKey
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  };

  placeRow(topRow);
  placeRow(botRow);

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: AppleKeynoteKinetic.txt
// Nama Gaya Sosmed : Apple Keynote Minimalist Kinetic Typography (@kirtanfx Reference)
// Karakteristik : Blok 1 baris (2 kata) atau 2 baris bertumpuk kompak rata tengah (3-5 kata). Baris atas kecil SF Pro Display Regular, baris bawah besar SF Pro Display SemiBold/Bold. Kata muncul berurutan dengan efek horizontal center-push & blur-fade, dilengkapi highlighter flash ungu-krem pada baris bawah serta aksen ungu (#6E56CF) pada titik akhir kalimat.
// Font Wajib : SF Pro Display Regular, SF Pro Display SemiBold, SF Pro Display Bold
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, tanpa glow)
// Chunk: 2-5

function capAppleKeynoteKinetic(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`apple_keynote_exact|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const dur = o.dur || 1500;
  const times = wordTimes(raw, dur);

  const FONT_TOP = 'SF Pro Display Regular';
  const FONT_SUB = 'SF Pro Display SemiBold';
  const FONT_KEY = 'SF Pro Display Bold';
  const ACCENT_DOT_COLOR = '#6E56CF';
  const TRACK = -0.04;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1240;
  const basePx = (o.px || 105) * (o.k || 1);

  // Proporsi ukuran sesuai video referensi: baris atas ~60% dari baris bawah
  let bigPx = Math.round(basePx * 0.78);
  let smallPx = Math.max(Math.round(basePx * 0.46), 28);

  // Aturan Chunking:
  // - 1-2 kata -> 1 baris tunggal besar ("This Smooth", "Apple Style", "Text Animations")
  // - 3-5 kata -> 2 baris bertumpuk: kata awal kecil di atas, 2 kata inti besar di bawah ("Here's how / you create", "In Just / 30 Seconds!", "I'll Send you / the Presets.")
  const topRow = [];
  const botRow = [];

  if (raw.length <= 2) {
    raw.forEach((word, idx) => {
      botRow.push({
        word,
        idx,
        big: true,
        tier: idx === ki || raw.length === 1 ? 'key' : 'sub'
      });
    });
  } else {
    const splitIdx = raw.length === 3 && ki === 2 ? 2 : Math.max(1, raw.length - 2);
    for (let i = 0; i < splitIdx; i++) {
      topRow.push({ word: raw[i], idx: i, big: false, tier: 'top' });
    }
    for (let i = splitIdx; i < raw.length; i++) {
      botRow.push({
        word: raw[i],
        idx: i,
        big: true,
        tier: i === ki || i === raw.length - 1 ? 'key' : 'sub'
      });
    }
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => {
    if (it.tier === 'key') return FONT_KEY;
    if (it.tier === 'sub') return FONT_SUB;
    return FONT_TOP;
  };

  // Jarak antar kata rapat-alami khas Apple SF Pro (~0.24 * px)
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.85;
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(topRow.length ? rowW(topRow) : 0, botRow.length ? rowW(botRow) : 0, 1);
  const fitScale = Math.min(1, MAXW / maxRowWidth);
  bigPx = Math.round(bigPx * fitScale);
  smallPx = Math.round(smallPx * fitScale);

  // Jarak antar baris kompak (+5px skala dasar)
  const gap = Math.round(basePx * 0.05 * fitScale);

  // 4 Pola Kemunculan Asli Video Referensi + Kurva JSON:
  // 0: Word-by-Word Center-Push + Blur-Fade (pola utama "Here's how / you create", "This Smooth", "Apple Style", "I'll Send you / the Presets.")
  // 1: Micro-Tilt Sweep + Soft Scale ("Text Animations" - kurva 8. Rotate Zoom in diredam halus)
  // 2: 2-Row Push-Up + Highlighter Bar Flash Ungu -> Krem ("In Just / 30 Seconds!")
  // 3: Soft Apple Zoom-In (kurva Circular Ease 2.Light_Zoom In)
  const animMode = raw.length >= 3 && r() > 0.62 ? 2 : Math.floor(r() * 4);
  const botStartTime = botRow.length ? times[botRow[0].idx] : 0;

  const buildWordKeys = (finalX, finalY, t, isBig, isTopRow, partialRowCenterShiftX) => {
    // Hitung posisi awal agak ke kanan/kiri sesuai efek center-push saat kata berikutnya masuk
    const pushStartX = finalX + partialRowCenterShiftX;

    // Mode 2: 2-Row Push-Up + Highlighter Flash ("In Just / 30 Seconds!")
    if (animMode === 2) {
      if (isTopRow && botRow.length > 0 && botStartTime > t) {
        const preY = finalY + Math.round(bigPx * 0.22);
        const tInEnd = t + 240;
        const tPushEnd = Math.min(dur, botStartTime + 240);
        return [
          { t: 0,            a: 0,    blur: 10, x: finalX, y: preY + 12, sx: 100, sy: 100, rot: 0 },
          { t,               a: 0,    blur: 10, x: finalX, y: preY + 12, sx: 100, sy: 100, rot: 0 },
          { t: tInEnd,       a: 1,    blur: 0,  x: finalX, y: preY,      sx: 100, sy: 100, rot: 0 },
          { t: botStartTime, a: 1,    blur: 0,  x: finalX, y: preY,      sx: 100, sy: 100, rot: 0 },
          { t: tPushEnd,     a: 1,    blur: 0,  x: finalX, y: finalY,    sx: 100, sy: 100, rot: 0 }
        ];
      }
      const startY = finalY + Math.round(bigPx * 0.28);
      return [
        { t: 0,       a: 0,    blur: 14, x: finalX, y: startY, sx: 96,  sy: 96,  rot: 0 },
        { t,          a: 0,    blur: 14, x: finalX, y: startY, sx: 96,  sy: 96,  rot: 0 },
        { t: t + 110, a: 0.89, blur: 3,  x: finalX, y: finalY + 3, sx: 100, sy: 100, rot: 0 },
        { t: t + 300, a: 1,    blur: 0,  x: finalX, y: finalY, sx: 100, sy: 100, rot: 0 }
      ];
    }

    // Mode 1: Micro-Tilt + Soft Scale Settle ("Text Animations")
    if (animMode === 1) {
      const rot0 = isBig ? -2.2 : -1.0;
      const startX = pushStartX - Math.round(bigPx * 0.18);
      return [
        { t: 0,       a: 0,    blur: 12, x: startX, y: finalY, sx: 92,  sy: 92,  rot: rot0 },
        { t,          a: 0,    blur: 12, x: startX, y: finalY, sx: 92,  sy: 92,  rot: rot0 },
        { t: t + 170, a: 0.90, blur: 2,  x: finalX, y: finalY, sx: 100, sy: 100, rot: rot0 * 0.25 },
        { t: t + 340, a: 1,    blur: 0,  x: finalX, y: finalY, sx: 100, sy: 100, rot: 0 }
      ];
    }

    // Mode 3: Soft Apple Zoom-In (Circular Ease 2.Light_Zoom In.json)
    if (animMode === 3) {
      const startScale = isBig ? 85 : 89;
      return [
        { t: 0,       a: 0,    blur: 12, x: pushStartX, y: finalY, sx: startScale, sy: startScale, rot: 0 },
        { t,          a: 0,    blur: 12, x: pushStartX, y: finalY, sx: startScale, sy: startScale, rot: 0 },
        { t: t + 180, a: 0.88, blur: 2,  x: finalX,     y: finalY, sx: 98,         sy: 98,         rot: 0 },
        { t: t + 340, a: 1,    blur: 0,  x: finalX,     y: finalY, sx: 100,        sy: 100,        rot: 0 }
      ];
    }

    // Mode 0 (Default Utama): Word-by-Word Horizontal Center-Push + Blur-Fade (kurva 1_Blur_Down / 1_Basic_Up)
    const startX = pushStartX + Math.round(bigPx * 0.12);
    const midX = finalX + Math.round((startX - finalX) * 0.11); // 89% progress di fase cepat sesuai Bezier JSON
    return [
      { t: 0,       a: 0,    blur: 14, x: startX, y: finalY, sx: 100, sy: 100, rot: 0 },
      { t,          a: 0,    blur: 14, x: startX, y: finalY, sx: 100, sy: 100, rot: 0 },
      { t: t + 105, a: 0.89, blur: 3,  x: midX,   y: finalY, sx: 100, sy: 100, rot: 0 },
      { t: t + 320, a: 1,    blur: 0,  x: finalX, y: finalY, sx: 100, sy: 100, rot: 0 }
    ];
  };

  const els = [];
  let y = topY;

  const placeCenterRow = (row, isTopRow) => {
    if (!row.length) return;
    const h = Math.max(...row.map(pxOf));
    const totalW = rowW(row);
    const cy = y + h / 2;
    let x = cx - totalW / 2;

    // Highlighter Bar Flash (Ungu Pastel #A89CF7 -> Kuning Krem #F3DC9C -> Hilang) pada Mode 2
    if (!isTopRow && animMode === 2) {
      const padX = Math.round(bigPx * 0.14);
      const padY = Math.round(bigPx * 0.04);
      const rectW = Math.round(totalW + padX * 2);
      const rectH = Math.round(h + padY * 2);
      const tStart = times[row[0].idx] + 120;

      // Layer 1: Ungu Pastel (#A89CF7) muncul cepat lalu pudar saat transisi ke krem
      els.push({
        kind: 'rect',
        x: cx,
        y: cy,
        w: rectW,
        h: rectH,
        r: 0,
        color: '#A89CF7',
        rot: 0,
        keys: [
          { t: 0,           a: 0,    blur: 0, x: cx, y: cy, sx: 94,  sy: 100, rot: 0 },
          { t: tStart,      a: 0,    blur: 0, x: cx, y: cy, sx: 94,  sy: 100, rot: 0 },
          { t: tStart + 70, a: 0.95, blur: 0, x: cx, y: cy, sx: 100, sy: 100, rot: 0 },
          { t: tStart + 180,a: 0,    blur: 0, x: cx, y: cy, sx: 100, sy: 100, rot: 0 }
        ]
      });

      // Layer 2: Kuning Krem (#F3DC9C) menyambung sebentar lalu hilang bersih
      els.push({
        kind: 'rect',
        x: cx,
        y: cy,
        w: rectW,
        h: rectH,
        r: 0,
        color: '#F3DC9C',
        rot: 0,
        keys: [
          { t: 0,            a: 0,    blur: 0, x: cx, y: cy, sx: 100, sy: 100, rot: 0 },
          { t: tStart + 110, a: 0,    blur: 0, x: cx, y: cy, sx: 100, sy: 100, rot: 0 },
          { t: tStart + 170, a: 0.95, blur: 0, x: cx, y: cy, sx: 100, sy: 100, rot: 0 },
          { t: tStart + 310, a: 0,    blur: 0, x: cx, y: cy, sx: 100, sy: 100, rot: 0 }
        ]
      });
    }

    row.forEach((it, idxInRow) => {
      const px = pxOf(it);
      const font = fontOf(it);
      const isLastWordOfChunk = !isTopRow && idxInRow === row.length - 1;

      // Hitung offset center-push: kata awal mulai lebih ke kanan relatif terhadap posisi akhir
      // karena saat kata berikutnya masuk, posisi baris bergeser ke kiri menuju titik tengah
      const remainingW = row
        .slice(idxInRow + 1)
        .reduce((acc, nextIt) => acc + wOf(nextIt) + spaceW(nextIt), 0);
      const partialShiftX = Math.round(remainingW * 0.35);

      const hasTrailingDot = isLastWordOfChunk && it.word.length > 1 && it.word.endsWith('.');

      if (hasTrailingDot) {
        const cleanWord = it.word.slice(0, -1);
        const wordW = widthPx(cleanWord, font, px) * (1 + TRACK);
        const dotW = widthPx('.', font, px) * (1 + TRACK);
        const wordCx = x + wordW / 2;
        const dotCx = x + wordW + dotW / 2;

        els.push({
          kind: 'text',
          text: cleanWord,
          font,
          px,
          fsp: TRACK * px,
          color: '#FFFFFF',
          oc: '#000000',
          ow: 0,
          sd: 0,
          shade: false,
          x: wordCx,
          y: cy,
          rot: 0,
          keys: buildWordKeys(wordCx, cy, times[it.idx], it.big, isTopRow, partialShiftX)
        });

        els.push({
          kind: 'text',
          text: '.',
          font,
          px,
          fsp: TRACK * px,
          color: ACCENT_DOT_COLOR,
          oc: '#000000',
          ow: 0,
          sd: 0,
          shade: false,
          x: dotCx,
          y: cy,
          rot: 0,
          keys: buildWordKeys(dotCx, cy, times[it.idx], it.big, isTopRow, partialShiftX)
        });

        x += wordW + dotW + spaceW(it);
      } else {
        const ww = wOf(it);
        const wordCx = x + ww / 2;

        els.push({
          kind: 'text',
          text: it.word,
          font,
          px,
          fsp: TRACK * px,
          color: '#FFFFFF',
          oc: '#000000',
          ow: 0,
          sd: 0,
          shade: false,
          x: wordCx,
          y: cy,
          rot: 0,
          keys: buildWordKeys(wordCx, cy, times[it.idx], it.big, isTopRow, partialShiftX)
        });

        x += ww + spaceW(it);
      }
    });

    y += h + gap;
  };

  placeCenterRow(topRow, true);
  placeCenterRow(botRow, false);

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: Editorial4Pattern.txt
// Nama Gaya Sosmed : Editorial 4-Pattern Mixed Serif-Sans Captions
// Karakteristik : Eksklusif 4 pola (1: Giant Serif Italic Sandwich ~3.5x kontras ukuran, 2: Compact Overlapping 3-Row Stack, 3: Single-Line Tight Sans-Serif, 4: 2-Row Full Sans-Serif White-Green Glow) dengan batas ketat maksimal 5 kata per chunk, warna hijau neon #6DFB09 + glow tebal, serta animasi Blur Slide-Up & Circular/Rebound Zoom-In.
// Font Wajib : Inter Regular, Inter Medium, Inter SemiBold, Playfair Display Bold Italic
// Mode Blend : Normal (ow: 0, sd: 0.45, shade: false, glow kuat pada keyword hijau)
// Chunk: 2-5

function capEditorial4Pattern(text, o = {}) {
  // Batasi ketat maksimal 5 kata per layar di setiap pola
  const raw = text.split(/\s+/).filter(Boolean).slice(0, 5);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorial_4_pattern_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_SANS_REG = 'Inter Regular';
  const FONT_SANS_MED = 'Inter Medium';
  const FONT_SANS_SB = 'Inter SemiBold';
  const FONT_SERIF_ITALIC = 'Playfair Display Italic';

  const TRACK_SANS = -0.045;
  const TRACK_SERIF = -0.025;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1160;
  const basePx = (o.px || 105) * (o.k || 1);

  const GREEN_NEON = '#6DFB09';
  const WHITE_SOLID = '#FFFFFF';
  const WHITE_MUTED = '#C5C5C5';

  // Helper keyframe presisi dari 1_Blur_Up.json, 2.Basic_Zoom In.json, & 10. Tap Zoom in.json
  const createWordEl = (word, font, px, track, color, x, y, t, isGreenKey, animType = 'slide') => {
    const rotBase = isGreenKey ? 0.23 : 0; // rotation: 0.22829° dari JSON
    const el = {
      kind: 'text',
      text: word,
      font,
      px,
      fsp: track * px,
      color,
      oc: isGreenKey ? GREEN_NEON : '#000000',
      ow: 0,
      sd: 0.45, // shadow_smoothing: 0.45 dari JSON
      shade: false,
      ...(isGreenKey ? { glowColor: GREEN_NEON, glowBlur: 24, glowAlpha: 0.65 } : {}),
      x,
      y,
      rot: rotBase,
      keys: []
    };

    if (animType === 'zoom') {
      // Ekstraksi 2.Basic_Zoom In.json & 10. Tap Zoom in.json (Circular Ease + Rebound Out)
      const animDur = 235;
      const tMid = t + Math.round(animDur * 0.64);
      const tEnd = t + animDur;
      const startY = y + Math.round(12 * (px / 100));

      el.keys = [
        { t: 0,    a: 0,    blur: 10, x, y: startY, sx: 66,  sy: 66,  rot: rotBase * 2.4 },
        { t,       a: 0,    blur: 10, x, y: startY, sx: 66,  sy: 66,  rot: rotBase * 2.4 },
        { t: tMid, a: 0.96, blur: 1,  x, y: y - 2,  sx: 104, sy: 104, rot: rotBase * 0.5 },
        { t: tEnd, a: 1,    blur: 0,  x, y,         sx: 100, sy: 100, rot: rotBase }
      ];
    } else {
      // Ekstraksi 1_Blur_Up.json (KFTypePositionY: -0.1258 -> 0.0 + Blur Fade-In Rebound Out)
      const animDur = 185;
      const tMid = t + Math.round(animDur * 0.58);
      const tEnd = t + animDur;
      const slideOffset = Math.round(24 * (px / 70));
      const startY = y + slideOffset;

      el.keys = [
        { t: 0,    a: 0,    blur: 8, x, y: startY,  sx: 100, sy: 100, rot: 0 },
        { t,       a: 0,    blur: 8, x, y: startY,  sx: 100, sy: 100, rot: 0 },
        { t: tMid, a: 0.89, blur: 2, x, y: y - 1.5, sx: 100, sy: 100, rot: 0 },
        { t: tEnd, a: 1,    blur: 0, x, y,        sx: 100, sy: 100, rot: 0 }
      ];
    }

    return el;
  };

  // Pemilihan tepat 1 dari 4 pola berdasarkan jumlah kata (2-5) & variasi ritme video
  let pattern = 1;
  if (raw.length >= 2 && raw.length <= 3 && ki === raw.length - 1 && r() < 0.45) {
    pattern = 3; // Pola 3: Single Line 2-3 kata ("All I do")
  } else if (raw.length >= 2 && raw.length <= 4 && ki >= raw.length - 2 && ki > 0 && r() < 0.45) {
    pattern = 4; // Pola 4: 2-Row Full Sans White + Green ("seeing / right now")
  } else if (raw.length >= 3 && raw.length <= 4 && raw[ki].length <= 5 && r() < 0.5) {
    pattern = 2; // Pola 2: Compact 3-Row Stack ("Have you / seen / people")
  } else {
    pattern = 1; // Pola 1: Giant Serif Italic Sandwich ("Animating their / Captions / Like this?")
  }

  const els = [];
  let yBottom = topY;

  // =========================================================================
  // POLA 3: Single-Line Clean Sans-Serif Putih ("All I do", 2-3 kata)
  // =========================================================================
  if (pattern === 3) {
    let px = Math.round(basePx * 0.78);
    const spaceRatio = 0.68;

    const calcW = (size) =>
      raw.reduce(
        (acc, w, idx) =>
          acc +
          widthPx(w, FONT_SANS_SB, size) * (1 + TRACK_SANS) +
          (idx ? widthPx(' ', FONT_SANS_SB, size) * spaceRatio : 0),
        0
      );

    const fitScale = Math.min(1, Math.min(MAXW, 740) / Math.max(calcW(px), 1));
    px *= fitScale;

    const totalW = calcW(px);
    let x = Math.max(70, Math.min(1080 - 70 - totalW, cx - totalW / 2));
    const cy = topY + px / 2;

    raw.forEach((w, idx) => {
      const ww = widthPx(w, FONT_SANS_SB, px) * (1 + TRACK_SANS);
      els.push(createWordEl(w, FONT_SANS_SB, px, TRACK_SANS, WHITE_SOLID, x + ww / 2, cy, times[idx], false, 'slide'));
      x += ww + widthPx(' ', FONT_SANS_SB, px) * spaceRatio;
    });

    yBottom = topY + px;
    return { elements: els, box: { top: topY, bottom: yBottom } };
  }

  // =========================================================================
  // POLA 4: 2-Row Full Sans-Serif Contrast ("seeing / right now", 2-4 kata)
  // =========================================================================
  if (pattern === 4) {
    const splitIdx = Math.max(1, Math.min(raw.length - 1, ki));
    const topWords = raw.slice(0, splitIdx).map((w, idx) => ({ w, idx }));
    const botWords = raw.slice(splitIdx).map((w, idx) => ({ w, idx: splitIdx + idx }));

    let topPx = Math.round(basePx * 0.80);
    let botPx = Math.round(basePx * 0.86);
    const spaceRatio = 0.74;

    const rowWidth = (arr, size) =>
      arr.reduce(
        (acc, it, j) =>
          acc +
          widthPx(it.w, FONT_SANS_SB, size) * (1 + TRACK_SANS) +
          (j ? widthPx(' ', FONT_SANS_SB, size) * spaceRatio : 0),
        0
      );

    const maxW = Math.max(rowWidth(topWords, topPx), rowWidth(botWords, botPx), 1);
    const fitScale = Math.min(1, Math.min(MAXW, 740) / maxW);
    topPx *= fitScale;
    botPx *= fitScale;

    const overlap = Math.round(-botPx * 0.18);
    let y = topY;

    [
      { arr: topWords, px: topPx, color: WHITE_SOLID, isGreen: false, anim: 'slide' },
      { arr: botWords, px: botPx, color: GREEN_NEON, isGreen: true, anim: 'zoom' }
    ].forEach((row) => {
      const rw = rowWidth(row.arr, row.px);
      let x = Math.max(70, Math.min(1080 - 70 - rw, cx - rw / 2));
      const cy = y + row.px / 2;

      row.arr.forEach((it) => {
        const ww = widthPx(it.w, FONT_SANS_SB, row.px) * (1 + TRACK_SANS);
        els.push(
          createWordEl(it.w, FONT_SANS_SB, row.px, TRACK_SANS, row.color, x + ww / 2, cy, times[it.idx], row.isGreen, row.anim)
        );
        x += ww + widthPx(' ', FONT_SANS_SB, row.px) * spaceRatio;
      });

      y += row.px + overlap;
    });

    yBottom = y - overlap;
    return { elements: els, box: { top: topY, bottom: yBottom } };
  }

  // =========================================================================
  // POLA 1 ("Animating their / Captions / Like this?") — Kata tengah JAUH LEBIH BESAR (~3.5x)
  // POLA 2 ("Have you / seen / people") — Ukuran 3 baris hampir setara & rapat
  // =========================================================================
  const isPattern2 = pattern === 2;

  let topPx = Math.round(basePx * (isPattern2 ? 0.78 : 0.44));
  let midPx = Math.round(basePx * (isPattern2 ? 0.82 : 1.55));
  let botPx = Math.round(basePx * (isPattern2 ? 0.76 : 0.44));

  const topFont = isPattern2 ? FONT_SANS_SB : FONT_SANS_REG;
  const botFont = isPattern2 ? FONT_SANS_SB : FONT_SANS_REG;

  // Pastikan baris atas & bawah masing-masing maksimal 2 kata agar total <= 5 kata
  const safeKi = Math.min(Math.max(ki, 1), raw.length - 1);
  const beforeWords = raw.slice(0, safeKi).slice(-2).map((w, idx) => ({ w, idx }));
  const keyWord = [{ w: raw[safeKi], idx: safeKi }];
  const afterWords = raw.slice(safeKi + 1).slice(0, 2).map((w, idx) => ({ w, idx: safeKi + 1 + idx }));

  const rowsData = [];
  if (beforeWords.length) rowsData.push({ arr: beforeWords, role: 'top' });
  rowsData.push({ arr: keyWord, role: 'mid' });
  if (afterWords.length) rowsData.push({ arr: afterWords, role: 'bot' });

  const getSpec = (role) => {
    if (role === 'mid') {
      return { font: FONT_SERIF_ITALIC, px: midPx, track: TRACK_SERIF, color: GREEN_NEON, isGreen: true, anim: 'zoom', space: 0.75 };
    }
    if (role === 'top') {
      return { font: topFont, px: topPx, track: TRACK_SANS, color: WHITE_SOLID, isGreen: false, anim: 'slide', space: 0.76 };
    }
    return {
      font: botFont,
      px: botPx,
      track: TRACK_SANS,
      color: isPattern2 ? WHITE_MUTED : WHITE_SOLID,
      isGreen: false,
      anim: 'slide',
      space: 0.76
    };
  };

  const calcRowW = (row) => {
    const sp = getSpec(row.role);
    return row.arr.reduce(
      (acc, it, j) =>
        acc +
        widthPx(it.w, sp.font, sp.px) * (1 + sp.track) +
        (j ? widthPx(' ', sp.font, sp.px) * sp.space : 0),
      0
    );
  };

  const maxRowW = Math.max(...rowsData.map(calcRowW), 1);
  // Beri ruang lebih lebar (820px) agar kata tengah Pola 1 bisa tampil raksasa tanpa terpotong
  const fitScale = Math.min(1, Math.min(MAXW, isPattern2 ? 720 : 820) / maxRowW);
  topPx *= fitScale;
  midPx *= fitScale;
  botPx *= fitScale;

  // Overlap baris:
  // Pola 2: menempel sangat dalam (-26%), referensi = ukuran baris itu sendiri (sp.px)
  // Pola 1: menempel rapat di atas & bawah huruf Serif (-18%), referensi = midPx (kata raksasa)
  //         → WAJIB pakai midPx agar overlap simetris: baris kecil atas & bawah sama-sama
  //           menempel sejauh 18% dari lebar kata tengah, bukan 18% dari baris kecilnya sendiri
  const overlapFactor = isPattern2 ? -0.26 : -0.18;
  let y = topY;

  rowsData.forEach((row, rIdx) => {
    const sp = getSpec(row.role);
    const rw = calcRowW(row);
    const offsetX = !isPattern2 && row.role === 'bot' ? Math.round(16 * fitScale) : 0;
    let x = Math.max(70, Math.min(1080 - 70 - rw, cx - rw / 2 + offsetX));
    const cy = y + sp.px / 2;

    row.arr.forEach((it) => {
      const ww = widthPx(it.w, sp.font, sp.px) * (1 + sp.track);
      els.push(
        createWordEl(it.w, sp.font, sp.px, sp.track, sp.color, x + ww / 2, cy, times[it.idx], sp.isGreen, sp.anim)
      );
      x += ww + widthPx(' ', sp.font, sp.px) * sp.space;
    });

    // FIX: Pola 1 gunakan midPx sebagai referensi gap — bukan sp.px baris kecil.
    // Tanpa fix ini, gap top→mid hanya 8px (0.18×46px) instead of 29px (0.18×163px),
    // sehingga "Animating their" terlalu jauh dari "Captions" dan tidak sesuai referensi.
    const gapRefPx = !isPattern2 ? midPx : sp.px;
    const gap = rIdx < rowsData.length - 1 ? Math.round(gapRefPx * overlapFactor) : 0;
    y += sp.px + gap;
  });

  yBottom = y;
  return { elements: els, box: { top: topY, bottom: yBottom } };
}
// ---- preset: EditorialContrast.txt
// Nama Gaya Sosmed : Ali Abdaal / Iman Gadzhi Editorial Contrast Captions (Exact Single & Multi-Pattern)
// Karakteristik : Single Hero Word full-width auto-scale (2 font: Helvetica Neue Bold & Times New Roman Italic, tracking super rapat -0.068) + 5 pola multi-kata (Standard Center Pop, Hero Anchor + Single Sub-Word Replacement, Reverse Stack + Hero Drop, Split Numbering, & Royal Blue B-Roll Top Pill) dengan kurva Rebound Out + Blur Fade-In / Circular Zoom.
// Font Wajib : Helvetica Neue Bold, Times New Roman Italic, Inter SemiBold
// Mode Blend : Normal (ow: 0, sd: 1.5, shade: false, rect #1428F5 pada B-Roll Top Pill)
// Chunk: 1-5

function capEditorialContrastV2(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const seedStr = `editorial_exact_v4|${text}`;
  const r = typeof rng === 'function' ? rng(seedStr) : Math.random;
  const ki = estKeyIndex(raw);
  const dur = o.dur || 1500;
  const times = wordTimes(raw, dur);

  // 2 Font Utama Hero (sesuai screenshot "videos" & "Maintaining") + 1 Font Sub-word
  const FONT_HERO_SANS = 'Helvetica Neue Bold';
  const FONT_HERO_SERIF = 'Times New Roman Italic';
  const FONT_SUB = 'Inter SemiBold';

  const TRACK_SANS_HERO = -0.068;  // Huruf sangat rapat seperti "videos"
  const TRACK_SERIF_HERO = -0.058; // Huruf miring rapat seperti "Maintaining"
  const TRACK_SUB = -0.035;
  const MAXW = 890;

  const cx = o.cx ?? 540;
  const basePx = (o.px || 105) * (o.k || 1);

  const heroPx = Math.round(basePx * 1.28);
  const subPx = Math.max(Math.round(basePx * 0.32), 28);
  const stdPx = Math.max(Math.round(basePx * 0.56), 46);

  const WHITE = '#FFFFFF';
  const ROYAL_BLUE = '#1428F5';

  // Pilih secara seimbang antara Sans Bold (seperti "videos") dan Serif Italic (seperti "Maintaining")
  const useSerifHero = r() > 0.5;
  const heroFont = useSerifHero ? FONT_HERO_SERIF : FONT_HERO_SANS;
  const heroTrack = useSerifHero ? TRACK_SERIF_HERO : TRACK_SANS_HERO;

  // Tentukan Pola Kemunculan
  // 0: Single Hero Word (1 kata raksasa full-width di atas kepala, y ~ 500)
  // 1: Standard Word-by-Word Pop (1-2 kata sedang bergantian di titik tengah, y ~ 930)
  // 2: Hero Anchor + Single Sub-Word Replacement (Keyword raksasa diam di atas, kata kecil ganti 1-per-1 di bawah)
  // 3: Reverse Stack (Kata kecil muncul di baris atas -> Keyword raksasa drop menempel di bawah)
  // 4: Split Staggered Numbering ("no. 1", "step 2")
  // 5: B-Roll Top Pill (Kotak biru #1428F5 di margin atas y ~ 200)
  const hasNumber = raw.some((w) => /^\d+[\.,]?$/.test(w));
  let pattern = 2;

  if (raw.length === 1) {
    // Mayoritas 1 kata memakai Single Hero Word raksasa seperti "videos" & "Maintaining"
    pattern = r() > 0.22 ? 0 : 1;
  } else if (hasNumber && raw.length <= 3) {
    pattern = 4;
  } else if (raw.length <= 3 && r() > 0.78) {
    pattern = 5;
  } else if (raw.length === 2 && r() > 0.52) {
    pattern = 1;
  } else if (ki === raw.length - 1 && raw.length >= 3) {
    pattern = 3;
  } else if (ki === 0 && raw.length >= 2) {
    pattern = 2;
  } else {
    pattern = r() > 0.38 ? 2 : 3;
  }

  const defaultTopByPattern = {
    0: 500, // Tepat di atas kepala pembicara sesuai screenshot "videos" & "Maintaining"
    1: 930,
    2: 780,
    3: 780,
    4: 620,
    5: 200
  };
  const topY = o.top ?? defaultTopByPattern[pattern];

  const measureWord = (w, font, px, track) => widthPx(w, font, px) * (1 + track);
  const tightSpace = (font, px) => widthPx(' ', font, px) * 0.55;

  // Ekstraksi kurva JSON (Rebound Out + Blur Fade-In & Circular Zoom)
  const animVariant = Math.floor(r() * 3);

  const buildKeys = (x, y, tStart, tExit, isHero, fitScale) => {
    const animDur = isHero ? 230 : 155;
    const tFast = tStart + Math.round(animDur * 0.28); // Titik Rebound Out 89%
    const tSettle = tStart + animDur;

    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let startRot = 0;
    let startBlur = 0;

    if (animVariant === 0) {
      // 1_Blur_Up.json: Rebound Out Y-slide + Blur Fade-In
      startY = y + Math.round((isHero ? 50 : 20) * fitScale);
      startBlur = isHero ? 14 : 6;
    } else if (animVariant === 1) {
      // 2.Light_Zoom In.json: Circular Ease Zoom + micro tilt
      startSx = isHero ? 76 : 88;
      startSy = isHero ? 76 : 88;
      startY = y + Math.round((isHero ? 18 : 8) * fitScale);
      startRot = isHero ? (r() > 0.5 ? 0.05 : -0.05) : 0;
      startBlur = isHero ? 8 : 3;
    } else {
      // 1_Basic_Up.json: Snappy Rebound Out Y-slide
      startY = y + Math.round((isHero ? 56 : 22) * fitScale);
      startBlur = isHero ? 4 : 0;
    }

    const fastY = y + (startY - y) * 0.11;
    const fastSx = 100 + (startSx - 100) * 0.11;
    const fastSy = 100 + (startSy - 100) * 0.11;

    const keys = [
      { t: 0, a: 0, blur: startBlur, x, y: startY, sx: startSx, sy: startSy, rot: startRot },
      { t: tStart, a: 0, blur: startBlur, x, y: startY, sx: startSx, sy: startSy, rot: startRot },
      { t: tFast, a: 0.94, blur: Math.round(startBlur * 0.2), x, y: fastY, sx: fastSx, sy: fastSy, rot: startRot * 0.15 },
      { t: tSettle, a: 1, blur: 0, x, y, sx: 100, sy: 100, rot: 0 }
    ];

    if (tExit < dur) {
      keys.push(
        { t: Math.max(tSettle, tExit - 15), a: 1, blur: 0, x, y, sx: 100, sy: 100, rot: 0 },
        { t: tExit, a: 0, blur: 3, x, y: y - Math.round(6 * fitScale), sx: 100, sy: 100, rot: 0 }
      );
    }

    return keys;
  };

  const els = [];
  let yBottom = topY;

  const pushWord = (word, font, px, track, x, y, tStart, tExit, isHero, fitScale) => {
    const keys = buildKeys(x, y, tStart, tExit, isHero, fitScale);
    els.push({
      kind: 'text',
      text: word,
      font,
      px,
      fsp: track * px,
      color: WHITE,
      oc: '#000000',
      ow: 0,
      sd: 1.5,
      shade: false,
      x,
      y,
      rot: 0,
      keys
    });
  };

  if (pattern === 0) {
    // =========================================================================
    // POLA A: SINGLE HERO WORD (100% PRESISI SCREENSHOT "videos" & "Maintaining")
    // Auto-scale dua arah: kata pendek ("videos", "flow") diperbesar ke ~660px,
    // kata panjang ("Maintaining") dikecilkan agar pas di ~890px, max tinggi 220px.
    // =========================================================================
    const word = raw[0];
    const refPx = 160;
    const rawW = Math.max(measureWord(word, heroFont, refPx, heroTrack), 1);

    // Target lebar: kata <= 6 huruf mengisi ~650px ("videos"), kata > 6 huruf mengisi ~885px ("Maintaining")
    const targetW = word.length <= 6 ? 650 : 885;
    let px = Math.round(refPx * (targetW / rawW));

    // Batas aman agar kata 2-3 huruf ("in", "to") tidak terlalu raksasa vertikal
    px = Math.max(135, Math.min(220, px));

    // Pastikan tidak pernah melampaui MAXW 890px
    const finalW = measureWord(word, heroFont, px, heroTrack);
    if (finalW > MAXW) {
      px = Math.round(px * (MAXW / finalW));
    }

    const fitScale = px / 160;
    pushWord(word, heroFont, px, heroTrack, cx, topY + px / 2, times[0], dur, true, fitScale);
    yBottom = topY + px;

  } else if (pattern === 1) {
    // POLA B: Standard Center Word-by-Word Replacement
    const maxW = Math.max(...raw.map((w) => measureWord(w, FONT_SUB, stdPx, TRACK_SUB)), 1);
    const fitScale = Math.min(1, MAXW / maxW);
    const px = Math.round(stdPx * fitScale);
    const cy = topY + px / 2;

    raw.forEach((word, i) => {
      const tStart = times[i];
      const tExit = i < raw.length - 1 ? times[i + 1] : dur;
      pushWord(word, FONT_SUB, px, TRACK_SUB, cx, cy, tStart, tExit, false, fitScale);
    });
    yBottom = topY + px;

  } else if (pattern === 2) {
    // POLA C: Hero Anchor + Single Sub-Word Replacement
    const heroIndices = [ki];
    if (ki + 1 < raw.length && raw.length >= 3 && raw[ki].length <= 6 && raw[ki + 1].length <= 6 && r() > 0.45) {
      heroIndices.push(ki + 1);
    }

    const heroWords = heroIndices.map((idx) => raw[idx]);
    const subItems = raw
      .map((w, idx) => ({ word: w, idx }))
      .filter((it) => !heroIndices.includes(it.idx));

    const spHero = tightSpace(heroFont, heroPx);
    const rawHeroW = heroWords.reduce((acc, w, j) => acc + measureWord(w, heroFont, heroPx, heroTrack) + (j ? spHero : 0), 0);
    const fitScale = Math.min(1, MAXW / Math.max(rawHeroW, 1));

    const fHeroPx = Math.round(heroPx * fitScale);
    const fSubPx = Math.max(Math.round(subPx * fitScale), 26);
    const fSpHero = tightSpace(heroFont, fHeroPx);
    const totalHeroW = heroWords.reduce((acc, w, j) => acc + measureWord(w, heroFont, fHeroPx, heroTrack) + (j ? fSpHero : 0), 0);

    const cyHero = topY + fHeroPx / 2;
    let curX = cx - totalHeroW / 2;
    heroWords.forEach((w, j) => {
      const ww = measureWord(w, heroFont, fHeroPx, heroTrack);
      pushWord(w, heroFont, fHeroPx, heroTrack, curX + ww / 2, cyHero, times[heroIndices[j]], dur, true, fitScale);
      curX += ww + fSpHero;
    });

    const tightLeading = Math.round(-fHeroPx * 0.16);
    const subTop = topY + fHeroPx + tightLeading;
    const cySub = subTop + fSubPx / 2;

    if (subItems.length > 0) {
      subItems.forEach((it, j) => {
        const tStart = times[it.idx];
        const tExit = j < subItems.length - 1 ? times[subItems[j + 1].idx] : dur;
        pushWord(it.word, FONT_SUB, fSubPx, TRACK_SUB, cx, cySub, tStart, tExit, false, fitScale);
      });
      yBottom = subTop + fSubPx;
    } else {
      yBottom = topY + fHeroPx;
    }

  } else if (pattern === 3) {
    // POLA D: Reverse Stack
    const topItems = [];
    const botItems = [];
    for (let i = 0; i < ki; i++) topItems.push({ word: raw[i], idx: i });
    for (let i = ki; i < raw.length; i++) botItems.push({ word: raw[i], idx: i, isKey: i === ki });

    const spSub = tightSpace(FONT_SUB, subPx);
    const spHero = tightSpace(heroFont, heroPx);

    const rawTopW = topItems.reduce((acc, it, j) => acc + measureWord(it.word, FONT_SUB, subPx, TRACK_SUB) + (j ? spSub : 0), 0);
    const rawBotW = botItems.reduce((acc, it, j) => {
      const f = it.isKey ? heroFont : FONT_SUB;
      const p = it.isKey ? heroPx : subPx;
      const tr = it.isKey ? heroTrack : TRACK_SUB;
      return acc + measureWord(it.word, f, p, tr) + (j ? spHero : 0);
    }, 0);

    const fitScale = Math.min(1, MAXW / Math.max(rawTopW, rawBotW, 1));
    const fSubPx = Math.max(Math.round(subPx * fitScale), 26);
    const fHeroPx = Math.round(heroPx * fitScale);

    const fSpSub = tightSpace(FONT_SUB, fSubPx);
    const totalTopW = topItems.reduce((acc, it, j) => acc + measureWord(it.word, FONT_SUB, fSubPx, TRACK_SUB) + (j ? fSpSub : 0), 0);
    const cyTop = topY + fSubPx / 2;
    let tx = cx - totalTopW / 2;

    topItems.forEach((it) => {
      const ww = measureWord(it.word, FONT_SUB, fSubPx, TRACK_SUB);
      pushWord(it.word, FONT_SUB, fSubPx, TRACK_SUB, tx + ww / 2, cyTop, times[it.idx], dur, false, fitScale);
      tx += ww + fSpSub;
    });

    const tightLeading = Math.round(-fHeroPx * 0.16);
    const botTop = topY + fSubPx + tightLeading;
    const cyBot = botTop + fHeroPx / 2;

    const totalBotW = botItems.reduce((acc, it, j) => {
      const f = it.isKey ? heroFont : FONT_SUB;
      const p = it.isKey ? fHeroPx : fSubPx;
      const tr = it.isKey ? heroTrack : TRACK_SUB;
      return acc + measureWord(it.word, f, p, tr) + (j ? tightSpace(f, p) : 0);
    }, 0);

    let bx = cx - totalBotW / 2;
    botItems.forEach((it) => {
      const f = it.isKey ? heroFont : FONT_SUB;
      const p = it.isKey ? fHeroPx : fSubPx;
      const tr = it.isKey ? heroTrack : TRACK_SUB;
      const ww = measureWord(it.word, f, p, tr);
      const baselineOffset = (fHeroPx - p) * 0.34;
      pushWord(it.word, f, p, tr, bx + ww / 2, cyBot + baselineOffset, times[it.idx], dur, it.isKey, fitScale);
      bx += ww + tightSpace(f, p);
    });

    yBottom = botTop + fHeroPx;

  } else if (pattern === 4) {
    // POLA E: Split Staggered Numbering
    const numIdx = raw.findIndex((w) => /^\d+[\.,]?$/.test(w));
    const numPx = Math.round(heroPx * 1.35);
    const labelPx = Math.round(heroPx * 0.72);
    const fitScale = Math.min(1, MAXW / (numPx * raw.length * 0.92));

    const fNumPx = Math.round(numPx * fitScale);
    const fLabelPx = Math.round(labelPx * fitScale);
    const cy = topY + fNumPx / 2;

    let totalW = 0;
    const items = raw.map((w, i) => {
      const isNum = i === numIdx;
      const f = isNum ? FONT_HERO_SERIF : (i < numIdx ? FONT_HERO_SERIF : FONT_SUB);
      const p = isNum ? fNumPx : (i < numIdx ? fLabelPx : Math.round(subPx * fitScale));
      const tr = isNum ? TRACK_SERIF_HERO : TRACK_SUB;
      const ww = measureWord(w, f, p, tr);
      totalW += ww + (i ? tightSpace(f, p) : 0);
      return { w, i, isNum, f, p, tr, ww };
    });

    let sx = cx - totalW / 2;
    items.forEach((it) => {
      const yOffset = it.isNum ? 0 : -Math.round(fNumPx * 0.14);
      pushWord(it.w, it.f, it.p, it.tr, sx + it.ww / 2, cy + yOffset, times[it.i], dur, it.isNum, fitScale);
      sx += it.ww + tightSpace(it.f, it.p);
    });

    yBottom = topY + fNumPx;

  } else {
    // POLA F: Royal Blue Highlight Box (#1428F5)
    const pillPx = Math.max(Math.round(basePx * 0.42), 34);
    const sp = tightSpace(FONT_SUB, pillPx);
    const totalW = raw.reduce((acc, w, i) => acc + measureWord(w, FONT_SUB, pillPx, TRACK_SUB) + (i ? sp : 0), 0);
    const fitScale = Math.min(1, MAXW / Math.max(totalW, 1));
    const fPx = Math.round(pillPx * fitScale);
    const fSp = tightSpace(FONT_SUB, fPx);
    const fTotalW = raw.reduce((acc, w, i) => acc + measureWord(w, FONT_SUB, fPx, TRACK_SUB) + (i ? fSp : 0), 0);

    const cy = topY + fPx / 2;
    const padX = Math.round(18 * fitScale);
    const padY = Math.round(10 * fitScale);
    const boxKeys = buildKeys(cx, cy, times[0], dur, false, fitScale);

    els.push({
      kind: 'rect',
      x: cx,
      y: cy,
      w: Math.round(fTotalW + padX * 2),
      h: Math.round(fPx + padY * 2),
      r: 2,
      color: ROYAL_BLUE,
      rot: 0,
      keys: boxKeys.map((k) => ({ ...k, blur: 0 }))
    });

    let sx = cx - fTotalW / 2;
    raw.forEach((w, i) => {
      const ww = measureWord(w, FONT_SUB, fPx, TRACK_SUB);
      const wKeys = buildKeys(sx + ww / 2, cy, times[i], dur, false, fitScale);
      els.push({
        kind: 'text',
        text: w,
        font: FONT_SUB,
        px: fPx,
        fsp: TRACK_SUB * fPx,
        color: WHITE,
        oc: '#000000',
        ow: 0,
        sd: 0,
        shade: false,
        x: sx + ww / 2,
        y: cy,
        rot: 0,
        keys: wKeys
      });
      sx += ww + fSp;
    });

    yBottom = topY + fPx;
  }

  return {
    elements: els,
    box: { top: topY, bottom: yBottom }
  };
}
// ---- preset: EditorialSerifContrast.txt
// Nama Gaya Sosmed : Editorial Serif-Sans Contrast Captions (Submagic / Iman Gadzhi Style)
// Karakteristik : Multi-pola dinamis identik dengan referensi: (1) Hook/Editorial 2-baris bertumpuk sangat rapat dengan kontras Sans Medium + Condensed Serif Italic / Tight Bold Sans, (2) 3-baris bertingkat untuk frasa panjang, (3) 1-baris minimalis di tengah layar untuk chunk 1-2 kata, serta (4) opsi Pill Oranye (#E85A34) untuk segmen demo. Menggunakan kurva Rebound Out Blur-Up, Circular Light Zoom-In, dan Hazy Slide dari JSON.
// Font Wajib : Helvetica Neue Medium, Helvetica Neue Bold, Instrument Serif Italic
// Mode Blend : Normal (ow: 0, sd: 0, shade: false)
// Chunk: 1-5

function capEditorialSerifContrast(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorial_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 3 Tier Font sesuai audit video referensi
  const FONT_SERIF_KEY = 'Instrument Serif Italic'; // Keyword utama (entire day, time, saves, CREATING CONTENT, CAPTIONS)
  const FONT_SANS_KEY = 'Helvetica Neue Bold';      // Keyword hook/aksen (captions, amazed, editors)
  const FONT_MED = 'Helvetica Neue Medium';         // Kata pendukung & narasi tengah (Medium, bukan Light/Thin)

  // Tracking sangat rapat sesuai karakter huruf di video
  const TRACK_BOLD = -0.055;
  const TRACK_SERIF = -0.042;
  const TRACK_MED = -0.035;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  // Posisi default di area tengah layar (seperti di video referensi, bukan di bawah)
  const topY = o.top ?? 860;
  const basePx = (o.px || 105) * (o.k || 1);

  // Penentuan Mode Pola berdasarkan jumlah kata & variasi acak deterministik:
  // Mode 'single_center' : 1-2 kata narasi tengah (detik 00:04-00:09 & 00:22-00:29)
  // Mode 'stacked_2row'  : 2-5 kata kontras 2 baris (detik 00:00-00:03, 00:10-00:12)
  // Mode 'stacked_3row'  : 4-6 kata 3 baris bertingkat (detik 00:30-00:33)
  let layoutMode = 'stacked_2row';
  if (raw.length <= 2 && r() < 0.78) {
    layoutMode = 'single_center';
  } else if (raw.length >= 4 && r() < 0.32) {
    layoutMode = 'stacked_3row';
  }

  // Pilih jenis font keyword: 70% Serif Italic, 30% Tight Bold Sans
  const useSerifKey = r() < 0.70;
  const keyFont = useSerifKey ? FONT_SERIF_KEY : FONT_SANS_KEY;
  const keyTrack = useSerifKey ? TRACK_SERIF : TRACK_BOLD;
  const keyAllCaps = useSerifKey && r() < 0.35; // Sebagian keyword serif memakai ALL CAPS (CAPTIONS / CREATING CONTENT)

  // Ukuran proporsional terhadap video referensi (rasio ~2.45x antara keyword dan kata pendukung)
  let bigPx = Math.round(basePx * 1.18);
  let smallPx = Math.max(Math.round(basePx * 0.45), 32);
  let midNarrationPx = Math.max(Math.round(basePx * 0.54), 38);

  const rows = []; // Array of { items: [], align: 'center' | 'blockLeft' | 'indentRight' }

  if (layoutMode === 'single_center') {
    // Pola C: 1 baris tunggal di tengah untuk narasi 1-2 kata ("every hour", "you're", "stuck", "your time")
    rows.push({
      align: 'center',
      items: raw.map((w, idx) => ({
        word: w.toLowerCase(),
        idx,
        font: FONT_MED,
        px: midNarrationPx,
        track: TRACK_MED,
        isBig: false,
        isKey: idx === ki
      }))
    });
  } else if (layoutMode === 'stacked_3row') {
    // Pola B: 3 baris bertingkat (seperti "starting out / CREATING / CONTENT" atau "comment / CAPTIONS / and I'll")
    const split1 = Math.max(1, Math.min(ki, raw.length - 2));
    const topWords = raw.slice(0, split1);
    const midWord = raw[split1];
    const botWords = raw.slice(split1 + 1);

    rows.push({
      align: 'center',
      items: topWords.map((w, i) => ({
        word: w.toLowerCase(),
        idx: i,
        font: FONT_MED,
        px: smallPx,
        track: TRACK_MED,
        isBig: false,
        isKey: false
      }))
    });

    rows.push({
      align: 'center',
      items: [{
        word: keyAllCaps ? midWord.toUpperCase() : midWord.toLowerCase(),
        idx: split1,
        font: keyFont,
        px: bigPx,
        track: keyTrack,
        isBig: true,
        isKey: true
      }]
    });

    if (botWords.length) {
      // Variasi: apakah baris ke-3 ikut besar serif (seperti "CONTENT") atau kecil di bawahnya (seperti "and I'll")
      const thirdIsBigSerif = useSerifKey && botWords.length === 1 && r() < 0.5;
      rows.push({
        align: thirdIsBigSerif ? 'indentRight' : 'center',
        items: botWords.map((w, j) => ({
          word: thirdIsBigSerif ? (keyAllCaps ? w.toUpperCase() : w.toLowerCase()) : w.toLowerCase(),
          idx: split1 + 1 + j,
          font: thirdIsBigSerif ? keyFont : FONT_MED,
          px: thirdIsBigSerif ? bigPx : smallPx,
          track: thirdIsBigSerif ? keyTrack : TRACK_MED,
          isBig: thirdIsBigSerif,
          isKey: false
        }))
      });
    }
  } else {
    // Pola A: 2 baris bertumpuk kompak
    const topRowItems = [];
    const botRowItems = [];

    if (ki === 0) {
      // Keyword di baris atas (seperti "captions / are stealing your editing time")
      topRowItems.push({
        word: keyAllCaps ? raw[0].toUpperCase() : raw[0].toLowerCase(),
        idx: 0,
        font: keyFont,
        px: bigPx,
        track: keyTrack,
        isBig: true,
        isKey: true
      });
      for (let i = 1; i < raw.length; i++) {
        botRowItems.push({
          word: raw[i].toLowerCase(),
          idx: i,
          font: FONT_MED,
          px: smallPx,
          track: TRACK_MED,
          isBig: false,
          isKey: false
        });
      }
      rows.push({ align: 'center', items: topRowItems });
      if (botRowItems.length) rows.push({ align: 'center', items: botRowItems });
    } else {
      // Kata pengantar di baris atas, keyword raksasa di baris bawah (seperti "that eats your / entire day")
      for (let i = 0; i < ki; i++) {
        topRowItems.push({
          word: raw[i].toLowerCase(),
          idx: i,
          font: FONT_MED,
          px: smallPx,
          track: TRACK_MED,
          isBig: false,
          isKey: false
        });
      }
      for (let i = ki; i < raw.length; i++) {
        botRowItems.push({
          word: keyAllCaps ? raw[i].toUpperCase() : raw[i].toLowerCase(),
          idx: i,
          font: keyFont,
          px: bigPx,
          track: keyTrack,
          isBig: true,
          isKey: i === ki
        });
      }
      // Baris atas rata kiri sejajar awal kata kunci di bawahnya (persis "that eats your / entire day" & "I was / amazed")
      rows.push({ align: 'blockLeft', items: topRowItems });
      rows.push({ align: 'blockLeft', items: botRowItems });
    }
  }

  // Helper pengukuran lebar dengan spasi antar kata rapat (0.68x) sesuai video
  const spaceW = (it) => widthPx(' ', it.font, it.px) * 0.68;
  const wOf = (it) => widthPx(it.word, it.font, it.px) * (1 + it.track);
  const rowW = (items) => items.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  // Auto-fit terhadap batas MAXW = 860
  const maxRowWidth = Math.max(...rows.map((rw) => rowW(rw.items)), 1);
  const targetMaxW = Math.min(MAXW, 780);
  const fitScale = Math.min(1, targetMaxW / maxRowWidth);

  rows.forEach((rw) => {
    rw.items.forEach((it) => {
      it.px = Math.round(it.px * fitScale);
    });
  });

  // Jarak antar baris sangat rapat (negative leading -0.15x basePx)
  const gap = Math.round(-basePx * 0.15 * fitScale);
  const blockW = Math.max(...rows.map((rw) => rowW(rw.items)));
  const blockStartX = Math.max(70, Math.min(1080 - 70 - blockW, cx - blockW / 2));

  // Ekstraksi 3 kurva animasi dari JSON:
  // 0 = 1_Blur_Up.json (Rebound Out + Blur Fade-In)
  // 1 = 2.Light_Zoom In.json (Circular Ease Scale 34%->100% + Rotasi 0.23 deg)
  // 2 = 3_Left_Hazy.json (Circular Ease Horizontal Slide + Hazy Drop Delayed Fade)
  const animPreset = Math.floor(r() * 3);
  const hazyDir = r() > 0.5 ? 1 : -1;

  const createWordEl = (it, x, y, t) => {
    const isBig = it.isBig;
    const el = {
      kind: 'text',
      text: it.word,
      font: it.font,
      px: it.px,
      fsp: it.track * it.px,
      color: '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      x,
      y,
      rot: 0,
      keys: []
    };

    if (animPreset === 0) {
      // 1_Blur_Up.json: Offset Y Rebound Out + Blur Fade-In
      const dy = Math.round((isBig ? 110 : 48) * fitScale);
      const overshootY = Math.round((isBig ? -4 : -2) * fitScale);
      const blur0 = isBig ? 18 : 9;
      const durAnim = isBig ? 400 : 290;

      const tAlphaMid = t + Math.round(durAnim * 0.24);
      const tPeak = t + Math.round(durAnim * 0.68);
      const tEnd = t + durAnim;

      el.keys = [
        { t: 0,         a: 0,    blur: blur0,                  x, y: y + dy,                   sx: 100, sy: 100, rot: 0 },
        { t,            a: 0,    blur: blur0,                  x, y: y + dy,                   sx: 100, sy: 100, rot: 0 },
        { t: tAlphaMid, a: 0.89, blur: Math.round(blur0 * 0.35), x, y: y + Math.round(dy * 0.22), sx: 100, sy: 100, rot: 0 },
        { t: tPeak,     a: 1,    blur: 0,                      x, y: y + overshootY,           sx: 100, sy: 100, rot: 0 },
        { t: tEnd,      a: 1,    blur: 0,                      x, y,                           sx: 100, sy: 100, rot: 0 }
      ];
    } else if (animPreset === 1) {
      // 2.Light_Zoom In.json: Circular Ease Scale + Rotasi 0.23 deg
      const startScale = isBig ? 34 : 68;
      const rot0 = isBig ? 0.23 : 0.10;
      const blur0 = isBig ? 12 : 6;
      const durAnim = isBig ? 450 : 320;

      const tMid1 = t + Math.round(durAnim * 0.35);
      const tMid2 = t + Math.round(durAnim * 0.72);
      const tEnd = t + durAnim;

      el.keys = [
        { t: 0,     a: 0,    blur: blur0,                  x, y, sx: startScale, sy: startScale, rot: rot0 },
        { t,        a: 0,    blur: blur0,                  x, y, sx: startScale, sy: startScale, rot: rot0 },
        { t: tMid1, a: 0.68, blur: Math.round(blur0 * 0.4), x, y, sx: Math.round(startScale + (100 - startScale) * 0.65), sy: Math.round(startScale + (100 - startScale) * 0.65), rot: rot0 * 0.5 },
        { t: tMid2, a: 0.96, blur: 0,                      x, y, sx: Math.round(startScale + (100 - startScale) * 0.93), sy: Math.round(startScale + (100 - startScale) * 0.93), rot: rot0 * 0.15 },
        { t: tEnd,  a: 1,    blur: 0,                      x, y, sx: 100,        sy: 100,        rot: 0 }
      ];
    } else {
      // 3_Left_Hazy.json: Circular Ease Slide + Hazy Drop Delayed Fade
      const dx = hazyDir * Math.round((isBig ? 90 : 45) * fitScale);
      const rot0 = hazyDir * 0.23;
      const blur0 = isBig ? 15 : 8;
      const durAnim = isBig ? 440 : 310;

      const tFadeStart = t + Math.round(durAnim * 0.15);
      const tMid = t + Math.round(durAnim * 0.62);
      const tEnd = t + durAnim;

      el.keys = [
        { t: 0,          a: 0,    blur: blur0,                   x: x + dx,                       y, sx: 100, sy: 100, rot: rot0 },
        { t,             a: 0,    blur: blur0,                   x: x + dx,                       y, sx: 100, sy: 100, rot: rot0 },
        { t: tFadeStart, a: 0.08, blur: Math.round(blur0 * 0.75), x: x + Math.round(dx * 0.68), y, sx: 100, sy: 100, rot: rot0 * 0.7 },
        { t: tMid,       a: 0.85, blur: Math.round(blur0 * 0.2),  x: x + Math.round(dx * 0.14), y, sx: 100, sy: 100, rot: rot0 * 0.2 },
        { t: tEnd,       a: 1,    blur: 0,                       x,                              y, sx: 100, sy: 100, rot: 0 }
      ];
    }

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((rw) => {
    if (!rw.items.length) return;
    const h = Math.max(...rw.items.map((it) => it.px));
    const cy = y + h / 2;
    const currentRowW = rowW(rw.items);

    let x = cx - currentRowW / 2;
    if (rw.align === 'blockLeft') {
      x = blockStartX;
    } else if (rw.align === 'indentRight') {
      x = Math.min(1080 - 70 - currentRowW, blockStartX + blockW * 0.22);
    }

    rw.items.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - it.px) * 0.35;
      els.push(
        createWordEl(
          it,
          x + ww / 2,
          cy + baselineOffset,
          times[it.idx]
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: EditorialSerifKinetic.txt
// Nama Gaya Sosmed : Editorial Serif Kinetic Multi-Layout / Modern Founder Podcast Captions
// Karakteristik : 8 variasi penempatan kata organik persis video referensi (piramida terbalik 1-kecil + 2-besar, tangga asimetris kiri/kanan, kata lanjutan kecil menempel di baseline kanan/atas, 2 baris besar staggered, hingga mode flat 1-baris sans-serif naratif).
// Font Wajib : Times New Roman, Georgia, Helvetica Neue
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, solid #FFFFFF)
// Chunk: 2-5

function capEditorialSerifKinetic(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorial_serif_multi|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_SERIF = 'Times New Roman';
  const FONT_SANS = 'Helvetica Neue Regular';
  const TRACK_SERIF = -0.045;
  const TRACK_SANS = -0.02;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1190;
  const basePx = (o.px || 105) * (o.k || 1);

  let bigPx = Math.round(basePx * 0.94);
  let medPx = Math.round(basePx * 0.72);
  let smallPx = Math.max(Math.round(basePx * 0.35), 28);
  let flatPx = Math.max(Math.round(basePx * 0.39), 31);

  const hasPunct = /[?!]/.test(text);
  const v1 = r();
  const v2 = r();

  // Mode Flat 1 Baris Sans-Serif muncul ~22% pada kalimat naratif 3-5 kata tanpa tanda tanya/seru
  const isFlatMode = !hasPunct && raw.length >= 3 && raw.length <= 5 && v1 < 0.22;

  // Struktur baris: { align: 'center' | 'left-of-next' | 'right-of-next' | 'shift-left' | 'shift-right', wideSpace?, items: [{ word, idx, size, font, track, vAlign }] }
  const rows = [];

  if (isFlatMode) {
    // MODE FLAT (image_e6567d): 1 baris datar Sans-Serif bersih, rata tengah
    rows.push({
      align: 'center',
      items: raw.map((w, i) => ({ word: w, idx: i, size: 'flat', font: FONT_SANS, track: TRACK_SANS, vAlign: 'center' }))
    });
  } else if (raw.length === 1) {
    // 1 KATA TUNGGAL (seperti "karena..." atau "purpose")
    rows.push({
      align: 'center',
      items: [{ word: raw[0], idx: 0, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
    });
  } else if (raw.length === 2) {
    // 2 KATA -> 3 variasi berbeda (bukan 1 pola terus!)
    if (v2 < 0.36) {
      // Variasi 2A ("maunya" / "apa?"): 2 baris sama-sama BESAR, baris ke-2 geser kanan
      rows.push({
        align: 'shift-left',
        items: [{ word: raw[0], idx: 0, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'shift-right',
        items: [{ word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
    } else if (v2 < 0.70) {
      // Variasi 2B ("atau" kecil di atas / "KPI" besar di bawah)
      rows.push({
        align: 'center',
        items: [{ word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [{ word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
    } else {
      // Variasi 2C ("Job" besar di atas / "Scorecard" besar di bawah)
      rows.push({
        align: 'center',
        items: [{ word: raw[0], idx: 0, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [{ word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
    }
  } else if (raw.length === 3) {
    // 3 KATA -> 4 variasi berbeda sesuai video!
    if (v2 < 0.28) {
      // Variasi 3A ("lu" kecil rata kiri di atas / "gak jelas" besar di bawah - image_e6565b)
      rows.push({
        align: 'left-of-next',
        items: [{ word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
    } else if (v2 < 0.56) {
      // Variasi 3B ("hasil" besar + "yang" kecil di kanan atas / "diinginkan" besar di bawah - menit 00:26.5)
      rows.push({
        align: 'center',
        items: [
          { word: raw[0], idx: 0, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[1], idx: 1, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'top' }
        ]
      });
      rows.push({
        align: 'center',
        items: [{ word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
    } else if (v2 < 0.80) {
      // Variasi 3C ("purpose" besar di atas / "of the" kecil spasi lebar di bawah - menit 00:24.0)
      rows.push({
        align: 'center',
        items: [{ word: raw[0], idx: 0, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        wideSpace: true,
        items: [
          { word: raw[1], idx: 1, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[2], idx: 2, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
    } else {
      // Variasi 3D ("desired" besar di atas / "resultnya" besar + "ini" kecil baseline di kanan - menit 00:37.0)
      rows.push({
        align: 'shift-left',
        items: [{ word: raw[0], idx: 0, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[2], idx: 2, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'baseline' }
        ]
      });
    }
  } else if (raw.length === 4) {
    // 4 KATA -> 4 variasi berbeda sesuai video!
    if (v2 < 0.28) {
      // Variasi 4A ("kayak mungkin" / "gua juga" kecil center di atas + "di awal" / "gak jelas" besar - image_e6563f)
      rows.push({
        align: 'center',
        wideSpace: true,
        items: [
          { word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[1], idx: 1, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[3], idx: 3, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
    } else if (v2 < 0.56) {
      // Variasi 4B ("gua juga" kecil di atas kiri + "gak jelas" besar + "sih" kecil baseline di kanan - menit 00:08.0)
      rows.push({
        align: 'left-of-next',
        wideSpace: true,
        items: [
          { word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[1], idx: 1, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[3], idx: 3, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'baseline' }
        ]
      });
    } else if (v2 < 0.80) {
      // Variasi 4C ("kayaknya" kecil geser kanan atas / "salah gua" besar / "deh" kecil di bawah kanan - menit 00:09.0)
      rows.push({
        align: 'right-of-next',
        items: [{ word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      rows.push({
        align: 'shift-right',
        items: [{ word: raw[3], idx: 3, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
    } else {
      // Variasi 4D ("dan" kecil kiri atas / "sukses" besar / "seperti apa" sedang di bawah - menit 00:36.0)
      rows.push({
        align: 'left-of-next',
        items: [{ word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [{ word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[2], idx: 2, size: 'med', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[3], idx: 3, size: 'med', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
    }
  } else {
    // 5+ KATA -> 3 variasi berbeda sesuai video (bukan cuma 1 pola piramida terus!)
    if (v2 < 0.42) {
      // Variasi 5A (image_e655e1 & image_e65dc0: "Kenapa kita" / "layar kaca" kecil center + 2 baris besar center)
      rows.push({
        align: 'center',
        wideSpace: true,
        items: [
          { word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[1], idx: 1, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[3], idx: 3, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      rows.push({
        align: 'center',
        items: raw.slice(4).map((w, i) => ({ word: w, idx: 4 + i, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }))
      });
    } else if (v2 < 0.74) {
      // Variasi 5B (menit 00:34.5 - Tangga Asimetris: "ini" kecil kiri / "ekspektasi" besar / "kita terhadap" kecil melebar / "posisi lu" kanan)
      rows.push({
        align: 'left-of-next',
        items: [{ word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [{ word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        wideSpace: true,
        items: [
          { word: raw[2], idx: 2, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[3], idx: 3, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      const tailItems = [{ word: raw[4], idx: 4, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }];
      if (raw[5]) {
        tailItems.push({ word: raw[5], idx: 5, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'baseline' });
      }
      rows.push({
        align: 'shift-right',
        items: tailItems
      });
    } else {
      // Variasi 5C (1 kata kecil di atas kiri + keyword besar + sisa kata kecil menyebar di bawah)
      rows.push({
        align: 'left-of-next',
        items: [{ word: raw[0], idx: 0, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }]
      });
      rows.push({
        align: 'center',
        items: [
          { word: raw[1], idx: 1, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' },
          { word: raw[2], idx: 2, size: 'big', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }
        ]
      });
      rows.push({
        align: 'shift-right',
        wideSpace: true,
        items: raw.slice(3).map((w, i) => ({ word: w, idx: 3 + i, size: 'small', font: FONT_SERIF, track: TRACK_SERIF, vAlign: 'center' }))
      });
    }
  }

  const pxOf = (it) => {
    if (it.size === 'big') return bigPx;
    if (it.size === 'med') return medPx;
    if (it.size === 'flat') return flatPx;
    return smallPx;
  };

  const spaceW = (it, wideSpace) => {
    const mult = wideSpace ? 1.42 : (it.size === 'flat' ? 0.95 : 0.76);
    return widthPx(' ', it.font, pxOf(it)) * mult;
  };

  const wOf = (it) => widthPx(it.word, it.font, pxOf(it)) * (1 + it.track);
  const rowW = (row) => row.items.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it, row.wideSpace) : 0), 0);

  // Auto-fit terhadap MAXW = 860
  const maxRowWidth = Math.max(...rows.map(rowW), 1);
  const targetMaxW = isFlatMode ? Math.min(MAXW, 760) : Math.min(MAXW, 740);
  const fitScale = Math.min(1, targetMaxW / maxRowWidth);
  bigPx *= fitScale;
  medPx *= fitScale;
  smallPx *= fitScale;
  flatPx *= fitScale;

  // Tight leading (-0.13) sehingga baris bertumpuk rapat persis referensi
  const gap = isFlatMode ? 0 : Math.round(-bigPx * 0.13);
  const hazyDir = r() > 0.5 ? 1 : -1;

  const createWordEl = (w, font, px, track, x, y, t, size, idx) => {
    const el = {
      kind: 'text',
      text: w,
      font,
      px,
      fsp: track * px,
      color: '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      x,
      y,
      rot: 0,
      keys: []
    };

    const isBig = size === 'big' || size === 'med';

    if (size === 'flat') {
      const durFlat = 200;
      el.keys = [
        { t: 0,           a: 0, blur: 6, x, y: y + Math.round(16 * fitScale), sx: 100, sy: 100, rot: 0 },
        { t,              a: 0, blur: 6, x, y: y + Math.round(16 * fitScale), sx: 100, sy: 100, rot: 0 },
        { t: t + durFlat, a: 1, blur: 0, x, y,                              sx: 100, sy: 100, rot: 0 }
      ];
    } else if (!isBig && idx % 2 === 1) {
      // Ekstraksi 3_Left_Hazy.json: Circular Ease horizontal + rotasi mikro 0.23 + blur
      const durHazy = 240;
      const tMid = t + Math.round(durHazy * 0.48);
      const tEnd = t + durHazy;
      const offsetX = hazyDir * Math.round(48 * fitScale);
      const rot0 = hazyDir * 0.23;

      el.keys = [
        { t: 0,    a: 0,    blur: 11, x: x + offsetX,        y, sx: 104, sy: 104, rot: rot0 },
        { t,       a: 0,    blur: 11, x: x + offsetX,        y, sx: 104, sy: 104, rot: rot0 },
        { t: tMid, a: 0.78, blur: 3,  x: x + offsetX * 0.14, y, sx: 100, sy: 100, rot: rot0 * 0.15 },
        { t: tEnd, a: 1,    blur: 0,  x,                     y, sx: 100, sy: 100, rot: 0 }
      ];
    } else {
      // Ekstraksi 1_Blur_Up.json & 1_Basic_Up.json: Blur Fade-In + Rebound Out vertikal
      const durUp = isBig ? 260 : 210;
      const tFastAlpha = t + Math.round(durUp * 0.25);
      const tOvershoot = t + Math.round(durUp * 0.70);
      const tEnd = t + durUp;

      const slideY = Math.round((isBig ? 54 : 32) * fitScale);
      const reboundY = -Math.round((isBig ? 4 : 2) * fitScale);
      const blur0 = isBig ? 16 : 9;

      el.keys = [
        { t: 0,          a: 0,    blur: blur0,                    x, y: y + slideY,        sx: 100, sy: 100, rot: 0 },
        { t,             a: 0,    blur: blur0,                    x, y: y + slideY,        sx: 100, sy: 100, rot: 0 },
        { t: tFastAlpha, a: 0.89, blur: Math.round(blur0 * 0.35), x, y: y + slideY * 0.22, sx: 100, sy: 100, rot: 0 },
        { t: tOvershoot, a: 0.98, blur: 1,                        x, y: y + reboundY,      sx: 100, sy: 100, rot: 0 },
        { t: tEnd,       a: 1,    blur: 0,                        x, y,                   sx: 100, sy: 100, rot: 0 }
      ];
    }

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((row, rowIdx) => {
    const h = Math.max(...row.items.map(pxOf));
    const rw = rowW(row);
    const cy = y + h / 2;

    // Posisi horizontal dinamis per baris mengikuti 8 archetype video
    let startX = cx - rw / 2;
    if (row.align === 'left-of-next' && rows[rowIdx + 1]) {
      const nextW = rowW(rows[rowIdx + 1]);
      startX = (cx - nextW / 2) + Math.round(16 * fitScale);
    } else if (row.align === 'right-of-next' && rows[rowIdx + 1]) {
      const nextW = rowW(rows[rowIdx + 1]);
      startX = (cx + nextW / 2) - rw - Math.round(16 * fitScale);
    } else if (row.align === 'shift-left') {
      startX = cx - rw / 2 - Math.round(32 * fitScale);
    } else if (row.align === 'shift-right') {
      startX = cx - rw / 2 + Math.round(44 * fitScale);
    }

    startX = Math.max(70, Math.min(1080 - 70 - rw, startX));

    let x = startX;
    row.items.forEach((it) => {
      const ww = wOf(it);
      let vShift = 0;
      if (it.vAlign === 'baseline') {
        vShift = (h - pxOf(it)) * 0.36; // Menempel di bawah sejajar baseline huruf besar ("sih", "lu", "ini")
      } else if (it.vAlign === 'top') {
        vShift = -(h - pxOf(it)) * 0.30; // Menempel di kanan atas huruf besar ("yang" di "hasil yang")
      }

      els.push(
        createWordEl(
          it.word,
          it.font,
          pxOf(it),
          it.track,
          x + ww / 2,
          cy + vShift,
          times[it.idx],
          it.size,
          it.idx
        )
      );
      x += ww + spaceW(it, row.wideSpace);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: FusionCleanGlow.txt
// Nama Gaya Sosmed : DaVinci Fusion Clean Center-Stacked Glow / Minimalist Editorial White Captions
// Karakteristik : Blok 1-3 baris bertumpuk simetris rata tengah (Center-Aligned), ketebalan seragam Medium/SemiBold dengan kontras skala ukuran (baris pendukung 55%, baris utama 100%), tracking & spasi kata ekstra rapat, dan Soft White Diffuse Glow.
// Font Wajib : Inter SemiBold, Inter Medium
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, soft white glow merata)
// Chunk: 1-4

function capFusionCleanGlow(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`fusion_clean_glow_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // Ketebalan seragam Medium/SemiBold di seluruh kata (sesuai video referensi)
  const FONT_MAIN = 'Inter SemiBold';
  const FONT_SUB = 'Inter Medium';
  const TRACK = -0.058; // Huruf sangat rapat nyaris bersentuhan
  const MAXW = 860;

  const cx = o.cx ?? 540;
  // Penempatan default di tengah kanvas (area dada / eye-line subjek)
  const topY = o.top ?? 960;
  const basePx = (o.px || 105) * (o.k || 1);

  let bigPx = Math.round(basePx * 0.78);
  let smallPx = Math.max(Math.round(basePx * 0.44), 30);

  // Susun baris (mendukung 1 baris, 2 baris stacked, hingga 3 baris stacked)
  const rows = [];

  if (raw.length === 1) {
    rows.push([{ word: raw[0], idx: 0, big: true, isKey: true }]);
  } else if (raw.length === 2) {
    if (ki === 0) {
      // Contoh: "10 minutes", "Save this", "Now simply", "right-click" -> 1 baris besar rapat
      rows.push([
        { word: raw[0], idx: 0, big: true, isKey: true },
        { word: raw[1], idx: 1, big: true, isKey: false }
      ]);
    } else {
      // Contoh: "These / Text", "them / faster?", "This / simple", "A real / saver." -> 2 baris center stacked
      rows.push([{ word: raw[0], idx: 0, big: false, isKey: false }]);
      rows.push([{ word: raw[1], idx: 1, big: true, isKey: true }]);
    }
  } else if (raw.length === 3) {
    if (ki === 0) {
      // Contoh: "DaVinci / trick" atau "10 minutes / each" -> 2 kata besar di atas + 1 kata di bawah
      rows.push([
        { word: raw[0], idx: 0, big: true, isKey: true },
        { word: raw[1], idx: 1, big: true, isKey: false }
      ]);
      rows.push([{ word: raw[2], idx: 2, big: false, isKey: false }]);
    } else if (ki === 1) {
      // Contoh: "These / Text animations", "hours / every week.", "your / text animation", "It's / super easy"
      rows.push([{ word: raw[0], idx: 0, big: false, isKey: false }]);
      rows.push([
        { word: raw[1], idx: 1, big: true, isKey: true },
        { word: raw[2], idx: 2, big: true, isKey: false }
      ]);
    } else {
      // Contoh: "Here is / exactly / how:" atau "to the / edit tab."
      rows.push([
        { word: raw[0], idx: 0, big: false, isKey: false },
        { word: raw[1], idx: 1, big: false, isKey: false }
      ]);
      rows.push([{ word: raw[2], idx: 2, big: true, isKey: true }]);
    }
  } else {
    // 4+ kata: pola 3 baris bertumpuk rapat seperti "Here is / exactly / how:" atau "and it / save / forever."
    const split1 = Math.min(ki, 2);
    if (split1 > 0) {
      rows.push(
        raw.slice(0, split1).map((w, i) => ({ word: w, idx: i, big: false, isKey: false }))
      );
    }
    const rest = raw.slice(split1);
    if (rest.length >= 2) {
      rows.push([{ word: rest[0], idx: split1, big: true, isKey: true }]);
      rows.push(
        rest.slice(1).map((w, j) => ({
          word: w,
          idx: split1 + 1 + j,
          big: true,
          isKey: false
        }))
      );
    } else {
      rows.push(
        rest.map((w, j) => ({
          word: w,
          idx: split1 + j,
          big: true,
          isKey: j === 0
        }))
      );
    }
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => (it.big ? FONT_MAIN : FONT_SUB);

  // Spasi antar kata dipersempit (0.42x) agar rapat seperti "Text animations" & "every week." di video
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.42;
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(...rows.map((rw) => rowW(rw)), 1);
  const targetMaxW = Math.min(MAXW, 640);
  const fitScale = Math.min(1, targetMaxW / maxRowWidth);
  bigPx *= fitScale;
  smallPx *= fitScale;

  // Jarak antar baris negatif agar tumpukan atas-bawah menempel rapat
  const gap = Math.round(-basePx * 0.14 * fitScale);
  const blockW = Math.max(...rows.map((rw) => rowW(rw)), 1);
  const blockStartX = Math.max(70, Math.min(1080 - 70 - blockW, cx - blockW / 2));

  // Pilih pola animasi per chunk agar konsisten namun bervariasi alami sepanjang video
  const chunkAnimStyle = Math.floor(r() * 3);

  const createWordEl = (w, font, px, x, y, t, isBig, isKey, wordIdx, rowIdx) => {
    const el = {
      kind: 'text',
      text: w,
      font,
      px,
      fsp: TRACK * px,
      color: '#FFFFFF',
      oc: '#FFFFFF',
      ow: 0,
      sd: 0,
      shade: false,
      glowColor: '#FFFFFF',
      glowBlur: isKey ? 21 : 17,
      glowAlpha: isKey ? 0.44 : 0.36,
      x,
      y,
      rot: 0,
      keys: []
    };

    let startX = x;
    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let blur0 = isBig ? 12 : 9;
    let rot0 = 0;

    // Timing cepat & halus sesuai video referensi (220-290ms)
    const animDur = isBig ? 280 : 230;
    const tMid = t + Math.round(animDur * 0.58);
    const tEnd = t + animDur;

    if (chunkAnimStyle === 0) {
      // Pola 1 (1_Blur_Up): Dorongan vertikal lembut dari bawah ke atas + blur memudar
      startY = y + Math.round((isBig ? 54 : 36) * fitScale);
    } else if (chunkAnimStyle === 1) {
      // Pola 2 (3_Left_Hazy + 1_Blur_Up): Kata utama naik vertikal, kata lanjutan menyamping halus ke posisi
      if (wordIdx === 0 && rowIdx === 0) {
        startY = y + Math.round(44 * fitScale);
      } else {
        const dir = wordIdx % 2 === 1 ? 1 : -1;
        startX = x + dir * Math.round(46 * fitScale);
        rot0 = dir * 0.23; // Rotasi mikro dari 3_Left_Hazy.json
      }
    } else {
      // Pola 3 (2.Light_Zoom In): Scale halus masuk dari 78% ke 100% + sedikit dorongan naik
      startY = y + Math.round(24 * fitScale);
      startSx = 78;
      startSy = 78;
    }

    // Kurva Rebound Out & Circular Ease dari JSON (mendarat halus tanpa pantulan kasar)
    const midX = x + (startX - x) * 0.08;
    const midY = startY > y
      ? y - Math.round(2 * fitScale)
      : y + (startY - y) * 0.08;
    const midSx = startSx < 100 ? 101.5 : 100;
    const midSy = startSy < 100 ? 101.5 : 100;

    el.keys = [
      { t: 0,    a: 0,    blur: blur0,                 x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0 },
      { t,       a: 0,    blur: blur0,                 x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0 },
      { t: tMid, a: 0.94, blur: Math.round(blur0 * 0.2), x: midX,   y: midY,   sx: midSx,   sy: midSy,   rot: rot0 * 0.15 },
      { t: tEnd, a: 1,    blur: 0,                     x: x,      y: y,      sx: 100,     sy: 100,     rot: 0 }
    ];

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((row, rIdx) => {
    if (!row.length) return;
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    const rw = rowW(row);
    // Semua baris selalu simetris rata tengah (Center-Aligned) seperti di video
    let x = Math.max(blockStartX, cx - rw / 2);

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      els.push(
        createWordEl(
          it.word,
          fontOf(it),
          pxOf(it),
          x + ww / 2,
          cy + baselineOffset,
          times[it.idx],
          it.big,
          it.isKey,
          it.idx,
          rIdx
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: GaramondEditorialHybrid.txt
// Nama Gaya Sosmed : Editorial Garamond & Sans-Serif Hybrid / Personal Branding Reels
// Karakteristik : Kontras dinamis ITC Garamond Book Italic besar kuning neon (#E5FF29) lowercase + Sans-Serif Medium putih UPPERCASE kecil dengan 5 variasi pola tata letak (Pill Narasi, Hero Staggered, Side-by-Side Stack, Spread Horizontal, Multi-Tier Hook) dan transisi Rebound/Blur-Up halus.
// Font Wajib : ITC Garamond Std Book Italic, Times New Roman Italic, Apfel Grotezk Medium, Helvetica Neue Medium
// Mode Blend : Normal (ow: 0, sd: 2 halus pada keyword serif, pill hitam solid #0B0B0B pada mode narasi)
// Chunk: 1-5

function capGaramondEditorialHybrid(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`garamond_editorial|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // Hierarki Tipografi sesuai video referensi
  const FONT_KEY = 'Instrument Serif Italic'; // Keyword utama: Serif Italic ramping (bukan Bold)
  const FONT_REG = 'Helvetica Neue Medium';        // Pendukung & Pill: Sans-Serif Medium tegas

  const TRACK_KEY = -0.04; // Tracking rapat untuk Garamond Italic
  const TRACK_REG = -0.01; // Tracking bersih untuk Sans-Serif UPPERCASE
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1160;
  const basePx = (o.px || 105) * (o.k || 1);

  const HIGHLIGHT_COLOR = '#E5FF29'; // Electric Lime-Yellow khas video referensi
  const WHITE_COLOR = '#FFFFFF';
  const PILL_BG_COLOR = '#0B0B0B';

  // Helper keyframe builder berdasarkan kurva Rebound Out & Blur-Up dari JSON
  const buildKeys = (x, y, t, mode, isKey) => {
    // Ekstraksi timing Rebound Out (33ms -> 600ms diskalakan ke durasi caption proporsional ~220-340ms)
    const durAnim = isKey ? 320 : 210;
    const t0 = Math.max(0, t);
    const tMid = t0 + Math.round(durAnim * 0.48); // Rebound Out cepat di 48% awal
    const tEnd = t0 + durAnim;

    let startX = x;
    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let blur0 = 0;

    if (mode === 'up') {
      // Dari 1_Basic_Up.json (offset Y -0.12587 -> disesuaikan proporsional ke kanvas)
      startY = y + (isKey ? 44 : 22);
      blur0 = isKey ? 5 : 2;
    } else if (mode === 'blur_up') {
      // Dari 1_Blur_Up.json (Blur Fade-In + subtle rise)
      startY = y + (isKey ? 28 : 14);
      blur0 = isKey ? 12 : 6;
    } else if (mode === 'zoom_in') {
      // Dari 2.Basic_Zoom In.json (Circular Ease scale-in clean tanpa overshoot)
      startSx = isKey ? 88 : 94;
      startSy = isKey ? 88 : 94;
      blur0 = isKey ? 4 : 0;
    } else {
      // Cut-in cepat untuk narasi pill bar
      startY = y + 10;
      blur0 = 0;
    }

    // Rebound Out ease-out curve (89% progres tercapai di tMid seperti kontrol JSON: y=0.89)
    const midX = x + (startX - x) * 0.11;
    const midY = y + (startY - y) * 0.11;
    const midSx = 100 + (startSx - 100) * 0.11;
    const midSy = 100 + (startSy - 100) * 0.11;

    return [
      { t: 0,    a: 0,    blur: blur0,               x: startX, y: startY, sx: startSx, sy: startSy, rot: 0 },
      { t: t0,   a: 0,    blur: blur0,               x: startX, y: startY, sx: startSx, sy: startSy, rot: 0 },
      { t: tMid, a: 0.92, blur: Math.round(blur0 * 0.18), x: midX,   y: midY,   sx: midSx,   sy: midSy,   rot: 0 },
      { t: tEnd, a: 1,    blur: 0,                   x: x,      y: y,      sx: 100,     sy: 100,     rot: 0 }
    ];
  };

  const els = [];
  let yBottom = topY;

  // Memilih 1 dari 5 pola video referensi secara otomatis berdasarkan jumlah kata & seed rng()
  const n = raw.length;
  const roll = r();
  let pattern = 'A'; // Default: Pill Hitam Narasi Reguler

  if (n === 1) {
    pattern = 'B'; // Single Keyword Hero (Serif kuning besar di tengah)
  } else if (n === 2) {
    pattern = roll < 0.72 ? 'B' : 'A'; // Dual Keyword Staggered ("ga / masalah") atau Pill
  } else if (n === 3) {
    if (roll < 0.35) pattern = 'C';      // Side-by-Side ("ngedit" + "MACEM / MACEM")
    else if (roll < 0.60) pattern = 'D'; // Spread Horizontal ("GA — ADA — WAKTU")
    else pattern = 'A';                  // Pill Hitam ("KALAU KALIAN MAGER")
  } else {
    // 4 - 5+ kata
    if (roll < 0.45) pattern = 'E';      // Multi-Tier Editorial Hook (Atas Sans + Tengah Serif + Bawah Sans)
    else if (roll < 0.75) pattern = 'C'; // Side-by-Side Contrast ("CONTOHNYA / JADI" + "kaya / gini")
    else pattern = 'A';                  // Pill Hitam ("INI BEBERAPA SOUND EFFECTS")
  }

  // =========================================================================
  // POLA A: NARASI REGULER (1 Baris Utuh dengan Background Pill Hitam #0B0B0B)
  // =========================================================================
  if (pattern === 'A') {
    const smallPx = Math.max(Math.round(basePx * 0.36), 28);
    const fullText = raw.map((w) => w.toUpperCase()).join(' ');
    const textW = widthPx(fullText, FONT_REG, smallPx) * (1 + TRACK_REG);
    const fit = Math.min(1, MAXW / Math.max(textW, 1));
    const px = Math.round(smallPx * fit);
    const finalW = widthPx(fullText, FONT_REG, px) * (1 + TRACK_REG);

    const padX = Math.round(18 * fit);
    const padY = Math.round(9 * fit);
    const boxW = Math.round(finalW + padX * 2);
    const boxH = Math.round(px + padY * 2);
    const boxY = topY + Math.round(120 * fit); // Posisi tengah-bawah area dada
    const centerY = boxY + boxH / 2;
    const tStart = times[0] ?? 0;

    // Rect Pill Hitam muncul bersamaan satu baris utuh
    els.push({
      kind: 'rect',
      x: cx,
      y: centerY,
      w: boxW,
      h: boxH,
      r: 6,
      color: PILL_BG_COLOR,
      rot: 0,
      keys: buildKeys(cx, centerY, tStart, 'cut', false)
    });

    els.push({
      kind: 'text',
      text: fullText,
      font: FONT_REG,
      px,
      fsp: TRACK_REG * px,
      color: WHITE_COLOR,
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      x: cx,
      y: centerY,
      rot: 0,
      keys: buildKeys(cx, centerY, tStart, 'cut', false)
    });

    yBottom = boxY + boxH;
    return { elements: els, box: { top: boxY, bottom: yBottom } };
  }

  // =========================================================================
  // POLA B: SINGLE / DUAL KEYWORD HERO (Serif Kuning Besar Lowercase)
  // =========================================================================
  if (pattern === 'B') {
    let bigPx = Math.round(basePx * 1.38); // ~145px di 1080x1920
    const words = raw.slice(0, 2).map((w) => w.toLowerCase());
    const widths = words.map((w) => widthPx(w, FONT_KEY, bigPx) * (1 + TRACK_KEY));
    const maxW = Math.max(...widths, 1);
    const fit = Math.min(1, MAXW / maxW);
    bigPx = Math.round(bigPx * fit);

    const animMode = r() > 0.5 ? 'blur_up' : 'zoom_in';
    let curY = topY;

    words.forEach((w, idx) => {
      const ww = widthPx(w, FONT_KEY, bigPx) * (1 + TRACK_KEY);
      // Jika 2 kata, kata kedua turun rapat & bergeser sedikit ke kanan (staggered)
      const offsetX = words.length === 2 ? (idx === 0 ? -Math.round(36 * fit) : Math.round(48 * fit)) : 0;
      const posX = Math.max(90 + ww / 2, Math.min(1080 - 90 - ww / 2, cx + offsetX));
      const posY = curY + bigPx / 2;

      els.push({
        kind: 'text',
        text: w,
        font: FONT_KEY,
        px: bigPx,
        fsp: TRACK_KEY * bigPx,
        color: HIGHLIGHT_COLOR,
        oc: '#000000',
        ow: 0,
        sd: 2,
        shade: true,
        x: posX,
        y: posY,
        rot: 0,
        keys: buildKeys(posX, posY, times[idx] ?? idx * 180, animMode, true)
      });

      curY += Math.round(bigPx * 0.78); // Tight leading menempel estetis
    });

    yBottom = curY + Math.round(bigPx * 0.22);
    return { elements: els, box: { top: topY, bottom: yBottom } };
  }

  // =========================================================================
  // POLA C: SIDE-BY-SIDE CONTRAST (Serif Kuning Kiri + Sans Stack 2 Baris Kanan)
  // =========================================================================
  if (pattern === 'C') {
    const keyIdx = Math.min(ki, raw.length - 1);
    const keyWord = raw[keyIdx].toLowerCase();
    const otherWords = raw.filter((_, idx) => idx !== keyIdx).map((w) => w.toUpperCase());

    let bigPx = Math.round(basePx * 1.25);
    let smallPx = Math.max(Math.round(basePx * 0.36), 28);

    const keyW = widthPx(keyWord, FONT_KEY, bigPx) * (1 + TRACK_KEY);
    // Bagi kata pelengkap menjadi 2 baris bertumpuk rapat di sisi kanan
    const midSplit = Math.ceil(otherWords.length / 2);
    const stackLine1 = otherWords.slice(0, midSplit).join(' ');
    const stackLine2 = otherWords.slice(midSplit).join(' ');

    const s1W = stackLine1 ? widthPx(stackLine1, FONT_REG, smallPx) * (1 + TRACK_REG) : 0;
    const s2W = stackLine2 ? widthPx(stackLine2, FONT_REG, smallPx) * (1 + TRACK_REG) : 0;
    const rightColW = Math.max(s1W, s2W);
    const colGap = 24;

    const totalW = keyW + (rightColW > 0 ? colGap + rightColW : 0);
    const fit = Math.min(1, MAXW / Math.max(totalW, 1));

    bigPx = Math.round(bigPx * fit);
    smallPx = Math.round(smallPx * fit);
    const finalKeyW = widthPx(keyWord, FONT_KEY, bigPx) * (1 + TRACK_KEY);
    const finalRightW = Math.max(
      stackLine1 ? widthPx(stackLine1, FONT_REG, smallPx) * (1 + TRACK_REG) : 0,
      stackLine2 ? widthPx(stackLine2, FONT_REG, smallPx) * (1 + TRACK_REG) : 0
    );
    const finalTotalW = finalKeyW + (finalRightW > 0 ? Math.round(colGap * fit) + finalRightW : 0);
    const blockStartX = Math.max(70, Math.min(1080 - 70 - finalTotalW, cx - finalTotalW / 2));

    const keyX = blockStartX + finalKeyW / 2;
    const keyY = topY + bigPx / 2;

    els.push({
      kind: 'text',
      text: keyWord,
      font: FONT_KEY,
      px: bigPx,
      fsp: TRACK_KEY * bigPx,
      color: HIGHLIGHT_COLOR,
      oc: '#000000',
      ow: 0,
      sd: 2,
      shade: true,
      x: keyX,
      y: keyY,
      rot: 0,
      keys: buildKeys(keyX, keyY, times[keyIdx] ?? 0, 'blur_up', true)
    });

    if (finalRightW > 0) {
      const rightStartX = blockStartX + finalKeyW + Math.round(colGap * fit);
      const lineGap = Math.round(4 * fit);
      const stackH = stackLine2 ? smallPx * 2 + lineGap : smallPx;
      const stackTopY = keyY - stackH / 2 + Math.round(6 * fit);

      if (stackLine1) {
        const w1 = widthPx(stackLine1, FONT_REG, smallPx) * (1 + TRACK_REG);
        const t1 = times[keyIdx === 0 ? 1 : 0] ?? 120;
        els.push({
          kind: 'text',
          text: stackLine1,
          font: FONT_REG,
          px: smallPx,
          fsp: TRACK_REG * smallPx,
          color: WHITE_COLOR,
          oc: '#000000',
          ow: 0,
          sd: 1,
          shade: true,
          x: rightStartX + w1 / 2,
          y: stackTopY + smallPx / 2,
          rot: 0,
          keys: buildKeys(rightStartX + w1 / 2, stackTopY + smallPx / 2, t1, 'up', false)
        });
      }

      if (stackLine2) {
        const w2 = widthPx(stackLine2, FONT_REG, smallPx) * (1 + TRACK_REG);
        const t2 = times[raw.length - 1] ?? 240;
        els.push({
          kind: 'text',
          text: stackLine2,
          font: FONT_REG,
          px: smallPx,
          fsp: TRACK_REG * smallPx,
          color: WHITE_COLOR,
          oc: '#000000',
          ow: 0,
          sd: 1,
          shade: true,
          x: rightStartX + w2 / 2,
          y: stackTopY + smallPx + lineGap + smallPx / 2,
          rot: 0,
          keys: buildKeys(rightStartX + w2 / 2, stackTopY + smallPx + lineGap + smallPx / 2, t2, 'up', false)
        });
      }
    }

    yBottom = topY + bigPx;
    return { elements: els, box: { top: topY, bottom: yBottom } };
  }

  // =========================================================================
  // POLA D: SPREAD HORIZONTAL ("GA — ADA — WAKTU" Menyebar Sejajar Lebar)
  // =========================================================================
  if (pattern === 'D') {
    let smallPx = Math.max(Math.round(basePx * 0.38), 30);
    const words = raw.map((w) => w.toUpperCase());
    const wordWidths = words.map((w) => widthPx(w, FONT_REG, smallPx) * (1 + TRACK_REG));
    const sumWordsW = wordWidths.reduce((a, b) => a + b, 0);

    // Menyebar memenuhi lebar aman kanvas (target lebar ~760px)
    const targetSpreadW = Math.min(MAXW, 760);
    const spreadGap = words.length > 1 ? Math.max(40, (targetSpreadW - sumWordsW) / (words.length - 1)) : 0;
    const totalW = sumWordsW + spreadGap * (words.length - 1);
    const fit = Math.min(1, MAXW / Math.max(totalW, 1));

    smallPx = Math.round(smallPx * fit);
    const finalSpreadGap = spreadGap * fit;
    let curX = cx - (totalW * fit) / 2;
    const posY = topY + Math.round(40 * fit);

    words.forEach((w, idx) => {
      const ww = widthPx(w, FONT_REG, smallPx) * (1 + TRACK_REG);
      const wordCx = curX + ww / 2;

      els.push({
        kind: 'text',
        text: w,
        font: FONT_REG,
        px: smallPx,
        fsp: TRACK_REG * smallPx,
        color: WHITE_COLOR,
        oc: '#000000',
        ow: 0,
        sd: 1,
        shade: true,
        x: wordCx,
        y: posY,
        rot: 0,
        keys: buildKeys(wordCx, posY, times[idx] ?? idx * 140, 'up', false)
      });

      curX += ww + finalSpreadGap;
    });

    yBottom = posY + smallPx / 2;
    return { elements: els, box: { top: topY, bottom: yBottom } };
  }

  // =========================================================================
  // POLA E: FULL EDITORIAL MULTI-TIER STACK (Atas Sans + Tengah Serif + Bawah Sans)
  // =========================================================================
  const keyIdx = Math.min(Math.max(ki, 1), raw.length - 2);
  const topWords = raw.slice(0, keyIdx).map((w) => w.toUpperCase());
  const keyWord = raw[keyIdx].toLowerCase();
  const botWords = raw.slice(keyIdx + 1).map((w) => w.toUpperCase());

  let bigPx = Math.round(basePx * 1.28);
  let smallPx = Math.max(Math.round(basePx * 0.35), 27);

  const topStr = topWords.join(' ');
  const botStr = botWords.join(' ');

  const topW = topStr ? widthPx(topStr, FONT_REG, smallPx) * (1 + TRACK_REG) : 0;
  const keyW = widthPx(keyWord, FONT_KEY, bigPx) * (1 + TRACK_KEY);
  const botW = botStr ? widthPx(botStr, FONT_REG, smallPx) * (1 + TRACK_REG) : 0;

  const maxBlockW = Math.max(topW, keyW, botW, 1);
  const fit = Math.min(1, MAXW / maxBlockW);

  bigPx = Math.round(bigPx * fit);
  smallPx = Math.round(smallPx * fit);

  const finalTopW = topStr ? widthPx(topStr, FONT_REG, smallPx) * (1 + TRACK_REG) : 0;
  const finalKeyW = widthPx(keyWord, FONT_KEY, bigPx) * (1 + TRACK_KEY);
  const finalBotW = botStr ? widthPx(botStr, FONT_REG, smallPx) * (1 + TRACK_REG) : 0;

  const blockW = Math.max(finalTopW, finalKeyW, finalBotW);
  const blockStartX = Math.max(85, Math.min(1080 - 85 - blockW, cx - blockW / 2));

  let curY = topY;

  // Baris 1: Konteks Atas (Sans-Serif UPPERCASE rata kiri)
  if (topStr) {
    const posX = blockStartX + finalTopW / 2;
    const posY = curY + smallPx / 2;
    els.push({
      kind: 'text',
      text: topStr,
      font: FONT_REG,
      px: smallPx,
      fsp: TRACK_REG * smallPx,
      color: WHITE_COLOR,
      oc: '#000000',
      ow: 0,
      sd: 1,
      shade: true,
      x: posX,
      y: posY,
      rot: 0,
      keys: buildKeys(posX, posY, times[0] ?? 0, 'up', false)
    });
    curY += smallPx + Math.round(6 * fit);
  }

  // Baris 2: Keyword Utama (ITC Garamond Book Italic besar kuning #E5FF29)
  const keyPosX = blockStartX + finalKeyW / 2;
  const keyPosY = curY + bigPx / 2;
  els.push({
    kind: 'text',
    text: keyWord,
    font: FONT_KEY,
    px: bigPx,
    fsp: TRACK_KEY * bigPx,
    color: HIGHLIGHT_COLOR,
    oc: '#000000',
    ow: 0,
    sd: 2,
    shade: true,
    x: keyPosX,
    y: keyPosY,
    rot: 0,
    keys: buildKeys(keyPosX, keyPosY, times[keyIdx] ?? 150, 'blur_up', true)
  });
  curY += bigPx + Math.round(8 * fit);

  // Baris 3: Lanjutan Bawah (Sans-Serif UPPERCASE rata kiri)
  if (botStr) {
    const posX = blockStartX + finalBotW / 2;
    const posY = curY + smallPx / 2;
    els.push({
      kind: 'text',
      text: botStr,
      font: FONT_REG,
      px: smallPx,
      fsp: TRACK_REG * smallPx,
      color: WHITE_COLOR,
      oc: '#000000',
      ow: 0,
      sd: 1,
      shade: true,
      x: posX,
      y: posY,
      rot: 0,
      keys: buildKeys(posX, posY, times[keyIdx + 1] ?? 300, 'up', false)
    });
    curY += smallPx;
  }

  yBottom = curY;
  return { elements: els, box: { top: topY, bottom: yBottom } };
}
// ---- preset: GlowRevealEditorial.txt
// Nama Gaya Sosmed : Fine Cut Word-by-Word Glow Reveal (Authentic)
// Karakteristik : Setiap kata menyala biru elektrik (#1E78FF) + glow saat aktif diucapkan lalu berubah menjadi putih bersih (#FFFFFF) saat kata berikutnya masuk. Menggabungkan Sans-Serif rapat (-0.052) dan Times New Roman Italic untuk aksen akhir & sub-baris kecil di bawah keyword, dengan micro-slide halus (14px) + blur fade tanpa pantulan.
// Font Wajib : Inter-SB, Times New Roman Italic
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, active-word blue glow transition)
// Chunk: 1-3

function capGlowRevealEditorial(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`finecut_authentic|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const dur = o.dur || 1500;
  const times = wordTimes(raw, dur);

  const FONT_SANS = 'Helvetica Neue Medium';
  const FONT_SERIF_ITALIC = 'Times New Roman Italic';
  const TRACK_SANS = -0.072;
  const TRACK_SERIF = -0.035;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 920;
  const basePx = (o.px || 105) * (o.k || 1);

  const isSingle = raw.length === 1;
  const firstClean = raw[0].replace(/['"“”]/g, '');
  const isAllCapsKey = firstClean === firstClean.toUpperCase() && firstClean.length >= 3;

  // Ukuran presisi sesuai video:
  // - Single word (want / to / save / time): ~60px bersih di tengah
  // - All-caps ('PRESET'): ~124px besar, sub-kata ~50px Sans-Serif
  // - Stacked Keyword ('access' / 'word by word'): ~96px besar, sub-kata ~40px Serif Italic
  let bigPx = Math.round(basePx * (isSingle ? 0.58 : isAllCapsKey ? 1.18 : 0.92));
  let smallPx = Math.max(Math.round(basePx * (isAllCapsKey ? 0.48 : 0.38)), 28);

  const topRow = [];
  const botRow = [];

  if (isSingle) {
    const clean = raw[0].replace(/[.,!?]/g, '').toLowerCase();
    const isItalic =
      /[.!?]$/.test(raw[0]) ||
      clean === 'done' ||
      clean === 'breakdown' ||
      clean === 'create' ||
      clean === 'reveal';
    topRow.push({
      word: raw[0],
      idx: 0,
      big: true,
      isKey: true,
      isItalic
    });
  } else if (raw.length === 2) {
    // 2 kata menyambung rapat horizontal (contoh: "on how", "you can", "glow reveal", "you a link")
    raw.forEach((w, i) => {
      const clean = w.replace(/[.,!?]/g, '').toLowerCase();
      const isSecondItalic =
        i === 1 &&
        (clean === 'reveal' ||
          clean === 'create' ||
          clean === 'breakdown' ||
          clean === 'color' ||
          /[.!?]$/.test(w));
      topRow.push({
        word: w,
        idx: i,
        big: true,
        isKey: i === ki,
        isItalic: isSecondItalic
      });
    });
  } else {
    // 3 kata:
    // Jika kata ke-1 adalah keyword awal ("access to all", "'PRESET' under this"):
    // Baris 1 = Kata ke-1 besar (Sans-Serif)
    // Baris 2 = Kata ke-2 & ke-3 kecil rapat di bawah (Serif Italic jika lowercase keyword, Sans jika UPPERCASE)
    if (ki === 0 || isAllCapsKey) {
      topRow.push({
        word: raw[0],
        idx: 0,
        big: true,
        isKey: true,
        isItalic: false
      });
      for (let i = 1; i < raw.length; i++) {
        botRow.push({
          word: raw[i],
          idx: i,
          big: false,
          isKey: false,
          isItalic: !isAllCapsKey
        });
      }
    } else {
      // Jika kalimat membangun ke akhir ("you can create", "word by word"):
      // Semua kata menyambung 1 baris rapat, kata terakhir Serif Italic jika kata penekanan
      raw.forEach((w, i) => {
        const isLast = i === raw.length - 1;
        const clean = w.replace(/[.,!?]/g, '').toLowerCase();
        const useItalic = isLast && clean.length >= 5 && clean !== 'word' && clean !== 'video';
        topRow.push({
          word: w,
          idx: i,
          big: true,
          isKey: isLast,
          isItalic: useItalic
        });
      });
    }
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => (it.isItalic ? FONT_SERIF_ITALIC : FONT_SANS);
  const trackOf = (it) => (it.isItalic ? TRACK_SERIF : TRACK_SANS);

  // Jarak antar kata sangat rapat (0.66x spasi normal) agar terlihat menyatu padat
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.66;
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(topRow.length ? rowW(topRow) : 0, botRow.length ? rowW(botRow) : 0, 1);
  const fitScale = Math.min(1, MAXW / maxRowWidth);
  bigPx *= fitScale;
  smallPx *= fitScale;

  // Jarak antar baris rapat menempel tepat di bawah baseline baris atas
  const gap = Math.round(-basePx * 0.05 * fitScale);

  const TEXT_WHITE = '#FFFFFF';
  const ACTIVE_BLUE = '#1E78FF';

  // Pilih mode preset Fine Cut: 0 = SLIDE UP (smooth), 1 = SLIDE DOWN (short), 2 = POP UP (blurred)
  const presetMode = Math.floor(r() * 3);

  const pushWordLayers = (els, it, x, y) => {
    const px = pxOf(it);
    const font = fontOf(it);
    const fsp = trackOf(it) * px;
    const tStart = times[it.idx];
    const tNext = it.idx + 1 < times.length ? times[it.idx + 1] : Math.min(dur, tStart + 360);

    // Gerakan super halus 14px tanpa pantulan (sesuai SLIDE UP smooth / SLIDE DOWN short / POP UP blurred)
    const microSlide = Math.round(14 * fitScale);
    let startY = y;
    let startScale = 100;
    let blur0 = 0;

    if (presetMode === 0) {
      startY = y + microSlide; // SLIDE UP (smooth)
      blur0 = 4;
    } else if (presetMode === 1) {
      startY = y - microSlide; // SLIDE DOWN (short)
      blur0 = 4;
    } else {
      startY = y + Math.round(8 * fitScale); // POP UP (blurred)
      startScale = 93;
      blur0 = 12;
    }

    const tInEnd = tStart + 160;
    // Kata tetap menyala biru selama kata itu aktif diucapkan, lalu berubah putih saat kata berikutnya masuk
    const tBlueHold = Math.max(tInEnd + 40, tNext - 30);
    const tBlueFadeOut = tBlueHold + 110;

    // 1. LAYER PUTIH (#FFFFFF) — muncul halus saat fase biru selesai & bertahan sampai akhir chunk
    els.push({
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp,
      color: TEXT_WHITE,
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      glowColor: '#FFFFFF',
      glowBlur: it.isKey ? 10 : 6,
      glowAlpha: 0.22,
      x,
      y,
      rot: 0,
      keys: [
        { t: 0,            a: 0, blur: blur0, x, y: startY, sx: startScale, sy: startScale, rot: 0 },
        { t: tStart,       a: 0, blur: blur0, x, y: startY, sx: startScale, sy: startScale, rot: 0 },
        { t: tInEnd,       a: isSingle ? 1 : 0.2, blur: 0, x, y: y, sx: 100, sy: 100, rot: 0 },
        { t: tBlueHold,    a: isSingle ? 1 : 0.2, blur: 0, x, y: y, sx: 100, sy: 100, rot: 0 },
        { t: tBlueFadeOut, a: 1, blur: 0, x, y: y, sx: 100, sy: 100, rot: 0 }
      ]
    });

    // 2. LAYER BIRU ELEKTRIK + GLOW (#1E78FF) — menyala selama kata aktif diucapkan (Color Replace effect)
    els.push({
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp,
      color: ACTIVE_BLUE,
      oc: ACTIVE_BLUE,
      ow: 0,
      sd: 0,
      shade: false,
      glowColor: ACTIVE_BLUE,
      glowBlur: 18,
      glowAlpha: 0.75,
      x,
      y,
      rot: 0,
      keys: [
        { t: 0,            a: 0, blur: blur0, x, y: startY, sx: startScale, sy: startScale, rot: 0 },
        { t: tStart,       a: 0, blur: blur0, x, y: startY, sx: startScale, sy: startScale, rot: 0 },
        { t: tInEnd,       a: isSingle ? 0.45 : 1, blur: 0, x, y: y, sx: 100, sy: 100, rot: 0 },
        { t: tBlueHold,    a: isSingle ? 0.35 : 1, blur: 0, x, y: y, sx: 100, sy: 100, rot: 0 },
        { t: tBlueFadeOut, a: 0, blur: 0, x, y: y, sx: 100, sy: 100, rot: 0 }
      ]
    });
  };

  const els = [];
  let y = topY;

  const placeCenterRow = (row) => {
    if (!row.length) return;
    const h = Math.max(...row.map(pxOf));
    const cy = y + h / 2;
    const totalW = rowW(row);
    const blockStartX = Math.max(70, Math.min(1080 - 70 - totalW, cx - totalW / 2));
    let x = blockStartX;

    row.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      pushWordLayers(els, it, x + ww / 2, cy + baselineOffset);
      x += ww + spaceW(it);
    });

    y += h + gap;
  };

  placeCenterRow(topRow);
  placeCenterRow(botRow);

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: HelveticaStackedEditorial.txt
// Nama Gaya Sosmed : Helvetica Stacked Editorial Captions / Swiss Minimalist Podcast Captions
// Karakteristik : Blok rata kiri ketat (Left-Aligned Block) di area bahu/dada (x ~150px, y ~1080px) dengan 5 variasi pola tumpukan (2-baris kontras, 3-baris bertumpuk, 2-baris sama besar, inverse, & inline contrast), 3 tingkat ketebalan (Bold untuk keyword utama, Regular untuk kata lanjutan besar, Medium untuk lead-in kecil), tracking rapat -0.05em, monokrom solid (#FFFFFF / #111111), serta gerak horizontal halus (lead-in) + Blur-Up Rebound Out (hero).
// Font Wajib : Inter-SB, Helvetica Neue Bold, Helvetica Neue Regular, Helvetica Neue Medium
// Mode Blend : Normal (ow: 0, sd: 1, shade: false, subtle ambient shadow)
// Chunk: 2-6

function capHelveticaStackedEditorial(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`helvetica_editorial_exact|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 3 Tier Ketebalan Presisi sesuai video referensi:
  // - FONT_KEY   : Kata kunci utama pada baris besar (Bold padat)
  // - FONT_BIG_R : Kata lanjutan di baris besar yang sama (ukuran besar, tapi ramping Regular seperti "ragu", "life", "didrive")
  // - FONT_SMALL : Kata pengantar/penutup ukuran kecil (Medium agar tetap tajam terbaca)
  const FONT_KEY = 'Helvetica Neue Bold';
  const FONT_BIG_R = 'Helvetica Neue Regular';
  const FONT_SMALL = 'Helvetica Neue Medium';
  const TRACK = -0.05;
  const MAXW = 860;

  // Penempatan default sesuai video (sisi kiri area dada/bahu atas, menghindari mic di kanan)
  const cx = o.cx ?? 475;
  const topY = o.top ?? 1075;
  const basePx = (o.px || 105) * (o.k || 1);

  let bigPx = Math.round(basePx * 0.74);
  let smallPx = Math.max(Math.round(basePx * 0.32), 28);

  const rows = [];
  const patternRoll = r();

  if (raw.length === 1) {
    rows.push([{ word: raw[0], idx: 0, big: true, tier: 'key' }]);
  } else if (raw.length === 2) {
    if (ki === 0 && patternRoll < 0.30) {
      // Pola Inverse 2 kata: Besar di atas, kecil di bawah
      rows.push([{ word: raw[0], idx: 0, big: true, tier: 'key' }]);
      rows.push([{ word: raw[1], idx: 1, big: false, tier: 'small' }]);
    } else if (patternRoll >= 0.30 && patternRoll < 0.45) {
      // Pola 1 baris besar (contoh: "itu jadi data" / "Lu ragu")
      rows.push([
        { word: raw[0], idx: 0, big: true, tier: 'key' },
        { word: raw[1], idx: 1, big: true, tier: 'big_reg' }
      ]);
    } else {
      // Pola 2 baris kontras standar
      rows.push([{ word: raw[0], idx: 0, big: false, tier: 'small' }]);
      rows.push([{ word: raw[1], idx: 1, big: true, tier: 'key' }]);
    }
  } else if (raw.length >= 5 && ki >= 1 && ki <= raw.length - 3) {
    // Pola 3 Baris Bertumpuk (contoh: "Jangan sampai / hidup didrive / oleh omongan orang")
    const mainEnd = Math.min(ki + 1, raw.length - 2);
    const r1 = [];
    const r2 = [];
    const r3 = [];
    for (let i = 0; i < ki; i++) r1.push({ word: raw[i], idx: i, big: false, tier: 'small' });
    for (let i = ki; i <= mainEnd; i++) {
      r2.push({ word: raw[i], idx: i, big: true, tier: i === ki ? 'key' : 'big_reg' });
    }
    for (let i = mainEnd + 1; i < raw.length; i++) r3.push({ word: raw[i], idx: i, big: false, tier: 'small' });
    rows.push(r1, r2, r3);
  } else if (ki === 0) {
    // Pola Inverse (contoh: "Berani / jangan takut untuk kejar")
    const splitAt = raw.length >= 5 ? 1 : 0;
    const r1 = [];
    const r2 = [];
    for (let i = 0; i <= splitAt; i++) {
      r1.push({ word: raw[i], idx: i, big: true, tier: i === 0 ? 'key' : 'big_reg' });
    }
    for (let i = splitAt + 1; i < raw.length; i++) {
      r2.push({ word: raw[i], idx: i, big: false, tier: 'small' });
    }
    rows.push(r1);
    if (r2.length) rows.push(r2);
  } else if (raw.length === 4 && patternRoll < 0.16) {
    // Pola 2 Baris Sama-Sama Besar (contoh: "kejar apa / yang lu mau" atau "jangan takut / jangan ragu")
    rows.push([
      { word: raw[0], idx: 0, big: true, tier: 'key' },
      { word: raw[1], idx: 1, big: true, tier: 'big_reg' }
    ]);
    rows.push([
      { word: raw[2], idx: 2, big: true, tier: 'key' },
      { word: raw[3], idx: 3, big: true, tier: 'big_reg' }
    ]);
  } else if (raw.length >= 4 && ki === raw.length - 1 && patternRoll < 0.22) {
    // Pola Inline Contrast di baris 2 (contoh: "orang sadar / lu itu ragu" -> "ragu" besar di sebelah "lu itu" kecil)
    const mid = Math.max(1, raw.length - 3);
    const r1 = [];
    const r2 = [];
    for (let i = 0; i < mid; i++) r1.push({ word: raw[i], idx: i, big: true, tier: i === 0 ? 'key' : 'big_reg' });
    for (let i = mid; i < ki; i++) r2.push({ word: raw[i], idx: i, big: false, tier: 'small' });
    r2.push({ word: raw[ki], idx: ki, big: true, tier: 'key' });
    rows.push(r1, r2);
  } else {
    // Pola Standar 2 Baris Kontras (contoh: "hiduplah dengan / Berani", "karena kalau / Lu ragu")
    const r1 = [];
    const r2 = [];
    const splitIdx = Math.min(ki, raw.length - 1);
    for (let i = 0; i < splitIdx; i++) r1.push({ word: raw[i], idx: i, big: false, tier: 'small' });
    for (let i = splitIdx; i < raw.length; i++) {
      r2.push({ word: raw[i], idx: i, big: true, tier: i === splitIdx ? 'key' : 'big_reg' });
    }
    if (r1.length) rows.push(r1);
    if (r2.length) rows.push(r2);
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => {
    if (it.tier === 'key') return FONT_KEY;
    if (it.tier === 'big_reg') return FONT_BIG_R;
    return FONT_SMALL;
  };

  // Jarak antar kata rapat (~0.68x lebar spasi) & tracking ketat -0.05em
  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.68;
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(...rows.map((rw) => (rw.length ? rowW(rw) : 0)), 1);
  const targetMaxW = Math.min(MAXW, 640);
  const fitScale = Math.min(1, targetMaxW / maxRowWidth);
  bigPx *= fitScale;
  smallPx *= fitScale;

  // Jarak antar baris menempel rapat (tight leading)
  const gap = Math.round(-basePx * 0.058 * fitScale);
  const blockW = Math.max(...rows.map((rw) => (rw.length ? rowW(rw) : 0)));

  const defaultLeftX = Math.max(145, Math.min(1080 - 120 - blockW, cx - blockW / 2));
  const blockStartX = o.cx !== undefined ? Math.max(80, Math.min(1080 - 80 - blockW, o.cx - blockW / 2)) : defaultLeftX;

  const textColor = o.invertColor ? '#111111' : '#FFFFFF';
  const shadowColor = o.invertColor ? '#FFFFFF' : '#000000';

  const createWordEl = (w, font, px, x, y, t, isBig, rowIdx) => {
    const el = {
      kind: 'text',
      text: w,
      font,
      px,
      fsp: TRACK * px,
      color: textColor,
      oc: shadowColor,
      ow: 0,
      sd: 1,
      shade: false,
      x,
      y,
      rot: 0,
      keys: []
    };

    if (isBig) {
      // Kata Besar: Blur-Up + Rebound Out dari bawah ke atas (sesuai JSON 1_Blur_Up.json)
      const animDur = 235;
      const tMid = t + Math.round(animDur * 0.62);
      const tEnd = t + animDur;
      const dy = Math.round(34 * fitScale);
      const blur0 = 13;

      el.keys = [
        { t: 0,    a: 0,    blur: blur0, x, y: y + dy,                    sx: 94,  sy: 94,  rot: 0 },
        { t,       a: 0,    blur: blur0, x, y: y + dy,                    sx: 94,  sy: 94,  rot: 0 },
        { t: tMid, a: 0.94, blur: 2,     x, y: y - Math.round(2 * fitScale), sx: 100, sy: 100, rot: 0 },
        { t: tEnd, a: 1,    blur: 0,     x, y,                         sx: 100, sy: 100, rot: 0 }
      ];
    } else if (rowIdx >= 2) {
      // Baris ke-3 (Trailing line di bawah baris besar): Turun tipis (micro-drop)
      const animDur = 175;
      const tMid = t + Math.round(animDur * 0.6);
      const tEnd = t + animDur;
      const dy = Math.round(14 * fitScale);

      el.keys = [
        { t: 0,    a: 0,    blur: 3, x, y: y - dy,                    sx: 100, sy: 100, rot: 0 },
        { t,       a: 0,    blur: 3, x, y: y - dy,                    sx: 100, sy: 100, rot: 0 },
        { t: tMid, a: 0.95, blur: 0, x, y: y - Math.round(dy * 0.15), sx: 100, sy: 100, rot: 0 },
        { t: tEnd, a: 1,    blur: 0, x, y,                         sx: 100, sy: 100, rot: 0 }
      ];
    } else {
      // Baris Kecil (Lead-in): Geser mikro horizontal dari kanan ke kiri secara berurutan
      const animDur = 170;
      const tMid = t + Math.round(animDur * 0.6);
      const tEnd = t + animDur;
      const dx = Math.round(16 * fitScale);

      el.keys = [
        { t: 0,    a: 0,    blur: 2, x: x + dx,                    y, sx: 100, sy: 100, rot: 0 },
        { t,       a: 0,    blur: 2, x: x + dx,                    y, sx: 100, sy: 100, rot: 0 },
        { t: tMid, a: 0.96, blur: 0, x: x + Math.round(dx * 0.12), y, sx: 100, sy: 100, rot: 0 },
        { t: tEnd, a: 1,    blur: 0, x,                            y, sx: 100, sy: 100, rot: 0 }
      ];
    }

    return el;
  };

  const els = [];
  let y = topY;

  const placeLeftRow = (row, rowIdx) => {
    if (!row.length) return;
    const h = Math.max(...row.map(pxOf));
    const rowCenterY = y + h / 2;
    let x = blockStartX;

    row.forEach((it) => {
      const ww = wOf(it);
      // Penyelarasan baseline presisi (sangat penting untuk pola inline contrast seperti "lu itu ragu")
      const baselineOffset = (h - pxOf(it)) * 0.36;
      els.push(
        createWordEl(
          it.word,
          fontOf(it),
          pxOf(it),
          x + ww / 2,
          rowCenterY + baselineOffset,
          times[it.idx],
          it.big,
          rowIdx
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  };

  rows.forEach((rw, idx) => placeLeftRow(rw, idx));

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: InvideoEditorialBlur.txt
// Nama Gaya Sosmed : InVideo Editorial Serif-Sans / Aesthetic Blur-In Stacked Captions
// Karakteristik : Blok 2-3 baris bertumpuk asimetris (staggered) dengan jarak baris sangat rapat, kontras font Inter SemiBold (putih) & Instrument Serif Italic (berwarna kuning pastel / hijau mint + soft glow), animasi masuk Blur Fade-In + Hazy Horizontal Slide, serta Blur-Out Drift saat berganti frasa.
// Font Wajib : Inter SemiBold, Instrument Serif Italic
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, soft ambient glow pada keyword)
// Chunk: 2-5

function capInvideoEditorialBlur(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`invideo_editorial|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const dur = o.dur || 1500;
  const times = wordTimes(raw, dur);

  // Font dari ekstraksi JSON (Inter-SB) + Serif Italic dari video referensi
  const FONT_SANS = 'Inter SemiBold';
  const FONT_KEY = 'Instrument Serif Italic';

  // Tracking sangat rapat & word spacing rapat sesuai visual video
  const TRACK_SANS = -0.048;
  const TRACK_KEY = -0.025;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1020;
  const basePx = (o.px || 105) * (o.k || 1);

  // Proporsi ukuran: Sans-Serif besar & konsisten, Serif Italic sedikit lebih tinggi agar x-height seimbang
  let sansPx = Math.round(basePx * 0.72);
  let keyPx = Math.round(basePx * 0.80);

  // Palet warna keyword bergantian (Butter Yellow #F3E595 & Mint Green #6EE7A8)
  const KEY_PALETTE = ['#F3E595', '#6EE7A8'];
  const activeKeyColor = KEY_PALETTE[Math.floor(r() * KEY_PALETTE.length)];

  // Susun kata ke dalam struktur baris Staggered (Pola A, B, C, D)
  const items = raw.map((word, idx) => {
    const isKey = idx === ki && raw.length >= 2;
    return {
      word,
      idx,
      isKey,
      font: isKey ? FONT_KEY : FONT_SANS,
      px: isKey ? keyPx : sansPx,
      track: isKey ? TRACK_KEY : TRACK_SANS
    };
  });

  const rows = [];
  const rowIndents = [];

  if (items.length <= 2) {
    // Pola C: 1 baris tunggal (misal "Dynamic Captions")
    rows.push(items);
    rowIndents.push(0);
  } else if (items.length === 3) {
    // Pola A: 2 kata di baris 1 (misal "You wasting"), 1 kata menjorok di baris 2 ("hours")
    rows.push(items.slice(0, 2));
    rowIndents.push(0);
    rows.push(items.slice(2, 3));
    rowIndents.push(r() > 0.35 ? 115 : 55);
  } else if (items.length === 4) {
    // Pola B: 2 kata baris 1 + 2 kata baris 2 bergeser diagonal (stepped)
    rows.push(items.slice(0, 2));
    rowIndents.push(0);
    rows.push(items.slice(2, 4));
    rowIndents.push(95);
  } else {
    // Pola D (5+ kata): 2-3 baris bertingkat asimetris
    const split1 = 2;
    const split2 = items.length > 5 ? 4 : items.length - 1;
    rows.push(items.slice(0, split1));
    rowIndents.push(0);
    rows.push(items.slice(split1, split2));
    rowIndents.push(110);
    if (split2 < items.length) {
      rows.push(items.slice(split2));
      rowIndents.push(35);
    }
  }

  // Kalkulasi lebar kata & spasi rapat (0.68x spasi standar)
  const spaceW = (it) => widthPx(' ', it.font, it.px) * 0.68;
  const wOf = (it) => widthPx(it.word, it.font, it.px) * (1 + it.track);
  const rowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  // Auto-fit terhadap batas aman kanvas (MAXW = 860)
  const maxStaggeredW = Math.max(
    ...rows.map((row, rIdx) => rowW(row) + rowIndents[rIdx]),
    1
  );
  const targetMaxW = Math.min(MAXW, 740);
  const fitScale = Math.min(1, targetMaxW / maxStaggeredW);

  sansPx *= fitScale;
  keyPx *= fitScale;
  items.forEach((it) => {
    it.px = (it.isKey ? keyPx : sansPx);
  });

  // Jarak antar baris sangat rapat (tight leading -0.11)
  const gap = Math.round(-basePx * 0.11 * fitScale);
  const totalBlockW = Math.max(
    ...rows.map((row, rIdx) => rowW(row) + rowIndents[rIdx] * fitScale),
    1
  );
  const blockStartX = Math.max(70, Math.min(1080 - 70 - totalBlockW, cx - totalBlockW / 2));

  // Variasi gerakan antara 1_Blur_Up (vertikal rebound) & 3_Left_Hazy (horizontal hazy drift)
  const chunkMoveVariant = r();

  const createWordEl = (it, x, y, tStart) => {
    const color = it.isKey ? activeKeyColor : '#FFFFFF';
    const el = {
      kind: 'text',
      text: it.word,
      font: it.font,
      px: it.px,
      fsp: it.track * it.px,
      color,
      oc: it.isKey ? activeKeyColor : '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      ...(it.isKey
        ? { glowColor: activeKeyColor, glowBlur: 15, glowAlpha: 0.48 }
        : { glowColor: '#FFFFFF', glowBlur: 8, glowAlpha: 0.18 }),
      x,
      y,
      rot: 0,
      keys: []
    };

    // Ekstraksi parameter matematis dari 1_Blur_Up.json & 3_Left_Hazy.json
    const useHazySlide = chunkMoveVariant > 0.62 && it.isKey;
    const inDur = Math.min(460, Math.max(260, Math.round(dur * 0.34)));
    const tMid = tStart + Math.round(inDur * 0.55);
    const tInEnd = tStart + inDur;

    // Exit Blur-Out Drift (mengabur & melayang naik perlahan saat berganti chunk)
    const outDur = Math.min(240, Math.max(150, Math.round(dur * 0.16)));
    const tOutStart = Math.max(tInEnd + 60, dur - outDur);
    const tEnd = dur;

    // Offset masuk: Rebound Out Y (-0.1258 -> 0) atau Hazy Drop X (+0.815 -> 0)
    const offsetY0 = useHazySlide ? Math.round(14 * fitScale) : Math.round(54 * fitScale);
    const offsetX0 = useHazySlide ? Math.round(68 * fitScale) : 0;
    const scale0 = useHazySlide ? 116 : 100;
    const rot0 = useHazySlide ? 0.23 : 0; // 0.22829 deg dari 3_Left_Hazy.json
    const blur0 = 16;

    // Titik tengah kurva Rebound Out / Circular Ease (kontrol Y 0.89 di JSON)
    const midX = x + offsetX0 * 0.14;
    const midY = useHazySlide ? y + offsetY0 * 0.14 : y - Math.round(3 * fitScale);
    const midSx = useHazySlide ? 103 : 100;

    // Titik akhir saat Blur-Out Drift (melayang naik -32px & mengabur)
    const exitY = y - Math.round(32 * fitScale);

    el.keys = [
      { t: 0,         a: 0,    blur: blur0, x: x + offsetX0, y: y + offsetY0, sx: scale0, sy: scale0, rot: rot0 },
      { t: tStart,    a: 0,    blur: blur0, x: x + offsetX0, y: y + offsetY0, sx: scale0, sy: scale0, rot: rot0 },
      { t: tMid,      a: 0.92, blur: 3,     x: midX,         y: midY,         sx: midSx,  sy: midSx,  rot: rot0 * 0.25 },
      { t: tInEnd,    a: 1,    blur: 0,     x: x,            y: y,            sx: 100,    sy: 100,    rot: 0 },
      { t: tOutStart, a: 1,    blur: 0,     x: x,            y: y,            sx: 100,    sy: 100,    rot: 0 },
      { t: tEnd,      a: 0,    blur: 14,    x: x,            y: exitY,        sx: 100,    sy: 100,    rot: 0 }
    ];

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((row, rIdx) => {
    if (!row.length) return;
    const h = Math.max(...row.map((it) => it.px));
    const rowCy = y + h / 2;
    let x = blockStartX + rowIndents[rIdx] * fitScale;

    row.forEach((it) => {
      const ww = wOf(it);
      // Penyelarasan baseline antara Inter SemiBold dan Instrument Serif Italic
      const baselineOffset = it.isKey ? (h - it.px) * 0.28 : (h - it.px) * 0.42;
      els.push(
        createWordEl(
          it,
          x + ww / 2,
          rowCy + baselineOffset,
          times[it.idx]
        )
      );
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: KineticEditorialMix.txt
// Nama Gaya Sosmed : Kinetic Editorial Mix-Font / Iman Gadzhi Subtract Reels Style
// Karakteristik : 5 pola tata letak editorial dinamis (2-baris Sans+Script, 3-baris Staggered Impact, 1-baris Horizontal Script, Script+Heavy, dan Single Punchline) dengan indentasi bertingkat, spasi kata organik, glow ambient putih, dan efek Subtract/Difference selektif pada kata klimaks.
// Font Wajib : Inter SemiBold, Playfair Display Italic, Inter ExtraBold
// Mode Blend : SUBTRACT (aktifkan inverse_auto / .style-inverse_auto)
// Chunk: 2-5

function capKineticEditorialMix(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`kinetic_editorial_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_TOP = 'Inter SemiBold';
  const FONT_SCRIPT = 'Playfair Display Italic';
  const FONT_PUNCH = 'Inter Bold';

  const TRACK_SANS = -0.032;
  const TRACK_SCRIPT = -0.012;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1160;
  const basePx = (o.px || 105) * (o.k || 1);

  let topPx = Math.max(Math.round(basePx * 0.40), 28);
  let scriptPx = Math.round(basePx * 0.80);
  let punchPx = Math.round(basePx * 0.72);

  // Pilih salah satu dari 5 pola layout asli di video referensi berdasarkan jumlah kata & seed
  // Pola 0: Top Sans (kecil) + Bottom Script (besar) -> "i don't have / time", "to sit and / relax", "i still not / near"
  // Pola 1: Top Sans (kecil) + Mid Script (besar) + Bottom Heavy (besar) + Optional Tail Sans -> "been / going / harder / than ever"
  // Pola 2: Top Sans (kecil) + Mid Script (besar) + Bottom Sans (kecil) -> "where i / wanna / be at", "this / year / I'ma", "If I / could / do it"
  // Pola 3: Top Script (besar) + Bottom Heavy (besar) -> "countless / hours"
  // Pola 4: 1-Baris Horizontal Script penuh -> "i've been putting"
  let pattern = 0;
  if (raw.length === 1) {
    pattern = 5; // Single Punchline -> "can."
  } else if (raw.length === 2) {
    pattern = r() > 0.45 ? 3 : 0;
  } else if (raw.length === 3) {
    const roll = r();
    if (roll < 0.34) pattern = 0;
    else if (roll < 0.68) pattern = 2;
    else pattern = 4;
  } else {
    pattern = r() > 0.42 ? 1 : 2;
  }

  // Tentukan apakah kluster ini memakai Subtract/Difference pada kata klimaks (sekitar 45% kluster seperti di video)
  const useSubtractOnClimax = pattern === 5 || pattern === 3 || (pattern === 1 && r() > 0.35);

  // Susun struktur baris dan indentasi horizontal bertingkat (staggered offset) sesuai pola
  const rows = []; // tiap item: { words: [...], indentRatio: number, wideSpace: boolean }
  const lastIdx = raw.length - 1;
  const keyPos = ki > 0 && ki < lastIdx ? ki : Math.max(1, Math.floor(raw.length / 2));

  if (pattern === 5) {
    // Pola 5: 1 kata punchline tunggal ("can.")
    rows.push({
      words: [{ word: raw[0], idx: 0, tier: 'punch', isSubtract: true }],
      indentRatio: 0,
      wideSpace: false
    });
  } else if (pattern === 4) {
    // Pola 4: 1 baris horizontal Script semua ("i've been putting")
    rows.push({
      words: raw.map((w, i) => ({ word: w, idx: i, tier: 'script', isSubtract: false })),
      indentRatio: 0,
      wideSpace: false
    });
  } else if (pattern === 3) {
    // Pola 3: Baris 1 Script besar + Baris 2 Heavy Punchline menjorok ke kanan ("countless / hours")
    rows.push({
      words: [{ word: raw[0], idx: 0, tier: 'script', isSubtract: false }],
      indentRatio: 0,
      wideSpace: false
    });
    rows.push({
      words: raw.slice(1).map((w, j) => ({
        word: w,
        idx: j + 1,
        tier: 'punch',
        isSubtract: useSubtractOnClimax && j === raw.length - 2
      })),
      indentRatio: 0.32,
      wideSpace: false
    });
  } else if (pattern === 0) {
    // Pola 0: Baris 1 Sans kecil (spasi kata renggang) + Baris 2 Script besar ("i   don't have / time")
    rows.push({
      words: raw.slice(0, lastIdx).map((w, i) => ({ word: w, idx: i, tier: 'top', isSubtract: false })),
      indentRatio: 0,
      wideSpace: true
    });
    rows.push({
      words: [{ word: raw[lastIdx], idx: lastIdx, tier: 'script', isSubtract: false }],
      indentRatio: 0.04,
      wideSpace: false
    });
  } else if (pattern === 2) {
    // Pola 2: Baris 1 Sans kecil + Baris 2 Script besar + Baris 3 Sans kecil menjorok ("where i / wanna / be at")
    rows.push({
      words: raw.slice(0, keyPos).map((w, i) => ({ word: w, idx: i, tier: 'top', isSubtract: false })),
      indentRatio: 0,
      wideSpace: false
    });
    rows.push({
      words: [{ word: raw[keyPos], idx: keyPos, tier: 'script', isSubtract: false }],
      indentRatio: 0.12,
      wideSpace: false
    });
    rows.push({
      words: raw.slice(keyPos + 1).map((w, j) => ({
        word: w,
        idx: keyPos + 1 + j,
        tier: 'top',
        isSubtract: false
      })),
      indentRatio: 0.42,
      wideSpace: false
    });
  } else {
    // Pola 1: Staggered 3-4 baris ("been / going / harder / than ever")
    const punchIdx = Math.min(keyPos + 1, lastIdx);
    rows.push({
      words: raw.slice(0, keyPos).map((w, i) => ({ word: w, idx: i, tier: 'top', isSubtract: false })),
      indentRatio: 0,
      wideSpace: false
    });
    rows.push({
      words: [{ word: raw[keyPos], idx: keyPos, tier: 'script', isSubtract: false }],
      indentRatio: 0.14,
      wideSpace: false
    });
    rows.push({
      words: [{ word: raw[punchIdx], idx: punchIdx, tier: 'punch', isSubtract: useSubtractOnClimax }],
      indentRatio: 0.36,
      wideSpace: false
    });
    if (punchIdx < lastIdx) {
      rows.push({
        words: raw.slice(punchIdx + 1).map((w, j) => ({
          word: w,
          idx: punchIdx + 1 + j,
          tier: 'top',
          isSubtract: false
        })),
        indentRatio: 0.52,
        wideSpace: false
      });
    }
  }

  const pxOf = (it) => {
    if (it.tier === 'script') return scriptPx;
    if (it.tier === 'punch') return punchPx;
    return topPx;
  };

  const fontOf = (it) => {
    if (it.tier === 'script') return FONT_SCRIPT;
    if (it.tier === 'punch') return FONT_PUNCH;
    return FONT_TOP;
  };

  const trackOf = (it) => (it.tier === 'script' ? TRACK_SCRIPT : TRACK_SANS);

  // Jarak antar kata: normal (0.82) atau wide editorial spacing (1.65) pada baris pendukung atas
  const spaceW = (it, wideSpace) => {
    const mult = wideSpace && it.tier === 'top' ? 1.65 : 0.82;
    return widthPx(' ', fontOf(it), pxOf(it)) * mult;
  };

  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));

  const rowContentW = (rowObj) =>
    rowObj.words.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it, rowObj.wideSpace) : 0), 0);

  // Hitung lebar total blok termasuk indentasi horizontal antar baris
  const baseBlockW = Math.max(...rows.map(rowContentW), 1);
  const fullStaggerW = Math.max(
    ...rows.map((rowObj) => rowContentW(rowObj) + rowObj.indentRatio * baseBlockW),
    1
  );

  const targetMaxW = Math.min(MAXW, pattern === 4 ? 760 : 620);
  const fitScale = Math.min(1, targetMaxW / fullStaggerW);

  topPx *= fitScale;
  scriptPx *= fitScale;
  punchPx *= fitScale;

  const finalBaseW = Math.max(...rows.map(rowContentW), 1);
  const finalTotalW = Math.max(
    ...rows.map((rowObj) => rowContentW(rowObj) + rowObj.indentRatio * finalBaseW),
    1
  );

  // Tight leading agar ekor Script sedikit bersentuhan dengan baris atas/bawahnya
  const gap = Math.round(-basePx * 0.12 * fitScale);

  // Penempatan posisi dinamis kiri / tengah / kanan seperti di video referensi
  const zoneRoll = r();
  let anchorCx = cx;
  if (pattern !== 5) {
    if (zoneRoll < 0.38) anchorCx = cx - Math.round(145 * fitScale); // Kiri-tengah
    else if (zoneRoll > 0.62) anchorCx = cx + Math.round(145 * fitScale); // Kanan-tengah
  }

  const blockStartX = Math.max(64, Math.min(1080 - 64 - finalTotalW, anchorCx - finalTotalW / 2));
  const slideDir = r() > 0.5 ? 1 : -1;

  const createWordEl = (it, x, y, t) => {
    const font = fontOf(it);
    const px = pxOf(it);
    const fsp = trackOf(it) * px;

    const el = {
      kind: 'text',
      text: it.word,
      font,
      px,
      fsp,
      color: '#FFFFFF',
      oc: '#FFFFFF',
      ow: 0,
      sd: 0,
      shade: false,
      ...(it.isSubtract
        ? { blendMode: 'difference' }
        : { glowColor: '#FFFFFF', glowBlur: 13, glowAlpha: 0.30 }),
      x,
      y,
      rot: 0,
      keys: []
    };

    // Mapping 3 kurva keyframe JSON (1_Blur_Up, 3_Left_Hazy, 2.Light_Zoom In)
    const animMode = it.tier === 'script' ? 2 : it.tier === 'punch' ? 0 : 1;

    let startX = x;
    let startY = y;
    let startSx = 100;
    let startSy = 100;
    let blur0 = 14;
    let rot0 = 0;
    let animDur = 320;

    if (animMode === 0) {
      // 1_Blur_Up.json: Blur Fade-In + Vertical Rise (-0.125874 -> 0.0, Rebound Out)
      startY = y + Math.round(44 * fitScale);
      blur0 = 15;
      animDur = 310;
    } else if (animMode === 1) {
      // 3_Left_Hazy.json: Hazy Drop + Horizontal Glide halus (Circular Ease)
      startX = x - slideDir * Math.round(46 * fitScale);
      startSx = 118;
      startSy = 118;
      rot0 = slideDir * 0.004;
      blur0 = 16;
      animDur = 340;
    } else {
      // 2.Light_Zoom In.json: Light Zoom In halus untuk kata Script/Italic (Circular Ease)
      startY = y + Math.round(12 * fitScale);
      startSx = 66;
      startSy = 66;
      blur0 = 14;
      animDur = 350;
    }

    const tMid = t + Math.round(animDur * 0.62);
    const tEnd = t + animDur;

    const midX = x + (startX - x) * 0.08;
    const midY = animMode === 0 ? y - Math.round(2 * fitScale) : y + (startY - y) * 0.08;
    const midSx = 100 + (startSx - 100) * 0.08;
    const midSy = 100 + (startSy - 100) * 0.08;

    el.keys = [
      { t: 0,    a: 0,    blur: blur0,               x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0 },
      { t,       a: 0,    blur: blur0,               x: startX, y: startY, sx: startSx, sy: startSy, rot: rot0 },
      { t: tMid, a: 0.92, blur: Math.round(blur0 * 0.18), x: midX,   y: midY,   sx: midSx,   sy: midSy,   rot: rot0 * 0.15 },
      { t: tEnd, a: 1,    blur: 0,                   x: x,      y: y,      sx: 100,     sy: 100,     rot: 0 }
    ];

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((rowObj) => {
    const h = Math.max(...rowObj.words.map(pxOf));
    const rowCenterY = y + h / 2;
    const indentPx = Math.round(rowObj.indentRatio * finalBaseW);
    let x = Math.min(1080 - 64 - rowContentW(rowObj), blockStartX + indentPx);

    rowObj.words.forEach((it) => {
      const ww = wOf(it);
      const baselineOffset = (h - pxOf(it)) * 0.35;
      els.push(
        createWordEl(
          it,
          x + ww / 2,
          rowCenterY + baselineOffset,
          times[it.idx]
        )
      );
      x += ww + spaceW(it, rowObj.wideSpace);
    });

    y += h + gap;
  });

  return { elements: els, box: { top: topY, bottom: y - gap } };
}
// ---- preset: KineticEditorialStack.txt
// Nama Gaya Sosmed : Lance Editorial Multi-Mode / Kinetic 3-Tier & Narrative Captions
// Karakteristik : Menggabungkan 3 pola dinamis ala video referensi: (1) 3-Tier Justified Block dengan Hero Keyword merah/hijau raksasa, (2) 2-Baris Left-Aligned Contrast, dan (3) 1-Baris Narrative Blur-Reveal + variasi Serif Italic & Subtract. Tracking disetel presisi setara CapCut Character -1.
// Font Wajib : Helvetica Neue Bold, Helvetica Neue Medium, Helvetica Neue Regular, Times New Roman Italic
// Mode Blend : Normal (dengan auto-trigger SUBTRACT / difference pada mode kontras tunggal)
// Chunk: 1-6

function capKineticEditorialStack(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`lance_editorial_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_KEY  = 'Helvetica Neue Bold';
  const FONT_MED  = 'Helvetica Neue Medium';
  const FONT_REG  = 'Helvetica Neue Regular';
  const FONT_SERIF = 'Times New Roman Italic';

  // Tracking setara CapCut Character -1
  const TRACK_TIGHT = -0.10;
  const TRACK_SUB   = -0.10;
  const TRACK_SERIF = -0.10;
  const MAXW = 860;

  // ── Warna referensi video: cream/golden warm (bukan putih) ──────────────────
  // Warna utama semua teks non-hero: golden cream seperti di foto 2, 3, 4
  const COLOR_MAIN   = '#FFE9D9'; // 
  const COLOR_DIM    = '#FFE9D9'; // cream lebih redup untuk baris bottom tier-3
  // ───────────────────────────────────────────────────────────────────────────

  const cx    = o.cx  ?? 540;
  const topY  = o.top ?? 1080;
  const basePx = (o.px || 105) * (o.k || 1);

  // Palet warna hero keyword (foto 1: "hundreds" = merah)
  const PALETTES = [
    { main: '#DF1B16', grad: ['#FF2E27', '#9E0A06'] }, // Crimson Red
    { main: '#00C23A', grad: ['#29EB62', '#007D24'] }, // Emerald Green
    { main: '#0038FF', grad: ['#1A56FF', '#0022B8'] }  // Cobalt Blue
  ];
  const palette = PALETTES[Math.floor(r() * PALETTES.length)];

  // ── Layout mode ─────────────────────────────────────────────────────────────
  // Mode 0: 3-Tier Justified Stack  (foto 1: "I'm giving / hundreds / of premium sound effects")
  // Mode 1: 2-Baris Left-Aligned    (foto 2: "that you can / plug and play")
  // Mode 2: 1-Baris Narrative       (foto 3: "editing" | foto 4: "i've been")
  let layoutMode = 0;
  if (raw.length <= 2) {
    layoutMode = 2;
  } else if (raw.length === 3) {
    layoutMode = r() > 0.45 ? 1 : 2;
  } else if (raw.length >= 4 && raw.length <= 5) {
    const roll = r();
    layoutMode = roll < 0.45 ? 0 : (roll < 0.75 ? 1 : 2);
  } else {
    layoutMode = r() > 0.25 ? 0 : 1;
  }

  // Serif Italic: 1-2 kata di mode 2, seperti foto 3 "editing"
  const useSerifItalic = layoutMode === 2 && raw.length <= 2 && r() > 0.65;
  // Subtract/Difference: 1 kata tunggal tanpa serif
  const useSubtract = layoutMode === 2 && raw.length === 1 && !useSerifItalic && r() > 0.72;

  let heroPx = Math.round(basePx * 1.42);
  let midPx  = Math.round(basePx * 0.92);
  let subPx  = Math.max(Math.round(heroPx * 0.29), 26);

  const topRow = [];
  const midRow = [];
  const botRow = [];

  if (layoutMode === 0) {
    // === POLA A: 3-TIER JUSTIFIED STACK (foto 1) ===
    const safeKi = Math.max(1, Math.min(raw.length - 2, ki));
    for (let i = 0; i < safeKi; i++) {
      topRow.push({ word: raw[i], idx: i, tier: 'med', isKey: false });
    }
    midRow.push({ word: raw[safeKi], idx: safeKi, tier: 'key', isKey: true });
    for (let i = safeKi + 1; i < raw.length; i++) {
      botRow.push({ word: raw[i], idx: i, tier: 'reg', isKey: false });
    }

  } else if (layoutMode === 1) {
    // === POLA C: 2-BARIS LEFT-ALIGNED CONTRAST (foto 2) ===
    // Baris atas: Helvetica Neue Medium (lebih kecil)
    // Baris bawah: Helvetica Neue Bold SEMUA kata (seperti "plug and play" di foto 2)
    const splitAt = Math.max(1, Math.min(raw.length - 1, ki === 0 ? Math.ceil(raw.length / 2) : ki));
    const upperCaps = r() > 0.5;
    for (let i = 0; i < splitAt; i++) {
      const w = upperCaps ? raw[i].toUpperCase() : raw[i];
      topRow.push({ word: w, idx: i, tier: 'med', isKey: false });
    }
    for (let i = splitAt; i < raw.length; i++) {
      const w = upperCaps ? raw[i].toUpperCase() : raw[i];
      // Semua kata baris bawah pakai 'key2' → Helvetica Neue Bold (bukan hanya kata pertama)
      midRow.push({ word: w, idx: i, tier: 'key2', isKey: i === splitAt });
    }

  } else {
    // === POLA B & D: 1-BARIS NARRATIVE / SERIF / SUBTRACT ===
    // foto 3: "editing" → serif italic tunggal
    // foto 4: "i've been" → narrative kecil
    for (let i = 0; i < raw.length; i++) {
      midRow.push({
        word: raw[i],
        idx: i,
        tier: useSerifItalic ? 'serif' : 'narrative',
        isKey: useSubtract || (raw.length === 1)
      });
    }
  }

  const pxOf = (it) => {
    if (it.tier === 'key')                   return heroPx;
    if (it.tier === 'key2')                  return midPx;
    if (it.tier === 'serif')                 return Math.round(basePx * 0.88);
    if (it.tier === 'narrative')             return Math.round(basePx * 0.68);
    if (it.tier === 'reg2')                  return midPx;
    return subPx; // 'med', 'reg'
  };

  const fontOf = (it) => {
    if (it.tier === 'key' || it.tier === 'key2') return FONT_KEY;
    if (it.tier === 'serif')                     return FONT_SERIF;
    if (it.tier === 'med' || it.tier === 'narrative') return FONT_MED;
    return FONT_REG;
  };

  const trackOf = (_it) => TRACK_TIGHT; // semua -0.01

  const wOf         = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + trackOf(it));
  const minSpaceW   = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.84;
  const naturalRowW = (row) => row.reduce((acc, it, j) => acc + wOf(it) + (j ? minSpaceW(it) : 0), 0);

  // Auto-fit kanvas 860px
  const rawMaxW = Math.max(
    topRow.length ? naturalRowW(topRow) : 0,
    midRow.length ? naturalRowW(midRow) : 0,
    botRow.length ? naturalRowW(botRow) : 0,
    1
  );
  const fitScale = Math.min(1, MAXW / rawMaxW);
  heroPx = Math.round(heroPx * fitScale);
  midPx  = Math.round(midPx  * fitScale);
  subPx  = Math.max(Math.round(subPx * fitScale), 24);

  const midNaturalW = midRow.length ? naturalRowW(midRow) : 0;
  const topNaturalW = topRow.length ? naturalRowW(topRow) : 0;
  const botNaturalW = botRow.length ? naturalRowW(botRow) : 0;

  const blockW = layoutMode === 0
    ? Math.min(MAXW, Math.max(midNaturalW, topNaturalW, botNaturalW, 440 * fitScale))
    : Math.max(midNaturalW, topNaturalW, botNaturalW);

  const blockLeft = Math.max(60, Math.min(1080 - 60 - blockW, cx - blockW / 2));

  const gapTopMid = layoutMode === 0 ? Math.round(-heroPx * 0.14) : Math.round(-midPx * 0.10);
  const gapMidBot = Math.round(-heroPx * 0.12);

  const heroZoomOut = r() > 0.35;

  const createWordEl = (it, x, y, t) => {
    const px   = pxOf(it);
    const font = fontOf(it);
    const fsp  = trackOf(it) * px;
    const isHero = it.tier === 'key' || it.tier === 'key2';

    // ── Penentuan warna ──────────────────────────────────────────────────────
    let color;
    if (useSubtract) {
      // Subtract/Difference: tetap putih agar efek blend bekerja
      color = '#FFFFFF';
    } else if (isHero && layoutMode === 0) {
      // Hero keyword di 3-tier: warna palette (kuning/hijau/biru) seperti foto 1
      color = palette.main;
    } else if (botRow.includes(it)) {
      // Baris bawah tier-3 (sub-teks): cream lebih redup
      color = COLOR_DIM;
    } else {
      // Semua teks lainnya: cream/golden warm (foto 2, 3, 4)
      color = COLOR_MAIN;
    }
    // ────────────────────────────────────────────────────────────────────────

    const el = {
      kind : 'text',
      text : it.word,
      font,
      px,
      fsp,
      color,
      oc   : '#000000',
      ow   : 0,
      sd   : 0,
      shade: false,
      ...(useSubtract ? { blendMode: 'difference' } : {}),
      ...(!useSubtract && isHero && layoutMode === 0 ? { gradient: palette.grad, gradientAngle: 180 } : {}),
      x,
      y,
      rot  : 0,
      keys : []
    };

    if (isHero) {
      const animDur = 260;
      const tMid = t + Math.round(animDur * 0.6);
      const tEnd = t + animDur;

      if (heroZoomOut) {
        // Hazy Overscale Zoom-Out (3_Left_Hazy.json)
        el.keys = [
          { t: 0,    a: 0,    blur: 18, x, y, sx: 168, sy: 168, rot: 0 },
          { t,       a: 0,    blur: 18, x, y, sx: 168, sy: 168, rot: 0 },
          { t: tMid, a: 0.94, blur: 3,  x, y, sx: 98,  sy: 98,  rot: 0 },
          { t: tEnd, a: 1,    blur: 0,  x, y, sx: 100, sy: 100, rot: 0 }
        ];
      } else {
        // Circular Punch Zoom-In (2.Basic_Zoom In.json)
        el.keys = [
          { t: 0,    a: 0,    blur: 14, x, y: y + Math.round(12 * fitScale), sx: 33,  sy: 33,  rot: 0.06 },
          { t,       a: 0,    blur: 14, x, y: y + Math.round(12 * fitScale), sx: 33,  sy: 33,  rot: 0.06 },
          { t: tMid, a: 0.92, blur: 2,  x, y: y - Math.round(2  * fitScale), sx: 103, sy: 103, rot: 0    },
          { t: tEnd, a: 1,    blur: 0,  x, y,                                sx: 100, sy: 100, rot: 0    }
        ];
      }
    } else {
      // Blur-Up + Rebound Out (1_Blur_Up.json)
      const animDur = 195;
      const tMid    = t + Math.round(animDur * 0.65);
      const tEnd    = t + animDur;
      const startY  = y + Math.round((layoutMode === 2 ? 24 : 52) * fitScale);
      const reboundY = y - Math.round(3 * fitScale);

      el.keys = [
        { t: 0,    a: 0,    blur: 12, x, y: startY,    sx: 100, sy: 100, rot: 0 },
        { t,       a: 0,    blur: 12, x, y: startY,    sx: 100, sy: 100, rot: 0 },
        { t: tMid, a: 0.94, blur: 2,  x, y: reboundY,  sx: 100, sy: 100, rot: 0 },
        { t: tEnd, a: 1,    blur: 0,  x, y,            sx: 100, sy: 100, rot: 0 }
      ];
    }

    return el;
  };

  const els = [];
  let cursorY = topY;

  const renderRow = (row, alignMode, gapAfter) => {
    if (!row.length) return;
    const rowH       = Math.max(...row.map(pxOf));
    const rowCenterY = cursorY + rowH / 2;
    const wordsTotalW = row.reduce((acc, it) => acc + wOf(it), 0);

    if (alignMode === 'justify' && row.length > 1) {
      // Justified: kata menyebar selebar blockW (foto 1 baris atas & bawah)
      const maxGap     = layoutMode === 2 ? 260 * fitScale : subPx * 2.2;
      const dynamicGap = Math.min((blockW - wordsTotalW) / (row.length - 1), maxGap);
      const actualRowW = wordsTotalW + dynamicGap * (row.length - 1);
      let cursorX = blockLeft + (blockW - actualRowW) / 2;

      row.forEach((it) => {
        const ww = wOf(it);
        els.push(createWordEl(it, cursorX + ww / 2, rowCenterY, times[it.idx]));
        cursorX += ww + dynamicGap;
      });

    } else if (alignMode === 'left') {
      // Rata kiri (foto 2: "that you can" / "plug and play")
      let cursorX = blockLeft;
      row.forEach((it) => {
        const ww           = wOf(it);
        const spacing      = minSpaceW(it);
        const baselineShift = (rowH - pxOf(it)) * 0.25;
        els.push(createWordEl(it, cursorX + ww / 2, rowCenterY + baselineShift, times[it.idx]));
        cursorX += ww + spacing;
      });

    } else {
      // Rata tengah (mode narrative/serif)
      const spacing    = minSpaceW(row[0]);
      const actualRowW = wordsTotalW + spacing * (row.length - 1);
      let cursorX = blockLeft + (blockW - actualRowW) / 2;

      row.forEach((it) => {
        const ww           = wOf(it);
        const baselineShift = (rowH - pxOf(it)) * 0.25;
        els.push(createWordEl(it, cursorX + ww / 2, rowCenterY + baselineShift, times[it.idx]));
        cursorX += ww + spacing;
      });
    }

    cursorY += rowH + gapAfter;
  };

  if (layoutMode === 0) {
    renderRow(topRow, 'justify', gapTopMid);
    renderRow(midRow, 'center',  gapMidBot);
    renderRow(botRow, 'justify', 0);
  } else if (layoutMode === 1) {
    renderRow(topRow, 'left', gapTopMid);
    renderRow(midRow, 'left', 0);
  } else {
    // 2-kata non-serif: sesekali spread ("video     editors")
    const oneRowAlign = (raw.length === 2 && !useSerifItalic && r() > 0.5) ? 'justify' : 'center';
    renderRow(midRow, oneRowAlign, 0);
  }

  return {
    elements: els,
    box: { top: topY, bottom: cursorY }
  };
}
// ---- preset: MinimalistDifference.txt
// Nama Gaya Sosmed : Minimalist Subtract Blur-Up / Editorial Difference Lowercase Captions
// Karakteristik : 1 baris tunggal rata tengah dinamis (akumulatif per kata bergeser mulus ke kiri lalu diam/hold), 100% lowercase, huruf ramping (Regular), jarak kata bersih, masuk dengan Blur-Up & keluar dengan Blur-Fade Out di ujung.
// Font Wajib : Helvetica Neue Regular, Inter Regular
// Mode Blend : SUBTRACT (aktifkan inverse_auto / .style-inverse_auto)
// Chunk: 2-3

function capMinimalistDifference(text, o = {}) {
  const raw = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const dur = o.dur || 1500;
  const times = wordTimes(raw, dur);

  const FONT = 'Helvetica Neue Regular';
  const TRACK = -0.065; // Tracking rapat estetis tanpa membuat glif saling bertabrakan
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const basePx = (o.px || 105) * (o.k || 1);
  let px = Math.round(basePx * 0.68);

  // Gunakan lebar spasi utuh (1.0) dan lebar huruf penuh agar tidak berdempetan
  const spaceW = () => widthPx(' ', FONT, px) * 0.05;
  const wOf = (word) => widthPx(word, FONT, px);

  // Auto-fit terhadap lebar maksimal baris
  const fullPhraseW = raw.reduce((acc, w, idx) => acc + wOf(w) + (idx > 0 ? spaceW() : 0), 0);
  const fitScale = Math.min(1, MAXW / Math.max(fullPhraseW, 1));
  px = Math.round(px * fitScale);

  const topY = o.top ?? Math.round(960 - px / 2);
  const centerY = topY + px / 2;

  const sp = spaceW();
  const wordWidths = raw.map((w) => wOf(w));

  // Lebar kumulatif tiap tahap (kata 1 -> kata 1+2 -> kata 1+2+3)
  const stageWidths = [];
  let accW = 0;
  for (let s = 0; s < raw.length; s++) {
    accW += wordWidths[s] + (s > 0 ? sp : 0);
    stageWidths.push(accW);
  }

  // Hitung pusat X tiap kata pada tahap stageIdx agar blok selalu rata tengah di cx
  const getWordCenterXAtStage = (wordIdx, stageIdx) => {
    const totalW = stageWidths[stageIdx];
    const blockStartX = Math.max(70, Math.min(1080 - 70 - totalW, cx - totalW / 2));
    let offsetX = 0;
    for (let j = 0; j < wordIdx; j++) {
      offsetX += wordWidths[j] + sp;
    }
    return blockStartX + offsetX + wordWidths[wordIdx] / 2;
  };

  // Parameter animasi masuk, geser, diam (hold), dan keluar
  const yOffsetIn = Math.round(65 * fitScale);
  const yOffsetOut = Math.round(-30 * fitScale);
  const enterDur = 320; // Durasi naik & blur masuk yang tenang (tidak terlalu cepat/tersentak)
  const shiftDur = 220; // Durasi geser ke kiri saat kata berikutnya muncul
  const exitDur = 160;  // Durasi blur keluar di paling akhir chunk
  const tExitStart = Math.max(times[raw.length - 1] + enterDur + 60, dur - exitDur);

  const els = [];

  raw.forEach((word, i) => {
    const tIn = times[i];
    const xFinal = getWordCenterXAtStage(i, raw.length - 1);

    // Helper untuk menghitung posisi X kata ke-i pada sembarang waktu t
    // (memisahkan timeline X dari timeline Y/Alpha/Blur agar tidak pernah konflik/melompat!)
    const getXAtTime = (t) => {
      let curX = getWordCenterXAtStage(i, i);
      for (let s = i + 1; s < raw.length; s++) {
        const tS = times[s];
        const prevX = getWordCenterXAtStage(i, s - 1);
        const nextX = getWordCenterXAtStage(i, s);
        if (t <= tS) return prevX;
        if (t < tS + shiftDur) {
          const p = (t - tS) / shiftDur;
          // Ease-out cubic mulus
          const ease = 1 - Math.pow(1 - p, 3);
          return Math.round(prevX + (nextX - prevX) * ease);
        }
        curX = nextX;
      }
      return curX;
    };

    // Kumpulkan seluruh titik waktu penting secara kronologis tanpa tumpang tindih
    const timePoints = new Set([0, tIn]);
    timePoints.add(tIn + Math.round(enterDur * 0.45));
    timePoints.add(tIn + enterDur);

    for (let s = i + 1; s < raw.length; s++) {
      timePoints.add(times[s]);
      timePoints.add(times[s] + Math.round(shiftDur * 0.5));
      timePoints.add(times[s] + shiftDur);
    }

    if (tExitStart < dur) {
      timePoints.add(tExitStart);
    }
    timePoints.add(dur);

    const sortedTimes = Array.from(timePoints)
      .filter((t) => t >= 0 && t <= dur)
      .sort((a, b) => a - b);

    const keys = sortedTimes.map((t) => {
      const x = getXAtTime(t);

      // 1. Sebelum kata muncul
      if (t <= tIn) {
        return {
          t,
          a: 0,
          blur: 14,
          x,
          y: centerY + yOffsetIn,
          sx: 100,
          sy: 100,
          rot: 0
        };
      }

      // 2. Fase Masuk (Blur-Up mulus)
      if (t < tIn + enterDur) {
        const p = (t - tIn) / enterDur;
        const ease = 1 - Math.pow(1 - p, 3); // Ease-out cubic
        return {
          t,
          a: Number(Math.min(1, ease * 1.15).toFixed(2)),
          blur: Math.round(14 * (1 - ease)),
          x,
          y: Math.round(centerY + yOffsetIn * (1 - ease)),
          sx: 100,
          sy: 100,
          rot: 0
        };
      }

      // 3. Fase Diam / Hold (posisi Y, alpha, dan blur terkunci stabil)
      if (t <= tExitStart || tExitStart >= dur) {
        return {
          t,
          a: 1,
          blur: 0,
          x,
          y: centerY,
          sx: 100,
          sy: 100,
          rot: 0
        };
      }

      // 4. Fase Keluar di akhir chunk (Blur-Fade Out)
      const pOut = Math.min(1, (t - tExitStart) / Math.max(dur - tExitStart, 1));
      const easeOut = pOut * pOut;
      return {
        t,
        a: Number((1 - easeOut).toFixed(2)),
        blur: Math.round(12 * easeOut),
        x,
        y: Math.round(centerY + yOffsetOut * easeOut),
        sx: 100,
        sy: 100,
        rot: 0
      };
    });

    els.push({
      kind: 'text',
      text: word,
      font: FONT,
      px,
      fsp: TRACK * px,
      color: '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      blendMode: 'difference',
      x: xFinal,
      y: centerY,
      rot: 0,
      keys
    });
  });

  return {
    elements: els,
    box: { top: topY, bottom: topY + px }
  };
}
// ---- preset: StackedContrastHook.txt
// Nama Gaya Sosmed : Viral Stacked Contrast / Modern Editorial Hook Captions
// Karakteristik : Keyword raksasa ALL CAPS Amber Gold sebagai jangkar tengah (otomatis rata tengah jika hanya 1 kata); kata pengantar muncul cepat di kiri atas sejajar tepi kiri keyword, kata lanjutan muncul & berganti cepat (1 slot) di kanan bawah sejajar tepi kanan keyword.
// Font Wajib : Bebas Neue, Inter SemiBold
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, gradient amber-gold pada keyword)
// Chunk: 1-5

function capStackedContrastHook(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`stacked_contrast_hook|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const dur = o.dur || 1500;
  const times = wordTimes(raw, dur);

  const FONT_KEY = 'Bebas Neue';
  const FONT_SUB = 'Inter SemiBold';
  const TRACK_KEY = -0.02;
  const TRACK_SUB = -0.025;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1160;
  const basePx = (o.px || 105) * (o.k || 1);

  let keyPx = Math.round(basePx * 1.42);
  let subPx = Math.max(Math.round(keyPx * 0.27), 28);

  // Jika hanya 1 kata, langsung jadikan keyword utama di tengah-tengah
  if (raw.length === 1) {
    const word = raw[0].toUpperCase();
    const rawW = widthPx(word, FONT_KEY, keyPx);
    const fitScale = Math.min(1, MAXW / Math.max(rawW, 1));
    keyPx *= fitScale;

    const cyMid = topY + keyPx / 2;
    const x = cx;
    const t = times[0];
    const dyStart = Math.round(64 * fitScale);
    const dyOvershoot = Math.round(-11 * fitScale);
    const usePeppyTilt = r() > 0.65;
    const rotStart = usePeppyTilt ? (r() > 0.5 ? 1.8 : -1.8) : 0;
    const rotOvershoot = usePeppyTilt ? -rotStart * 0.25 : 0;

    return {
      elements: [
        {
          kind: 'text',
          text: word,
          font: FONT_KEY,
          px: keyPx,
          fsp: TRACK_KEY * keyPx,
          color: '#F5A623',
          oc: '#000000',
          ow: 0,
          sd: 0,
          shade: false,
          gradient: ['#FFB81C', '#E59400'],
          gradientAngle: 90,
          x,
          y: cyMid,
          rot: 0,
          keys: [
            { t: 0,       a: 0, blur: 10, x, y: cyMid + dyStart,                sx: 85,  sy: 85,  rot: rotStart },
            { t,          a: 0, blur: 10, x, y: cyMid + dyStart,                sx: 85,  sy: 85,  rot: rotStart },
            { t: t + 115, a: 1, blur: 3,  x, y: cyMid + dyOvershoot,            sx: 105, sy: 105, rot: rotOvershoot },
            { t: t + 220, a: 1, blur: 0,  x, y: cyMid + Math.round(3 * fitScale), sx: 98, sy: 98, rot: 0 },
            { t: t + 330, a: 1, blur: 0,  x, y: cyMid - Math.round(1 * fitScale), sx: 101, sy: 101, rot: 0 },
            { t: t + 430, a: 1, blur: 0,  x, y: cyMid,                          sx: 100, sy: 100, rot: 0 }
          ]
        }
      ],
      box: { top: topY, bottom: topY + keyPx }
    };
  }

  // Tentukan rentang kata penting (1 kata panjang seperti OPENSOURCE, atau gabungan kata pendek seperti 17 YEAR OLD)
  let keyStart = ki;
  let keyEnd = ki;
  if (raw.length >= 2 && ki < raw.length - 1) {
    const w1 = raw[ki].replace(/[^a-zA-Z0-9$]/g, '');
    const w2 = raw[ki + 1].replace(/[^a-zA-Z0-9$]/g, '');
    if (w1.length <= 4 && w2.length <= 5) {
      keyEnd = ki + 1;
      if (keyEnd < raw.length - 1 && raw[keyEnd + 1].replace(/[^a-zA-Z0-9$]/g, '').length <= 4) {
        keyEnd = ki + 2;
      }
    }
  }

  const topWords = [];
  const midWords = [];
  const botWords = [];

  for (let i = 0; i < raw.length; i++) {
    if (i < keyStart) {
      topWords.push({ word: raw[i], idx: i, isKey: false });
    } else if (i <= keyEnd) {
      midWords.push({ word: raw[i].toUpperCase(), idx: i, isKey: true });
    } else {
      botWords.push({ word: raw[i], idx: i, isKey: false });
    }
  }

  const spaceKey = Math.max(widthPx(' ', FONT_KEY, keyPx) * 0.72, keyPx * 0.16);
  const keyWidths = midWords.map((it) => widthPx(it.word, FONT_KEY, keyPx));
  const midTotalW = keyWidths.reduce((a, b) => a + b, 0) + Math.max(0, midWords.length - 1) * spaceKey;

  const maxSubW = Math.max(
    ...topWords.map((it) => widthPx(it.word, FONT_SUB, subPx)),
    ...botWords.map((it) => widthPx(it.word, FONT_SUB, subPx)),
    1
  );

  const fitScale = Math.min(1, MAXW / Math.max(midTotalW, maxSubW, 1));
  keyPx *= fitScale;
  subPx *= fitScale;

  const fSpaceKey = Math.max(widthPx(' ', FONT_KEY, keyPx) * 0.72, keyPx * 0.16);
  const fKeyWidths = midWords.map((it) => widthPx(it.word, FONT_KEY, keyPx));
  const fMidW = fKeyWidths.reduce((a, b) => a + b, 0) + Math.max(0, midWords.length - 1) * fSpaceKey;

  const hasTop = topWords.length > 0;
  const hasBot = botWords.length > 0;

  const topH = hasTop ? subPx : 0;
  const midH = keyPx;
  const botH = hasBot ? subPx : 0;

  const gapTop = hasTop ? Math.round(-subPx * 0.12) : 0;
  const gapBot = hasBot ? Math.round(-subPx * 0.14) : 0;

  const cyTop = topY + topH / 2;
  const cyMid = topY + topH + gapTop + midH / 2;
  const cyBot = topY + topH + gapTop + midH + gapBot + botH / 2;

  const anchorLeft = Math.max(70, Math.min(1080 - 70 - fMidW, cx - fMidW / 2));
  const anchorRight = Math.min(1080 - 70, anchorLeft + fMidW);

  const usePeppyTilt = r() > 0.65;
  const els = [];

  // 1. KATA TIDAK PENTING ATAS (1 kata cepat berganti di kiri atas)
  topWords.forEach((it, idx) => {
    const tStart = times[it.idx];
    const tNext = idx < topWords.length - 1 ? times[topWords[idx + 1].idx] : dur;
    const ww = widthPx(it.word, FONT_SUB, subPx);
    const x = anchorLeft + ww / 2;
    const dySub = Math.round(18 * fitScale);

    const keys = [
      { t: 0,           a: 0, blur: 5, x, y: cyTop + dySub, sx: 100, sy: 100, rot: 0 },
      { t: tStart,      a: 0, blur: 5, x, y: cyTop + dySub, sx: 100, sy: 100, rot: 0 },
      { t: tStart + 95, a: 1, blur: 0, x, y: cyTop,         sx: 100, sy: 100, rot: 0 }
    ];

    if (idx < topWords.length - 1) {
      const tOut = Math.max(tStart + 110, tNext - 25);
      keys.push({ t: tOut, a: 1, blur: 0, x, y: cyTop, sx: 100, sy: 100, rot: 0 });
      keys.push({ t: tNext, a: 0, blur: 0, x, y: cyTop, sx: 100, sy: 100, rot: 0 });
    }

    els.push({
      kind: 'text',
      text: it.word,
      font: FONT_SUB,
      px: subPx,
      fsp: TRACK_SUB * subPx,
      color: '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      x,
      y: cyTop,
      rot: 0,
      keys
    });
  });

  // 2. KATA PENTING (KEYWORD RAKSASA DI TENGAH)
  let curKeyX = anchorLeft;
  const tKeyStart = times[midWords[0].idx];
  midWords.forEach((it, idx) => {
    const ww = fKeyWidths[idx];
    const x = curKeyX + ww / 2;
    const t = idx === 0 ? tKeyStart : Math.min(times[it.idx], tKeyStart + idx * 75);

    const dyStart = Math.round(64 * fitScale);
    const dyOvershoot = Math.round(-11 * fitScale);
    const rotStart = usePeppyTilt ? (r() > 0.5 ? 1.8 : -1.8) : 0;
    const rotOvershoot = usePeppyTilt ? -rotStart * 0.25 : 0;

    els.push({
      kind: 'text',
      text: it.word,
      font: FONT_KEY,
      px: keyPx,
      fsp: TRACK_KEY * keyPx,
      color: '#F5A623',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      gradient: ['#FFB81C', '#E59400'],
      gradientAngle: 90,
      x,
      y: cyMid,
      rot: 0,
      keys: [
        { t: 0,       a: 0, blur: 10, x, y: cyMid + dyStart,                sx: 85,  sy: 85,  rot: rotStart },
        { t,          a: 0, blur: 10, x, y: cyMid + dyStart,                sx: 85,  sy: 85,  rot: rotStart },
        { t: t + 115, a: 1, blur: 3,  x, y: cyMid + dyOvershoot,            sx: 105, sy: 105, rot: rotOvershoot },
        { t: t + 220, a: 1, blur: 0,  x, y: cyMid + Math.round(3 * fitScale), sx: 98, sy: 98, rot: 0 },
        { t: t + 330, a: 1, blur: 0,  x, y: cyMid - Math.round(1 * fitScale), sx: 101, sy: 101, rot: 0 },
        { t: t + 430, a: 1, blur: 0,  x, y: cyMid,                          sx: 100, sy: 100, rot: 0 }
      ]
    });

    curKeyX += ww + fSpaceKey;
  });

  // 3. KATA TIDAK PENTING BAWAH (1 kata cepat berganti di kanan bawah)
  botWords.forEach((it, idx) => {
    const tStart = times[it.idx];
    const tNext = idx < botWords.length - 1 ? times[botWords[idx + 1].idx] : dur;
    const ww = widthPx(it.word, FONT_SUB, subPx);
    const x = Math.max(70 + ww / 2, anchorRight - ww / 2);
    const dySub = Math.round(18 * fitScale);

    const keys = [
      { t: 0,           a: 0, blur: 5, x, y: cyBot + dySub, sx: 100, sy: 100, rot: 0 },
      { t: tStart,      a: 0, blur: 5, x, y: cyBot + dySub, sx: 100, sy: 100, rot: 0 },
      { t: tStart + 95, a: 1, blur: 0, x, y: cyBot,         sx: 100, sy: 100, rot: 0 }
    ];

    if (idx < botWords.length - 1) {
      const tOut = Math.max(tStart + 110, tNext - 25);
      keys.push({ t: tOut, a: 1, blur: 0, x, y: cyBot, sx: 100, sy: 100, rot: 0 });
      keys.push({ t: tNext, a: 0, blur: 0, x, y: cyBot, sx: 100, sy: 100, rot: 0 });
    }

    els.push({
      kind: 'text',
      text: it.word,
      font: FONT_SUB,
      px: subPx,
      fsp: TRACK_SUB * subPx,
      color: '#FFFFFF',
      oc: '#000000',
      ow: 0,
      sd: 0,
      shade: false,
      x,
      y: cyBot,
      rot: 0,
      keys
    });
  });

  const yBottom = topY + topH + gapTop + midH + gapBot + botH;
  return { elements: els, box: { top: topY, bottom: yBottom } };
}
// ---- preset: StackedNeonScript.txt
// Nama Gaya Sosmed : Stacked Left-Anchor Roll-Up Captions / Mixed Sans-Script Neon Gradient Captions
// Karakteristik : Blok vertikal rata kiri di area tengah layar (1 kata per baris, 1-4 baris per chunk); non-keyword memakai Sans-Serif SemiBold putih bersih (slide-up pendek Rebound Out + Blur), sedangkan keyword memakai Cursive Script kaligrafi formal (Great Vibes / Alex Brush) dengan gradasi warna horizontal per-huruf Putih -> Magenta Neon -> Ungu Elektrik (#FFFFFF -> #E879F9 -> #7B00FF) + glow ungu lembut.
// Font Wajib : Inter SemiBold, Great Vibes, Alex Brush
// Mode Blend : Normal (ow: 0, sd: 2 untuk putih / 0 untuk script, shade: false, per-char gradient + glow ungu-magenta pada keyword)
// Chunk: 1-4

function capStackedNeonScript(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`stacked_neon_script_v4|${text}`) : Math.random;
  const dur = o.dur || 1500;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, dur);

  const FONT_SANS = 'Inter SemiBold';
  const FONT_SCRIPT = 'Alex Brush'; // Alternatif identik jika di-load: 'Alex Brush'
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1120;
  const basePx = (o.px || 105) * (o.k || 1);

  const GLOW_PURPLE = '#9D17FF';

  // Helper interpolasi warna RGB untuk gradasi horizontal Putih -> Magenta -> Ungu Elektrik
  const hexToRgb = (hex) => {
    const clean = hex.replace('#', '');
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  };
  const rgbToHex = (rgb) =>
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();

  const lerpColor = (c1, c2, t) => {
    const a = hexToRgb(c1);
    const b = hexToRgb(c2);
    return rgbToHex([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ]);
  };

  // Gradasi 3 titik sesuai referensi: Kiri Putih (#FFFFFF), Tengah Pink-Magenta (#E879F9), Kanan Ungu Elektrik (#7B00FF)
  const getCharGradientColor = (charIdx, totalChars) => {
    if (totalChars <= 1) return '#D946EF';
    const ratio = charIdx / (totalChars - 1);
    if (ratio <= 0.45) {
      return lerpColor('#FFFFFF', '#E879F9', ratio / 0.45);
    }
    return lerpColor('#E879F9', '#7B00FF', (ratio - 0.45) / 0.55);
  };

  // Proporsi ukuran: x-height Great Vibes lebih kecil dari Inter, sehingga px dibuat 1.36x
  const rawSansPx = Math.round(basePx * 0.68);
  const rawScriptPx = Math.round(basePx * 0.92);

  const items = raw.map((word, idx) => {
    const isKey = idx === ki;
    const displayWord = isKey
      ? word.toLowerCase()
      : (idx === 0 ? word : word.toLowerCase());
    const font = isKey ? FONT_SCRIPT : FONT_SANS;
    const track = isKey ? -0.015 : -0.035;
    const rawPx = isKey ? rawScriptPx : rawSansPx;
    return {
      word: displayWord,
      idx,
      isKey,
      font,
      track,
      rawPx
    };
  });

  // Auto-fit terhadap batas lebar kanvas
  const maxWordW = Math.max(
    ...items.map((it) => widthPx(it.word, it.font, it.rawPx) * (1 + it.track)),
    1
  );
  const targetMaxW = Math.min(MAXW, 740);
  const fitScale = Math.min(1, targetMaxW / maxWordW);

  items.forEach((it) => {
    it.px = Math.max(Math.round(it.rawPx * fitScale), 32);
    it.w = widthPx(it.word, it.font, it.px) * (1 + it.track);
  });

  // Hitung lebar blok rata kiri di area tengah layar
  const sansItems = items.filter((it) => !it.isKey);
  const refBlockW = sansItems.length
    ? Math.max(...sansItems.map((it) => it.w))
    : Math.max(...items.map((it) => it.w));

  const leftAnchorX = Math.max(
    110,
    Math.min(1080 - 110 - refBlockW, Math.round(cx - refBlockW * 0.42))
  );

  // Jarak vertikal antar baris rapat & konsisten
  const sansPxScaled = Math.max(Math.round(rawSansPx * fitScale), 32);
  const rowStep = Math.round(sansPxScaled * 0.78);
  const yBottom = topY + rowStep * items.length;

  // Parameter gerakan terkalibrasi dari JSON (1_Basic_Up, 1_Blur_Up, 3_Right_Basic)
  const upSlideOffset = Math.round(44 * fitScale);
  const leftWipeOffset = Math.round(92 * fitScale);

  const exitDur = Math.min(150, Math.round(dur * 0.12));
  const exitStart = Math.max(0, dur - exitDur);

  const els = [];

  items.forEach((it, rowIdx) => {
    const tIn = times[it.idx];
    const finalY = topY + rowIdx * rowStep + Math.round(sansPxScaled * 0.5);

    const scriptOutdent = it.isKey ? Math.round(24 * fitScale) : 0;
    const finalX = Math.max(
      90 + it.w / 2,
      Math.min(1080 - 90 - it.w / 2, leftAnchorX - scriptOutdent + it.w / 2)
    );

    if (it.isKey) {
      // Keyword (Cursive Script Gradient Per-Huruf Putih -> Magenta -> Ungu Elektrik + Glow):
      const chars = Array.from(it.word);
      const charWidths = chars.map((ch) =>
        Math.max(widthPx(ch, it.font, it.px) * (1 + it.track), 4)
      );
      const totalCharsW = charWidths.reduce((sum, w) => sum + w, 0);
      const scaleAdjust = totalCharsW > 0 ? it.w / totalCharsW : 1;

      let cursorX = finalX - it.w / 2;
      const animDur = 260;

      chars.forEach((ch, cIdx) => {
        const cw = charWidths[cIdx] * scaleAdjust;
        const charFinalX = cursorX + cw / 2;
        cursorX += cw;

        // Sedikit stagger kiri-ke-kanan (12ms per huruf) agar terasa sapuan tulisnya
        const charStagger = Math.min(cIdx * 12, 110);
        const ctIn = Math.min(exitStart - 40, tIn + charStagger);
        const ctMid = Math.min(exitStart, ctIn + Math.round(animDur * 0.5));
        const ctEnd = Math.min(exitStart, ctIn + animDur);

        const startX = charFinalX - leftWipeOffset;
        const startY = finalY + Math.round(10 * fitScale);
        const charColor = getCharGradientColor(cIdx, chars.length);

        const keys = [
          { t: 0,     a: 0,    blur: 10, x: startX, y: startY, sx: 112, sy: 112, rot: 0 },
          { t: ctIn,  a: 0,    blur: 10, x: startX, y: startY, sx: 112, sy: 112, rot: 0 },
          { t: ctMid, a: 0.92, blur: 2,  x: charFinalX - Math.round(leftWipeOffset * 0.12), y: finalY, sx: 102, sy: 102, rot: 0 },
          { t: ctEnd, a: 1,    blur: 0,  x: charFinalX, y: finalY, sx: 100, sy: 100, rot: 0 }
        ];

        if (exitStart > keys[keys.length - 1].t) {
          keys.push({
            t: exitStart,
            a: 1,
            blur: 0,
            x: charFinalX,
            y: finalY,
            sx: 100,
            sy: 100,
            rot: 0
          });
        }
        keys.push({
          t: dur,
          a: 0,
          blur: 6,
          x: charFinalX,
          y: finalY - Math.round(24 * fitScale),
          sx: 100,
          sy: 100,
          rot: 0
        });

        els.push({
          kind: 'text',
          text: ch,
          font: it.font,
          px: it.px,
          fsp: it.track * it.px,
          color: charColor,
          oc: GLOW_PURPLE,
          ow: 0,
          sd: 0,
          shade: false,
          glowColor: GLOW_PURPLE,
          glowBlur: 18,
          glowAlpha: 0.72,
          x: charFinalX,
          y: finalY,
          rot: 0,
          keys
        });
      });
    } else {
      // Non-Keyword (Sans-Serif Putih Solid):
      const animDur = 220;
      const tMid = Math.min(exitStart, tIn + Math.round(animDur * 0.55));
      const tEnd = Math.min(exitStart, tIn + animDur);
      const startY = finalY + upSlideOffset;
      const overshootY = finalY - Math.round(3 * fitScale);

      const keys = [
        { t: 0,    a: 0,    blur: 8, x: finalX, y: startY,     sx: 102, sy: 102, rot: 0 },
        { t: tIn,  a: 0,    blur: 8, x: finalX, y: startY,     sx: 102, sy: 102, rot: 0 },
        { t: tMid, a: 0.95, blur: 1, x: finalX, y: overshootY, sx: 100, sy: 100, rot: 0 },
        { t: tEnd, a: 1,    blur: 0, x: finalX, y: finalY,     sx: 100, sy: 100, rot: 0 }
      ];

      if (exitStart > keys[keys.length - 1].t) {
        keys.push({
          t: exitStart,
          a: 1,
          blur: 0,
          x: finalX,
          y: finalY,
          sx: 100,
          sy: 100,
          rot: 0
        });
      }
      keys.push({
        t: dur,
        a: 0,
        blur: 6,
        x: finalX,
        y: finalY - Math.round(24 * fitScale),
        sx: 100,
        sy: 100,
        rot: 0
      });

      els.push({
        kind: 'text',
        text: it.word,
        font: it.font,
        px: it.px,
        fsp: it.track * it.px,
        color: '#FFFFFF',
        oc: '#000000',
        ow: 0,
        sd: 2,
        shade: false,
        x: finalX,
        y: finalY,
        rot: 0,
        keys
      });
    }
  });

  return {
    elements: els,
    box: { top: topY, bottom: yBottom }
  };
}
// ---- preset: SubmagicEditorial.txt
// Nama Gaya Sosmed : Submagic Editorial Serif-Sans Contrast / Blue-Flash Blur Reveal
// Karakteristik : 4 pola komposisi dinamis (1-baris inline, 2-baris stacked kontras, 1-2 kata bold/italic hero, dan hero-number + 2 baris) dengan transisi masuk Blur-Up + Light Zoom + kilatan glow biru (#1D2BFF) ke putih (#FFFFFF).
// Font Wajib : Helvetica Neue Light, Helvetica Neue Regular, Helvetica Neue Bold, Instrument Serif Italic, Instrument Serif Regular
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, soft outer glow putih + kilatan glow biru saat masuk)
// Chunk: 1-4

function capSubmagicEditorial(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`submagic_editorial|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  // 1. Hierarki Font Persis Video Referensi
  const FONT_SANS_LIGHT = 'Helvetica Neue Light';
  const FONT_SANS_REG   = 'Helvetica Neue Regular';
  const FONT_SANS_BOLD  = 'Helvetica Neue Bold';
  const FONT_SERIF_ITAL = 'Instrument Serif Italic';
  const FONT_SERIF_REG  = 'Instrument Serif Regular';

  const TRACK_SANS  = -0.045; // Rapat khas editorial modern
  const TRACK_SERIF = -0.025;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1020; // Zona tengah-bawah (dada/bahu pembicara)
  const basePx = (o.px || 105) * (o.k || 1);

  const WHITE = '#FFFFFF';
  const BLUE_FLASH = '#1D2BFF';

  // Deteksi pola spesial angka + 2 kata di belakang (misal: "3 now takes minutes" atau "3 hours")
  const startsWithNumber = /^[0-9]+$/.test(raw[0]);
  // Pilih gaya keyword secara deterministik: Serif Italic vs Heavy Sans Bold
  const useSerifKey = r() > 0.35;

  // Tentukan mode layout (0: 1-baris inline, 1: 2-baris stacked kontras, 2: Hero single/pair, 3: Number + stacked)
  let layoutMode = 0;
  if (startsWithNumber && raw.length >= 3) {
    layoutMode = 3;
  } else if (raw.length <= 2) {
    layoutMode = 2;
  } else if (raw.length >= 3 && r() > 0.48) {
    layoutMode = 1;
  } else {
    layoutMode = 0;
  }

  let bigPx = Math.round(basePx * 0.86);
  let smallPx = Math.max(Math.round(basePx * 0.44), 30);

  const getKeyFont = (word) => {
    if (/^[0-9]+$/.test(word)) return FONT_SERIF_REG;
    return useSerifKey ? FONT_SERIF_ITAL : FONT_SANS_BOLD;
  };
  const getKeyTrack = (word) => (/^[0-9]+$/.test(word) || useSerifKey ? TRACK_SERIF : TRACK_SANS);

  const els = [];
  let yBottom = topY;

  // Helper pembuat keyframe matematis gabungan JSON (1_Blur_Up + 2.Light_Zoom In + 1_Basic_Up)
  // Termasuk efek kilatan glow biru (#1D2BFF) di awal kemunculan pada kata kunci/aksen
  const buildWordElement = (w, font, px, track, x, y, t, isBig, isKey, hasBlueFlash) => {
    const startColor = hasBlueFlash ? BLUE_FLASH : WHITE;
    const startGlow = hasBlueFlash ? BLUE_FLASH : WHITE;

    const el = {
      kind: 'text',
      text: w,
      font,
      px,
      fsp: track * px,
      color: WHITE,
      oc: WHITE,
      ow: 0,
      sd: 0,
      shade: false,
      glowColor: WHITE,
      glowBlur: isBig ? 18 : 12,
      glowAlpha: isBig ? 0.55 : 0.40,
      x,
      y,
      rot: 0,
      keys: []
    };

    // Parameter dari JSON: offset Y (-0.1258 -> ~48px), scale (Light Zoom In), rot (0.228 deg)
    const offsetY = Math.round((isBig ? 52 : 34) * (px / Math.max(bigPx, 1)));
    const startSx = isBig ? 88 : 94;
    const startSy = isBig ? 88 : 94;
    const blur0 = isBig ? 16 : 10;
    const rot0 = isBig ? (r() > 0.5 ? 0.23 : -0.23) : 0;

    // Timing kurva Rebound Out & Circular Ease (~240ms untuk big, ~190ms untuk small)
    const durIn = isBig ? 245 : 190;
    const tFlash = t + Math.round(durIn * 0.45);
    const tSettle = t + Math.round(durIn * 0.78);
    const tEnd = t + durIn;

    el.keys = [
      {
        t: 0,
        a: 0,
        blur: blur0,
        x,
        y: y + offsetY,
        sx: startSx,
        sy: startSy,
        rot: rot0,
        color: startColor,
        glowColor: startGlow,
        glowBlur: isBig ? 26 : 16,
        glowAlpha: hasBlueFlash ? 0.85 : 0.55
      },
      {
        t,
        a: 0,
        blur: blur0,
        x,
        y: y + offsetY,
        sx: startSx,
        sy: startSy,
        rot: rot0,
        color: startColor,
        glowColor: startGlow,
        glowBlur: isBig ? 26 : 16,
        glowAlpha: hasBlueFlash ? 0.85 : 0.55
      },
      {
        t: tFlash,
        a: 0.88,
        blur: Math.round(blur0 * 0.35),
        x,
        y: y + Math.round(offsetY * 0.16),
        sx: 98,
        sy: 98,
        rot: rot0 * 0.25,
        color: hasBlueFlash ? '#7C88FF' : WHITE,
        glowColor: startGlow,
        glowBlur: isBig ? 22 : 14,
        glowAlpha: 0.70
      },
      {
        t: tSettle,
        a: 0.98,
        blur: 1,
        x,
        y: y - 2, // Micro rebound dari Rebound Out JSON
        sx: 100.5,
        sy: 100.5,
        rot: 0,
        color: WHITE,
        glowColor: WHITE,
        glowBlur: isBig ? 18 : 12,
        glowAlpha: isBig ? 0.55 : 0.40
      },
      {
        t: tEnd,
        a: 1,
        blur: 0,
        x,
        y,
        sx: 100,
        sy: 100,
        rot: 0,
        color: WHITE,
        glowColor: WHITE,
        glowBlur: isBig ? 18 : 12,
        glowAlpha: isBig ? 0.55 : 0.40
      }
    ];

    return el;
  };

  // =========================================================================
  // EKSEKUSI 4 POLA KOMPOSISI SESUAI VIDEO REFERENSI
  // =========================================================================

  if (layoutMode === 3) {
    // POLA D: Angka Hero Raksasa di Kiri + 2 Baris Bertumpuk di Kanan ("3 / now takes / minutes")
    const numWord = raw[0];
    const midWords = raw.slice(1, -1);
    const lastWord = raw[raw.length - 1];

    let numPx = Math.round(bigPx * 1.65);
    let rTopPx = Math.round(smallPx * 1.05);
    let rBotPx = Math.round(bigPx * 0.92);

    const numFont = FONT_SERIF_REG;
    const rTopFont = FONT_SANS_LIGHT;
    const rBotFont = FONT_SANS_BOLD;

    const wNum = widthPx(numWord, numFont, numPx) * (1 + TRACK_SERIF);
    const topStr = midWords.join(' ');
    const wTop = widthPx(topStr, rTopFont, rTopPx) * (1 + TRACK_SANS);
    const wBot = widthPx(lastWord, rBotFont, rBotPx) * (1 + TRACK_SANS);

    const gapCol = Math.round(numPx * 0.08);
    const totalW = wNum + gapCol + Math.max(wTop, wBot);
    const fit = Math.min(1, MAXW / Math.max(totalW, 1));

    numPx *= fit;
    rTopPx *= fit;
    rBotPx *= fit;

    const finalWNum = widthPx(numWord, numFont, numPx) * (1 + TRACK_SERIF);
    const finalWTop = widthPx(topStr, rTopFont, rTopPx) * (1 + TRACK_SANS);
    const finalWBot = widthPx(lastWord, rBotFont, rBotPx) * (1 + TRACK_SANS);
    const blockW = finalWNum + gapCol * fit + Math.max(finalWTop, finalWBot);
    const blockStartX = Math.max(70, Math.min(1080 - 70 - blockW, cx - blockW / 2));

    const stackH = rTopPx + rBotPx * 0.92;
    const centerY = topY + stackH / 2;

    // Angka Hero Kiri
    els.push(
      buildWordElement(numWord, numFont, numPx, TRACK_SERIF, blockStartX + finalWNum / 2, centerY + numPx * 0.06, times[0], true, true, false)
    );

    // Baris Kanan Atas ("now takes")
    let curX = blockStartX + finalWNum + gapCol * fit;
    const yTopRow = topY + rTopPx * 0.52;
    midWords.forEach((mw, idx) => {
      const mwW = widthPx(mw, rTopFont, rTopPx) * (1 + TRACK_SANS);
      const spW = widthPx(' ', rTopFont, rTopPx) * 0.72;
      els.push(
        buildWordElement(mw, rTopFont, rTopPx, TRACK_SANS, curX + mwW / 2, yTopRow, times[idx + 1], false, false, false)
      );
      curX += mwW + spW;
    });

    // Baris Kanan Bawah ("minutes") dengan kilatan biru masuk
    const rightStartX = blockStartX + finalWNum + gapCol * fit;
    const yBotRow = topY + rTopPx + rBotPx * 0.36;
    els.push(
      buildWordElement(lastWord, rBotFont, rBotPx, TRACK_SANS, rightStartX + finalWBot / 2, yBotRow, times[raw.length - 1], true, true, true)
    );

    yBottom = topY + stackH;

  } else if (layoutMode === 1) {
    // POLA B: 2 Baris Bertumpuk Kontras (Atas kecil Light Sans, Bawah besar Serif Italic / Bold Sans)
    const splitIdx = ki > 0 ? ki : Math.max(1, raw.length - 1);
    const topWords = raw.slice(0, splitIdx);
    const botWords = raw.slice(splitIdx);

    const topItems = topWords.map((w, i) => ({
      word: w,
      idx: i,
      font: FONT_SANS_LIGHT,
      px: smallPx,
      track: TRACK_SANS,
      isBig: false,
      isKey: false,
      blueFlash: false
    }));

    const botItems = botWords.map((w, i) => {
      const realIdx = splitIdx + i;
      const isK = realIdx === ki || botWords.length === 1;
      return {
        word: w,
        idx: realIdx,
        font: isK ? getKeyFont(w) : FONT_SANS_BOLD,
        px: bigPx,
        track: isK ? getKeyTrack(w) : TRACK_SANS,
        isBig: true,
        isKey: isK,
        blueFlash: isK && r() > 0.35
      };
    });

    const measureRow = (items, scale = 1) =>
      items.reduce((acc, it, idx) => {
        const w = widthPx(it.word, it.font, it.px * scale) * (1 + it.track);
        const sp = idx ? widthPx(' ', it.font, it.px * scale) * 0.68 : 0;
        return acc + w + sp;
      }, 0);

    const maxW = Math.max(measureRow(topItems), measureRow(botItems), 1);
    const fit = Math.min(1, Math.min(MAXW, 740) / maxW);
    topItems.forEach((it) => (it.px *= fit));
    botItems.forEach((it) => (it.px *= fit));

    const wTopRow = measureRow(topItems);
    const wBotRow = measureRow(botItems);
    const blockW = Math.max(wTopRow, wBotRow);
    const blockStartX = Math.max(70, Math.min(1080 - 70 - blockW, cx - blockW / 2));

    // Rata kiri selaras atau sedikit offset editorial pada baris bawah
    let xTop = blockStartX + (wBotRow > wTopRow ? (wBotRow - wTopRow) * 0.12 : 0);
    const yTop = topY + topItems[0].px * 0.5;
    topItems.forEach((it) => {
      const ww = widthPx(it.word, it.font, it.px) * (1 + it.track);
      const sp = widthPx(' ', it.font, it.px) * 0.68;
      els.push(buildWordElement(it.word, it.font, it.px, it.track, xTop + ww / 2, yTop, times[it.idx], false, false, false));
      xTop += ww + sp;
    });

    // Jarak baris sangat menempel (-0.12 * bigPx)
    const tightGap = Math.round(-bigPx * 0.12 * fit);
    let xBot = blockStartX + (wTopRow > wBotRow ? (wTopRow - wBotRow) * 0.35 : 0);
    const yBot = yTop + topItems[0].px * 0.45 + botItems[0].px * 0.48 + tightGap;
    botItems.forEach((it) => {
      const ww = widthPx(it.word, it.font, it.px) * (1 + it.track);
      const sp = widthPx(' ', it.font, it.px) * 0.65;
      els.push(buildWordElement(it.word, it.font, it.px, it.track, xBot + ww / 2, yBot, times[it.idx], true, it.isKey, it.blueFlash));
      xBot += ww + sp;
    });

    yBottom = yBot + botItems[0].px * 0.5;

  } else {
    // POLA A & C: 1 Baris Horizontal Sejajar ("your captions are", "ADDICTIVE", "for me", "what used to take me")
    const isHeroPairOrSingle = raw.length <= 2;
    const items = raw.map((w, i) => {
      const isK = i === ki || isHeroPairOrSingle;
      // Jika 1 kata tunggal penuh penekanan, jadikan uppercase editorial
      const displayWord = raw.length === 1 && w.length >= 5 ? w.toUpperCase() : w;
      const px = isK ? (raw.length === 1 ? Math.round(bigPx * 1.08) : bigPx) : Math.round(bigPx * 0.56);
      const font = isK ? getKeyFont(w) : FONT_SANS_LIGHT;
      const track = isK ? getKeyTrack(w) : TRACK_SANS;
      // Kilatan biru muncul pada kata pertama atau keyword utama secara bergantian
      const blueFlash = (i === 0 && r() > 0.55) || (isK && i > 0 && r() > 0.4);

      return {
        word: displayWord,
        idx: i,
        font,
        px,
        track,
        isBig: isK,
        isKey: isK,
        blueFlash
      };
    });

    const totalW = items.reduce((acc, it, idx) => {
      const w = widthPx(it.word, it.font, it.px) * (1 + it.track);
      const sp = idx ? widthPx(' ', it.font, it.px) * 0.62 : 0;
      return acc + w + sp;
    }, 0);

    const fit = Math.min(1, MAXW / Math.max(totalW, 1));
    items.forEach((it) => (it.px *= fit));

    const finalBlockW = items.reduce((acc, it, idx) => {
      const w = widthPx(it.word, it.font, it.px) * (1 + it.track);
      const sp = idx ? widthPx(' ', it.font, it.px) * 0.62 : 0;
      return acc + w + sp;
    }, 0);

    const blockStartX = Math.max(70, Math.min(1080 - 70 - finalBlockW, cx - finalBlockW / 2));
    const maxH = Math.max(...items.map((it) => it.px));
    const baseLineY = topY + maxH * 0.55;

    let curX = blockStartX;
    items.forEach((it) => {
      const ww = widthPx(it.word, it.font, it.px) * (1 + it.track);
      const sp = widthPx(' ', it.font, it.px) * 0.62;
      // Sejajarkan baseline huruf kecil dengan huruf besar
      const yPos = it.isBig ? baseLineY : baseLineY + (maxH - it.px) * 0.14;
      els.push(
        buildWordElement(it.word, it.font, it.px, it.track, curX + ww / 2, yPos, times[it.idx], it.isBig, it.isKey, it.blueFlash)
      );
      curX += ww + sp;
    });

    yBottom = topY + maxH;
  }

  return { elements: els, box: { top: topY, bottom: yBottom } };
}
// ---- preset: capEditorialContrastStack.txt
// Nama Gaya Sosmed : Editorial Contrast Stacked Captions / Minimalist Helvetica Hierarchy
// Karakteristik : Blok 2-4 baris bertumpuk kompak (Tight Leading) dengan kontras ukuran & ketebalan ekstrem (Light kecil di atas/bawah, Bold/Light raksasa untuk frasa keyword 1-3 kata di tengah), kombinasi gerakan Blur-Up (Rebound Out) dan Hazy-Side Zoom (Circular Ease), serta selective green box highlight.
// Font Wajib : Helvetica Neue Light, Helvetica Neue Regular, Helvetica Neue Bold, Times New Roman Italic
// Mode Blend : Normal (ow: 0, sd: 0, shade: false, soft white outer glow halus + selective green box highlight)
// Chunk: 2-7

function capEditorialContrastStack(text, o = {}) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };

  const r = typeof rng === 'function' ? rng(`editorial_contrast_v2|${text}`) : Math.random;
  const ki = estKeyIndex(raw);
  const times = wordTimes(raw, o.dur || 1500);

  const FONT_KEY_BOLD = 'Helvetica Neue Bold';
  const FONT_KEY_LIGHT = 'Helvetica Neue Light';
  const FONT_SERIF_ITALIC = 'Times New Roman Italic';
  const FONT_REG = 'Helvetica Neue Regular';
  const FONT_THIN = 'Helvetica Neue Light';
  const TRACK = -0.045;
  const MAXW = 860;

  const cx = o.cx ?? 540;
  const topY = o.top ?? 1190;
  const basePx = (o.px || 105) * (o.k || 1);

  // Rasio ukuran sesuai video: pendukung 32% dari ukuran keyword utama
  let bigPx = Math.round(basePx * 0.80);
  let smallPx = Math.max(Math.round(basePx * 0.27), 25);

  // Variasi gaya tipografi di video:
  // ~72% Bold/Medium (default), ~18% Light raksasa (seperti "percaya", "INVESTOR", "karyawan"), ~10% Serif Italic (seperti "kerja yang bagus")
  const styleRoll = r();
  const useLightHero = styleRoll > 0.72 && styleRoll <= 0.90;
  const useSerifMood = styleRoll > 0.90;
  const useGreenBox = !useLightHero && !useSerifMood && r() > 0.86;

  // Tentukan rentang frasa keyword (1-2 kata besar bersebelahan seperti "tidak pernah", "hidup nyaman", "MERUBAH NASIBNYA")
  let keyStart = ki;
  let keyEnd = ki;
  if (raw.length >= 3 && ki + 1 < raw.length && raw[ki + 1].length <= 8 && r() > 0.42) {
    keyEnd = ki + 1;
  }

  // Susun baris bertumpuk secara dinamis (maksimal 3-4 baris sesuai panjang chunk 2-7 kata)
  const rows = []; // { items: [...], align: 'left' | 'right-to-hero' | 'split-top' }

  const makeItem = (word, idx, isBig, isKey, tier) => ({
    word: isKey && useGreenBox ? word.toUpperCase() : word,
    idx,
    big: isBig,
    isKey,
    tier
  });

  if (raw.length <= 2) {
    // Contoh: "BERAT SEKALI" (2 baris besar bertumpuk) atau "that's it" (1 baris besar)
    if (raw.length === 2 && raw[0].length >= 5 && raw[1].length >= 5) {
      rows.push({ items: [makeItem(raw[0].toUpperCase(), 0, true, true, 'key')], align: 'left' });
      rows.push({ items: [makeItem(raw[1].toUpperCase(), 1, true, true, 'key')], align: 'left' });
    } else {
      rows.push({
        items: raw.map((w, i) => makeItem(w, i, true, true, 'key')),
        align: 'left'
      });
    }
  } else {
    // 1. Baris Atas: Kata-kata sebelum keyword (ukuran kecil Light)
    if (keyStart > 0) {
      const preWords = raw.slice(0, keyStart).map((w, i) => makeItem(w.toLowerCase(), i, false, false, 'thin'));
      // Efek khas detik 00:20 ("pada          orang-orang" di atas "pemberani") jika preWords 2-3 kata
      const isSplitTop = preWords.length >= 2 && preWords.length <= 3 && r() > 0.72;
      rows.push({ items: preWords, align: isSplitTop ? 'split-top' : 'left' });
    }

    // 2. Baris Tengah (Hero): Frasa Keyword utama (1-2 kata besar)
    const heroWords = [];
    for (let i = keyStart; i <= keyEnd; i++) {
      heroWords.push(makeItem(raw[i], i, true, true, 'key'));
    }
    rows.push({ items: heroWords, align: 'left' });

    // 3. Baris Bawah: Kata-kata lanjutan setelah keyword
    const postIdxStart = keyEnd + 1;
    if (postIdxStart < raw.length) {
      const remCount = raw.length - postIdxStart;
      // Jika sisa kata >= 3 (seperti "oleh kebanyakan orang"), buat pola bertumpuk 2 tingkat seperti detik 00:09-00:10
      if (remCount >= 3) {
        rows.push({
          items: [makeItem(raw[postIdxStart].toLowerCase(), postIdxStart, false, false, 'reg')],
          align: 'right-to-hero'
        });
        const subHeroWords = [];
        for (let i = postIdxStart + 1; i < raw.length; i++) {
          const isLastTail = i === raw.length - 1 && remCount >= 3 && raw[i].length <= 5;
          subHeroWords.push(
            makeItem(
              isLastTail ? raw[i].toLowerCase() : raw[i],
              i,
              !isLastTail,
              !isLastTail,
              isLastTail ? 'reg' : 'key'
            )
          );
        }
        rows.push({ items: subHeroWords, align: 'left' });
      } else {
        // Sisa 1-2 kata kecil di bawah keyword, rata kanan terhadap ujung keyword (seperti "bahwa", "coba hal baru", "yang gak mendukung")
        const postWords = [];
        for (let i = postIdxStart; i < raw.length; i++) {
          postWords.push(makeItem(raw[i].toLowerCase(), i, false, false, 'reg'));
        }
        rows.push({ items: postWords, align: 'right-to-hero' });
      }
    }
  }

  const pxOf = (it) => (it.big ? bigPx : smallPx);
  const fontOf = (it) => {
    if (useSerifMood) return FONT_SERIF_ITALIC;
    if (it.tier === 'key') return useLightHero ? FONT_KEY_LIGHT : FONT_KEY_BOLD;
    if (it.tier === 'reg') return FONT_REG;
    return FONT_THIN;
  };

  const spaceW = (it) => widthPx(' ', fontOf(it), pxOf(it)) * 0.78;
  const wOf = (it) => widthPx(it.word, fontOf(it), pxOf(it)) * (1 + TRACK);
  const rowW = (items) => items.reduce((acc, it, j) => acc + wOf(it) + (j ? spaceW(it) : 0), 0);

  const maxRowWidth = Math.max(...rows.map((rw) => rowW(rw.items)), 1);
  const targetMaxW = Math.min(MAXW, 660);
  const fitScale = Math.min(1, targetMaxW / maxRowWidth);
  bigPx *= fitScale;
  smallPx *= fitScale;

  // Tight leading (jarak antar baris sangat rapat menempel seperti referensi video)
  const gap = Math.round(-basePx * 0.065 * fitScale);
  const heroRowObj = rows.find((rw) => rw.items.some((it) => it.big)) || rows[0];
  const heroW = rowW(heroRowObj.items);
  const blockW = Math.max(...rows.map((rw) => rowW(rw.items)), heroW);
  const blockStartX = Math.max(70, Math.min(1080 - 70 - blockW, cx - blockW / 2));

  // Mode gerakan dari ekstraksi JSON:
  // 0: 1_Blur_Up & 1_Basic_Up (offset Y +121px, Rebound Out 89% di 130ms, selesai 600ms)
  // 1: 3_Left_Hazy & 3_Right_Hazy (offset X ±165px, scale 188% -> 100%, rotasi 0.23 deg, Circular Ease)
  const motionMode = r() < 0.70 ? 0 : 1;
  const sideDir = r() > 0.5 ? 1 : -1;

  const createWordEl = (w, font, px, x, y, t, isBig, isKey) => {
    const el = {
      kind: 'text',
      text: w,
      font,
      px,
      fsp: TRACK * px,
      color: '#FFFFFF',
      oc: '#FFFFFF',
      ow: 0,
      sd: 0,
      shade: false,
      glowColor: '#FFFFFF',
      glowBlur: isKey ? 14 : 9,
      glowAlpha: isKey ? 0.30 : 0.18,
      x,
      y,
      rot: 0,
      keys: []
    };

    if (motionMode === 0) {
      const dy = Math.round((isBig ? 121 : 75) * fitScale);
      const blur0 = isBig ? 16 : 11;
      const tStart = t + 33;
      const tFast = t + 130;
      const tEnd = t + 600;

      el.keys = [
        { t: 0,      a: 0,    blur: blur0, x, y: y + dy,                    sx: 100, sy: 100, rot: 0 },
        { t: tStart, a: 0,    blur: blur0, x, y: y + dy,                    sx: 100, sy: 100, rot: 0 },
        { t: tFast,  a: 0.89, blur: 3,     x, y: y + Math.round(dy * 0.11), sx: 100, sy: 100, rot: 0 },
        { t: tEnd,   a: 1,    blur: 0,     x, y,                            sx: 100, sy: 100, rot: 0 }
      ];
    } else {
      const dx = sideDir * Math.round((isBig ? 165 : 105) * fitScale);
      const startScale = isBig ? 188 : 142;
      const rot0 = sideDir * 0.23;
      const blur0 = isBig ? 18 : 12;
      const tAlphaStart = t + 100;
      const tMid = t + 350;
      const tEnd = t + 700;

      el.keys = [
        { t: 0,           a: 0,    blur: blur0, x: x + dx,                    y, sx: startScale, sy: startScale, rot: rot0 },
        { t: tAlphaStart, a: 0,    blur: blur0, x: x + dx,                    y, sx: startScale, sy: startScale, rot: rot0 },
        { t: tMid,        a: 0.86, blur: 4,     x: x + Math.round(dx * 0.14), y, sx: 108,        sy: 108,        rot: rot0 * 0.15 },
        { t: tEnd,        a: 1,    blur: 0,     x,                            y, sx: 100,        sy: 100,        rot: 0 }
      ];
    }

    return el;
  };

  const els = [];
  let y = topY;

  rows.forEach((rw) => {
    const items = rw.items;
    if (!items.length) return;

    const h = Math.max(...items.map(pxOf));
    const cy = y + h / 2;
    const curRowW = rowW(items);

    let x = blockStartX;
    if (rw.align === 'right-to-hero' && heroW > curRowW) {
      x = blockStartX + (heroW - curRowW);
    }

    items.forEach((it, idxInRow) => {
      const ww = wOf(it);
      // Untuk gaya 'split-top' (seperti "pada      orang-orang"), dorong kata terakhir menjorok ke ujung kanan heroW
      if (rw.align === 'split-top' && idxInRow === items.length - 1 && heroW > curRowW + 40) {
        x = blockStartX + heroW - ww;
      }

      const baselineOffset = (h - pxOf(it)) * 0.35;
      const wordCx = x + ww / 2;
      const wordCy = cy + baselineOffset;
      const wordEl = createWordEl(
        it.word,
        fontOf(it),
        pxOf(it),
        wordCx,
        wordCy,
        times[it.idx],
        it.big,
        it.isKey
      );

      if (it.isKey && useGreenBox) {
        const padX = Math.round(18 * fitScale);
        const padY = Math.round(10 * fitScale);
        els.push({
          kind: 'rect',
          x: wordCx,
          y: wordCy,
          w: ww + padX * 2,
          h: pxOf(it) + padY * 2,
          r: 0,
          color: '#28A745',
          rot: 0,
          keys: wordEl.keys.map((k) => ({
            t: k.t,
            a: k.a,
            blur: Math.round(k.blur * 0.5),
            x: k.x,
            y: k.y,
            sx: k.sx,
            sy: k.sy,
            rot: k.rot
          }))
        });
      }

      els.push(wordEl);
      x += ww + spaceW(it);
    });

    y += h + gap;
  });

  return {
    elements: els,
    box: { top: topY, bottom: y - gap }
  };
}
CHUNK_RULES['cap_antonioeditorial'] = { min: 1, max: 5 };
CHUNK_RULES['cap_applekeynotekinetic'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorial4pattern'] = { min: 2, max: 5 };
CHUNK_RULES['cap_editorialcontrast2'] = { min: 1, max: 5 };
CHUNK_RULES['cap_editorialserifcontrast'] = { min: 1, max: 5 };
CHUNK_RULES['cap_editorialserifkinetic'] = { min: 2, max: 5 };
CHUNK_RULES['cap_fusioncleanglow'] = { min: 1, max: 4 };
CHUNK_RULES['cap_garamondeditorialhybrid'] = { min: 1, max: 5 };
CHUNK_RULES['cap_glowrevealeditorial'] = { min: 1, max: 3 };
CHUNK_RULES['cap_helveticastackededitorial'] = { min: 2, max: 6 };
CHUNK_RULES['cap_invideoeditorialblur'] = { min: 2, max: 5 };
CHUNK_RULES['cap_kineticeditorialmix'] = { min: 2, max: 5 };
CHUNK_RULES['cap_kineticeditorialstack'] = { min: 1, max: 6 };
CHUNK_RULES['cap_minimalistdifference'] = { min: 2, max: 3 };
CHUNK_RULES['cap_stackedcontrasthook'] = { min: 1, max: 5 };
CHUNK_RULES['cap_stackedneonscript'] = { min: 1, max: 4 };
CHUNK_RULES['cap_submagiceditorial'] = { min: 1, max: 4 };
CHUNK_RULES['cap_editorialcontraststack'] = { min: 2, max: 7 };
TEMPLATES['cap_antonioeditorial'] = function (t, o) { return capAntonioEditorial(t, o); };
TEMPLATES['cap_applekeynotekinetic'] = function (t, o) { return capAppleKeynoteKinetic(t, o); };
TEMPLATES['cap_editorial4pattern'] = function (t, o) { return capEditorial4Pattern(t, o); };
TEMPLATES['cap_editorialcontrast2'] = function (t, o) { return capEditorialContrastV2(t, o); };
TEMPLATES['cap_editorialserifcontrast'] = function (t, o) { return capEditorialSerifContrast(t, o); };
TEMPLATES['cap_editorialserifkinetic'] = function (t, o) { return capEditorialSerifKinetic(t, o); };
TEMPLATES['cap_fusioncleanglow'] = function (t, o) { return capFusionCleanGlow(t, o); };
TEMPLATES['cap_garamondeditorialhybrid'] = function (t, o) { return capGaramondEditorialHybrid(t, o); };
TEMPLATES['cap_glowrevealeditorial'] = function (t, o) { return capGlowRevealEditorial(t, o); };
TEMPLATES['cap_helveticastackededitorial'] = function (t, o) { return capHelveticaStackedEditorial(t, o); };
TEMPLATES['cap_invideoeditorialblur'] = function (t, o) { return capInvideoEditorialBlur(t, o); };
TEMPLATES['cap_kineticeditorialmix'] = function (t, o) { return capKineticEditorialMix(t, o); };
TEMPLATES['cap_kineticeditorialstack'] = function (t, o) { return capKineticEditorialStack(t, o); };
TEMPLATES['cap_minimalistdifference'] = function (t, o) { return capMinimalistDifference(t, o); };
TEMPLATES['cap_stackedcontrasthook'] = function (t, o) { return capStackedContrastHook(t, o); };
TEMPLATES['cap_stackedneonscript'] = function (t, o) { return capStackedNeonScript(t, o); };
TEMPLATES['cap_submagiceditorial'] = function (t, o) { return capSubmagicEditorial(t, o); };
TEMPLATES['cap_editorialcontraststack'] = function (t, o) { return capEditorialContrastStack(t, o); };

const CAPTION_LIST = [
  { id: 'cap_susun', label: 'Susun' },
  { id: 'cap_glow', label: 'Bara' },
  { id: 'cap_glow_lime', label: 'Neon' },
  { id: 'cap_glow_putih', label: 'Halo' },
  { id: 'cap_campur', label: 'Klasik' },
  { id: 'cap_fokus_oranye', label: 'Sorot' },
  { id: 'cap_fokus_miring', label: 'Miring' },
  { id: 'cap_acak_bootzy', label: 'Tumpuk' },
  { id: 'cap_quote', label: 'Quote' },
  { id: 'cap_estetik', label: 'Estetik' },
  { id: 'cap_tumpuk2', label: 'Tumpuk 2' },
  { id: 'cap_editorialdual', label: 'Ed. Dual' },
  { id: 'cap_cleanblurreveal', label: 'Clean Blur Reveal' },
  { id: 'cap_cleaneditorial', label: 'Clean Editorial' },
  { id: 'cap_editorialcontrast', label: 'Ed. Contrast' },
  { id: 'cap_editorialemphasis', label: 'Ed. Emphasis' },
  { id: 'cap_editorialminimal', label: 'Ed. Minimal' },
  { id: 'cap_editorialmix', label: 'Ed. Mix' },
  { id: 'cap_editorialscript', label: 'Ed. Script' },
  { id: 'cap_editorialscriptmix', label: 'Ed. Script Mix' },
  { id: 'cap_editorialstacked', label: 'Ed. Stacked' },
  { id: 'cap_editorialswiss', label: 'Ed. Swiss' },
  { id: 'cap_editorialtightsans', label: 'Ed. Tight Sans' },
  { id: 'cap_imanstackedglow', label: 'Iman Stacked Glow' },
  { id: 'cap_kineticsandwich', label: 'Kinetic Sandwich' },
  { id: 'cap_swisskineticimpact', label: 'Swiss Kinetic Impact' },
  { id: 'cap_tumpuk3lime', label: 'Tumpuk3 Lime' },
  { id: 'cap_antonioeditorial', label: 'Antonio Editorial' },
  { id: 'cap_applekeynotekinetic', label: 'Apple Keynote' },
  { id: 'cap_editorial4pattern', label: 'Editorial 4 Pola' },
  { id: 'cap_editorialcontrast2', label: 'Ed. Contrast 2' },
  { id: 'cap_editorialserifcontrast', label: 'Ed. Serif Contrast' },
  { id: 'cap_editorialserifkinetic', label: 'Ed. Serif Kinetic' },
  { id: 'cap_fusioncleanglow', label: 'Fusion Clean Glow' },
  { id: 'cap_garamondeditorialhybrid', label: 'Garamond Hybrid' },
  { id: 'cap_glowrevealeditorial', label: 'Glow Reveal' },
  { id: 'cap_helveticastackededitorial', label: 'Helvetica Stacked' },
  { id: 'cap_invideoeditorialblur', label: 'Invideo Blur' },
  { id: 'cap_kineticeditorialmix', label: 'Kinetic Ed. Mix' },
  { id: 'cap_kineticeditorialstack', label: 'Kinetic Ed. Stack' },
  { id: 'cap_minimalistdifference', label: 'Minimalist Diff' },
  { id: 'cap_stackedcontrasthook', label: 'Stacked Contrast Hook' },
  { id: 'cap_stackedneonscript', label: 'Stacked Neon Script' },
  { id: 'cap_submagiceditorial', label: 'Submagic Editorial' },
  { id: 'cap_editorialcontraststack', label: 'Ed. Contrast Stack' },
];

// ---------------------------------------------------------------------------
// [WORD-STATE-CAPTION] "Gaya kata" caption templates: the whole phrase shows,
// and the word being spoken takes a CURRENT style (colour, box, pop), words
// already spoken a PAST style, words still to come a NEXT style. Design ideas
// adapted (ATM — own names, own implementation) from the MIT-licensed
// CaptionCat preset catalog (github.com/ItisShikhar/captioncat, (c) 2026
// Shikhar Srivastava); see assets/fonts/licenses/THIRD-PARTY.txt.
//
// One cue = one page. Word i is "current" from its share of the cue (by
// characters) until the next word starts.
P.round = (w, h, r) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return P.rect(w, h);
  const k = 0.5523 * r;   // cubic Bézier circle approximation
  return `m ${r} 0 l ${w - r} 0 b ${w - r + k} 0 ${w} ${r - k} ${w} ${r} l ${w} ${h - r} b ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}`
    + ` l ${r} ${h} b ${r - k} ${h} 0 ${h - r + k} 0 ${h - r} l 0 ${r} b 0 ${r - k} ${r - k} 0 ${r} 0`;
};
// Chat bubble with a tail at the bottom right.
P.bubble = (w, h, r) => `${P.round(w, h, r)} m ${w - r * 0.9} ${h - 2} l ${w + r * 0.35} ${h + r * 0.45} ${w - r * 0.15} ${h - r * 0.55}`;

function stateAt(el, t) {
  const K = resolvedKeys(el);
  let cur = K[0];
  for (const k of K) { if (k.t <= t) cur = k; else break; }
  return cur;
}
function caseOf(w, c) { return c === 'upper' ? w.toUpperCase() : c === 'lower' ? w.toLowerCase() : w; }
// Word timing over the WHOLE cue (current word follows the speech).
function wordWindows(words, dur) {
  const tot = words.reduce((a, w) => a + w.length + 1, 0) || 1;
  let acc = 0;
  const st = words.map((w) => { const t = (acc / tot) * dur; acc += w.length + 1; return Math.round(t); });
  return st.map((t, i) => [t, i + 1 < st.length ? st[i + 1] : Math.round(dur)]);
}
function ccRows(words, s, px, maxW) {
  const sp = widthPx(' ', s.font, px);
  if (s.wordsPerRow) {
    const out = [];
    for (let i = 0; i < words.length; i += s.wordsPerRow) out.push(words.slice(i, i + s.wordsPerRow).map((_, j) => i + j));
    return out;
  }
  const rows = [];
  let cur = [], w = 0;
  words.forEach((wd, i) => {
    const ww = widthPx(wd, s.font, px) + (s.track || 0) * wd.length;
    if (cur.length && w + sp + ww > maxW) { rows.push(cur); cur = []; w = 0; }
    w += (cur.length ? sp : 0) + ww; cur.push(i);
  });
  if (cur.length) rows.push(cur);
  return rows;
}
function ccBuild(text, o, s) {
  const raw = text.split(/\s+/).filter(Boolean);
  if (!raw.length) return { elements: [], box: null };
  if (s.reveal === 'single') return ccSingle(raw, o, s);
  // Keep the block within maxH (default 560 px): a tall stack shrinks.
  if (!o._fitH) {
    const first = ccBuild(text, Object.assign({}, o, { _fitH: true }), s);
    const h = first.box ? first.box.bottom - first.box.top : 0;
    const maxH = s.maxH || 560;
    if (h > maxH) return ccBuild(text, Object.assign({}, o, { _fitH: true, k: (o.k || 1) * maxH / h }), s);
    return first;
  }
  const words = raw.map((w) => caseOf(w, s.case));
  const dur = o.dur || 1500;
  const win = wordWindows(words, dur);
  let px = (s.px || 100) * (o.k || 1);
  const maxW = s.maxW || 860;
  // Fit: rows of a fixed count shrink to the widest row; 'fill' scales one
  // row up/down to the full width.
  let rows = ccRows(words, s, px, maxW);
  if (s.maxRows && rows.length > s.maxRows) {
    // Too many rows for this template: shrink until it fits.
    for (let t = 0; t < 8 && rows.length > s.maxRows; t++) { px *= 0.88; rows = ccRows(words, s, px, maxW); }
  }
  const sp = widthPx(' ', s.font, px) + (s.gapX || 0);
  const rowW = (r) => r.reduce((a, i) => a + widthPx(words[i], s.font, px) + (s.track || 0) * words[i].length, 0) + sp * (r.length - 1);
  const widest = Math.max(...rows.map(rowW));
  if (s.fill || widest > maxW) px *= (s.fill ? Math.min(1.6, maxW / widest) : maxW / widest);
  const sp2 = widthPx(' ', s.font, px) + (s.gapX || 0) * px / (s.px || 100);
  const lh = px * (s.lh || 1.15);
  const gapY = (s.gapY || 0) * px;
  const H = rows.length * lh + (rows.length - 1) * gapY;
  const cx = o.cx, top = o.top;
  const rot = s.rot || 0;
  const ocy = top + H / 2;
  const R = (x, y) => rotPt(x, y, cx, ocy, rot);
  const els = [];
  const pad = s.pad || [0.18, 0.3];   // [y, x] in em
  // Page box (behind everything).
  const rowGeom = rows.map((r, ri) => {
    const W = r.reduce((a, i) => a + widthPx(words[i], s.font, px) + (s.track || 0) * words[i].length, 0) + sp2 * (r.length - 1);
    const y = top + ri * (lh + gapY) + lh / 2;
    let x = s.align === 'left' ? cx - maxW / 2 : cx - W / 2;
    const items = r.map((i) => { const ww = widthPx(words[i], s.font, px) + (s.track || 0) * words[i].length; const it = { i, x: x + ww / 2, ww }; x += ww + sp2; return it; });
    return { r, W, y, items, x0: items[0].x - items[0].ww / 2 };
  });
  const allW = Math.max(...rowGeom.map((g) => g.W));
  if (s.pageBox) {
    const b = s.pageBox, py = pad[0] * px, pxx = pad[1] * px;
    const w = allW + 2 * pxx, h = H + 2 * py;
    const [bx, by] = R(cx, ocy);
    els.push({ kind: 'shape', path: b.bubble ? P.bubble(w, h, b.radius * px) : P.round(w, h, (b.radius || 0) * px), w, h, color: b.color, x: bx, y: by, rot,
      keys: [{ t: 0, a: b.alpha != null ? b.alpha : 1, sx: b.pop ? 70 : 100, sy: b.pop ? 70 : 100 }, { t: b.pop ? 160 : 0, sx: 100, sy: 100 }] });
  }
  rowGeom.forEach((g, ri) => {
    if (s.rowBox) {
      const b = s.rowBox, py = pad[0] * px, pxx = pad[1] * px;
      const w = g.W + 2 * pxx, h = lh * (b.h || 1) + 2 * py - lh * 0.15;
      const [bx, by] = R(g.x0 + g.W / 2, g.y);
      const color = Array.isArray(b.color) ? b.color[ri % b.color.length] : b.color;
      els.push({ kind: 'shape', path: P.round(w, h, (b.radius || 0) * px), w, h, color, x: bx, y: by, rot, keys: [{ t: 0, a: 1 }] });
    }
  });
  rowGeom.forEach((g) => g.items.forEach((it) => {
    const [t0, t1] = win[it.i];
    const [x, y] = R(it.x, g.y);
    const base = { kind: 'text', text: words[it.i], font: s.font, px, oc: s.stroke ? s.stroke[1] : '#000000', ow: s.stroke ? s.stroke[0] * px / 100 : 0,
      sc: s.shadow ? s.shadow[1] : '#000000', sd: s.shadow ? s.shadow[0] * px / 100 : 0, glow: s.glow || null, x, y, rot, sxFix: s.scaleX };
    const appear = s.reveal === 'build' ? t0 : 0;
    const SX = s.scaleX || 100;   // narrowed letters (glass look)
    // Word box behind every word (twitch style).
    if (s.wordBox) {
      const b = s.wordBox, w = it.ww + 2 * pad[1] * px, h = lh + 2 * pad[0] * px - lh * 0.15;
      els.push({ kind: 'shape', path: P.round(w, h, (b.radius || 0) * px), w, h, color: b.color, x, y, rot, keys: [{ t: 0, a: appear ? 0 : 1 }, { t: appear, a: 1 }] });
    }
    // Box behind the current word only.
    if (s.current && s.current.box) {
      const b = s.current.box, w = it.ww + 2 * pad[1] * px, h = lh + 2 * pad[0] * px - lh * 0.15;
      els.push({ kind: 'shape', path: P.round(w, h, (b.radius || 0) * px), w, h, color: b.color, x, y, rot,
        keys: [{ t: 0, a: 0 }, { t: t0, a: 1, sx: 80, sy: 80 }, { t: t0 + 90, sx: 100, sy: 100 }, { t: t1, a: 0 }] });
    }
    // NEXT style until the word starts, PAST after it ends (or one colour).
    const nextC = s.next || s.color, pastC = s.past || s.color;
    const nextA = s.nextA != null ? s.nextA : 1, pastA = s.pastA != null ? s.pastA : 1;
    if (s.reveal === 'type') {
      // Typewriter: characters of this word arrive one by one inside its window.
      const chars = Array.from(words[it.i]);
      const per = Math.max(16, Math.min(60, (t1 - t0) / Math.max(1, chars.length)));
      let cx0 = x - it.ww / 2;
      chars.forEach((ch, ci) => {
        const cw = widthPx(ch, s.font, px) + (s.track || 0);
        const at = t0 + ci * per;
        els.push(Object.assign({}, base, { text: ch, color: s.color, x: cx0 + cw / 2, keys: [{ t: 0, a: 0 }, { t: at, a: 1 }] }));
        cx0 += cw;
      });
      return;
    }
    if (nextC === pastC && nextA === pastA && !s.reveal) {
      els.push(Object.assign({}, base, { color: s.color, keys: [{ t: 0, a: nextA, sx: SX }, ...(s.flicker ? flickerKeys(it.i, dur, nextA) : [])] }));
    } else {
      els.push(Object.assign({}, base, { color: nextC, keys: [{ t: 0, a: appear ? 0 : nextA }, { t: appear || 0, a: nextA }, { t: t0, a: 0 }] }));
      els.push(Object.assign({}, base, { color: pastC, keys: [{ t: 0, a: 0 }, { t: t1, a: pastA }] }));
    }
    if (s.current) {
      const c = s.current, pop = c.pop != null ? c.pop : 100;
      els.push(Object.assign({}, base, { color: c.color || s.color, glow: c.glow || base.glow, blur: 0,
        keys: [{ t: 0, a: 0, sx: pop, sy: pop }, { t: t0, a: 0 }, { t: t0 + 1, a: 1 }, { t: t0 + 120, sx: c.scale || 100, sy: c.scale || 100 }, { t: t1, a: c.stay ? 1 : 0 }] }));
    }
  }));
  // Constant blur (soft glass look) on every text element.
  if (s.blur) els.forEach((e) => { if (e.kind === 'text') e.keys = (e.keys || []).map((k) => Object.assign({ blur: s.blur }, k)); });
  // Word-state changes are SWITCHES (a word is current or it is not): hold the
  // previous state until 1 ms before each opacity change, or both the ASS \t
  // and the preview's keyframes would fade it across the whole gap.
  els.forEach((e) => { e.keys = switchKeys(e.keys || []); });
  return { elements: els, box: { top: top - pad[0] * px, bottom: top + H + pad[0] * px } };
}
// One word at a time in the same spot (each replaces the last).
function ccSingle(raw, o, s) {
  const words = raw.map((w) => caseOf(w, s.case));
  const dur = o.dur || 1500;
  const win = wordWindows(words, dur);
  const els = [];
  let px = (s.px || 100) * (o.k || 1);
  const maxWord = Math.max(...words.map((w) => widthPx(w, s.font, px)));
  if (maxWord > (s.maxW || 860)) px *= (s.maxW || 860) / maxWord;
  const y = o.top + px * 0.6;
  words.forEach((w, i) => {
    const [t0, t1] = win[i];
    const pop = (s.current && s.current.pop) || 100;
    els.push({ kind: 'text', text: w, font: s.font, px, color: (s.current && s.current.color) || s.color,
      oc: s.stroke ? s.stroke[1] : '#000000', ow: s.stroke ? s.stroke[0] * px / 100 : 0, sc: s.shadow ? s.shadow[1] : '#000000', sd: s.shadow ? s.shadow[0] * px / 100 : 0,
      x: o.cx, y, rot: 0,
      keys: [{ t: 0, a: 0, sx: pop, sy: pop, blur: 4 }, { t: t0, a: 0 }, { t: t0 + 1, a: 1 }, { t: t0 + 110, sx: 100, sy: 100, blur: 0 }, { t: Math.max(t0 + 120, t1), a: i === words.length - 1 ? 1 : 0 }] });
  });
  return { elements: els, box: { top: o.top, bottom: o.top + px * 1.2 } };
}
function switchKeys(keys) {
  const out = [];
  let a = null, prevT = 0;
  for (const k of keys) {
    if (k.a != null && a != null && k.a !== a && k.t - prevT > 2) out.push({ t: k.t - 1 });
    out.push(k);
    if (k.a != null) a = k.a;
    prevT = k.t;
  }
  return out;
}
function flickerKeys(seed, dur, a) {
  const r = rng(`flicker${seed}`);
  const out = [];
  for (let t = 200 + r() * 300; t < dur - 150; t += 250 + r() * 600) { out.push({ t, a: 0 }, { t: t + 40 + r() * 50, a }); }
  return out;
}
const CC = {
  //       font, base px, case, colours, effects
  cc_dua_pita:      { label: 'Dua pita',      font: 'Poppins Bold', px: 82, case: 'upper', color: '#000000', maxRows: 2, lh: 1.2, gapY: 0.32, rowBox: { color: ['#ff2020', '#22d3ee'] }, pad: [0.12, 0.3] },
  cc_lirik_lembut:  { label: 'Lirik lembut',  font: 'Inter SOCL Bold', px: 92, color: '#ffffff', next: '#ffffff', nextA: 0.6, past: '#ffffff', pastA: 0.95, current: { color: '#ffffff' }, maxRows: 3, gapY: 0.25 },
  cc_dialog_ikon:   { label: 'Dialog ikon',   font: 'Sour Gummy SOCL Bold', px: 80, color: '#ffffff', stroke: [10, '#000000'], current: { color: '#00ff6e' }, maxRows: 3, align: 'left', maxW: 760, track: 1 },
  cc_komik_kuning:  { label: 'Komik kuning',  font: 'Bangers', px: 140, case: 'upper', color: '#ffffff', stroke: [10, '#000000'], shadow: [6, '#000000'], current: { color: '#ffe600', pop: 40, scale: 108 }, maxRows: 2, gapY: 0.12, gapX: 8 },
  cc_berita_kilat:  { label: 'Berita kilat',  font: 'Poppins Bold', px: 80, case: 'upper', color: '#ffffff', maxRows: 3, rowBox: { color: '#ef4444' }, pad: [0.12, 0.3], gapY: 0.18 },
  cc_kedip_kaca:    { label: 'Kedip kaca',    font: 'Noto Sans SOCL Medium', px: 82, color: '#ffffff', nextA: 0.9, blur: 1.2, flicker: true, scaleX: 87.5, maxRows: 3, track: 1 },
  cc_gamer_ungu:    { label: 'Gamer ungu',    font: 'Luckiest Guy', px: 118, case: 'upper', color: '#c045ff', stroke: [9, '#000000'], current: { color: '#80ef80', pop: 115 }, maxRows: 2, gapY: 0.12 },
  cc_viral_lila:    { label: 'Viral lila',    font: 'Bangers', px: 120, case: 'upper', color: '#b286ff', stroke: [9, '#000000'], current: { color: '#ffffff', pop: 115 }, maxRows: 2, gapY: 0.12, gapX: 8 },
  cc_siaga_hijau:   { label: 'Siaga hijau',   font: 'Inter SOCL Bold', px: 80, color: '#000000', rot: -8, maxRows: 2, pageBox: { color: '#2cff05', pop: true }, pad: [0.35, 0.4], gapY: 0.2 },
  cc_serif_kilat:   { label: 'Serif kilat',   font: 'DM Serif Text', px: 150, color: '#ffffff', reveal: 'single', shadow: [3, '#00000099'], current: { color: '#ffffff', pop: 130 } },
  cc_mesin_ketik:   { label: 'Mesin ketik',   font: 'Noto Sans SOCL Medium', px: 64, color: '#ffffff', reveal: 'type', maxRows: 3, pageBox: { color: '#000000' }, pad: [0.4, 0.45], gapY: 0.35, track: 2 },
  cc_gelembung:     { label: 'Gelembung chat', font: 'Noto Sans SOCL Medium', px: 66, color: '#ffffff', wordsPerRow: 5, maxRows: 2, pageBox: { color: '#0183f7', bubble: true, radius: 0.55, pop: true }, pad: [0.45, 0.7], gapY: 0.1 },
  cc_tegas_besar:   { label: 'Tegas besar',   font: 'Inter SOCL Black', px: 96, case: 'upper', color: '#ffffff', stroke: [6, '#000000'], fill: true, maxRows: 3, gapY: 0.06, lh: 1.05 },
  cc_tokoh_utama:   { label: 'Tokoh utama',   font: 'DM Serif Text', px: 104, color: '#ffd606', maxRows: 4, lh: 1.05, track: -0.25 },
  cc_tanpa_konteks: { label: 'Tanpa konteks', font: 'Inter SOCL Bold', px: 92, case: 'lower', color: '#ffffff', wordsPerRow: 1, maxRows: 6, reveal: 'build', shadow: [5, '#00000088'], lh: 1.05, track: 1 },
  cc_mint_pop:      { label: 'Mint pop',      font: 'Staatliches', px: 136, case: 'upper', color: '#76f9d2', next: '#fffb91', past: '#76f9d2', current: { color: '#045b41', box: { color: '#ffffff', radius: 0.18 } }, maxRows: 2, gapY: 0.12, shadow: [5, '#00000066'], pad: [0.05, 0.14], gapX: 4 },
  cc_presentasi:    { label: 'Presentasi',    font: 'Poppins Bold', px: 82, case: 'upper', color: '#000000', wordsPerRow: 3, maxRows: 3, rowBox: { color: '#ffffff' }, pad: [0.1, 0.22], gapY: 0.3 },
  cc_tinju_kuning:  { label: 'Tinju kuning',  font: 'Poppins Bold', px: 98, case: 'upper', color: '#ffffff', stroke: [8, '#000000'], shadow: [5, '#000000'], current: { color: '#ffe600' }, maxRows: 2, gapY: 0.12 },
  cc_geser_lembut:  { label: 'Geser lembut',  font: 'Inter SOCL Bold', px: 92, color: '#ffffff', next: '#ffffff', nextA: 0.45, current: { color: '#fff3b0', glow: '#ffcc33' }, maxRows: 3, gapY: 0.4 },
  cc_siaran_ungu:   { label: 'Siaran ungu',   font: 'Inter SOCL Bold', px: 84, color: '#ffffff', wordBox: { color: '#9147ff' }, maxRows: 2, gapY: 0.12, pad: [0.16, 0.08], gapX: 2, track: 1 },
};
Object.keys(CC).forEach((id) => { TEMPLATES[id] = (text, o) => ccBuild(text, o, CC[id]); });
const CC_LIST = Object.keys(CC).map((id) => ({ id, label: CC[id].label }));
// [PRESET-CATALOG] A "Gaya kata" spec delivered as data (validated in the main
// process first). Its face must already have a width table, or preview and
// burn could lay it out differently. Built-in ids are never replaced.
function registerCaptionTemplate(id, label, spec) {
  if (!/^cc_[a-z0-9_]+$/.test(String(id)) || TEMPLATES[id] || !spec || !KINETIC_FONTS.includes(spec.font)) return false;
  CC[id] = Object.assign({ label }, spec);
  TEMPLATES[id] = (text, o) => ccBuild(text, o, CC[id]);
  CC_LIST.push({ id, label, remote: true });
  return true;
}

// Every face a template can use — the preview waits for these before laying
// out, or canvas would measure a fallback font.
const KINETIC_FONTS = ['CooperBlkBT-Regular', 'Anton', 'Bootzy TM', 'Liberation Sans Narrow', 'Open Sauce Two Bold', 'Open Sauce Two Bold Italic', 'Open Sauce Two ExtraBold Italic', 'Poppins Bold', 'Poppins Regular', 'Helvetica Neue Bold', 'Helvetica Neue Roman', 'Helvetica Neue Regular', 'Helvetica Neue Light', 'Helvetica Neue Medium', 'Inter Bold', 'Inter Regular', 'Inter SemiBold', 'Inter Medium', 'Playfair Display Italic', 'Corinthia', 'Brittany Signature', 'PT Serif Italic', 'Instrument Serif Italic', 'Georgia', 'Bebas Neue', 'Playfair Display Regular', 'Helvetica Neue Heavy', 'Inter Light', 'Inter SOCL Bold', 'Inter SOCL Black', 'Sour Gummy SOCL Bold', 'Noto Sans SOCL Medium', 'Bangers', 'Luckiest Guy', 'Staatliches', 'DM Serif Text', 'Times New Roman MT Condensed', "Editor'sNote-Semibold", "Editor'sNote-Medium", "Editor'sNote-MediumItalic", 'Open Sauce Two ExtraBold', 'Times New Roman', 'Times New Roman Italic', 'SF Pro Display Regular', 'SF Pro Display SemiBold', 'SF Pro Display Bold', 'Alex Brush', 'Antonio', 'Instrument Serif Regular'];

const TEMPLATE_LIST = [
  { id: 'stiker_pop', label: 'Stiker pop' },
  { id: 'riot', label: 'Riot' },
  { id: 'lakban', label: 'Lakban' },
  { id: 'sorotan', label: 'Sorotan' },
  { id: 'kertas_sobek', label: 'Kertas sobek' },
  { id: 'mask_naik', label: 'Mask naik' },
  { id: 'fokus_blur', label: 'Fokus blur' },
];

function layout(templateId, text, opts = {}) {
  const fn = TEMPLATES[templateId];
  if (!fn || !String(text || '').trim()) return { elements: [], box: null };
  return fn(String(text).trim(), Object.assign({ cx: 540, cy: 760 }, opts));
}

// Resolve the full state (sx, sy, rot, a, x, y, blur, clip) at key i by carrying
// values forward — keys only list what changes.
function resolvedKeys(el) {
  const base = { sx: 100, sy: 100, rot: el.rot || 0, a: 1, x: el.x, y: el.y, blur: 0, clip: null };
  const out = [];
  let cur = Object.assign({}, base);
  (el.keys || []).forEach((k) => { cur = Object.assign({}, cur, k); out.push(cur); });
  if (!out.length) out.push(Object.assign({ t: 0 }, base));
  return out;
}

// [KINETIC-EXTENT] The element's true vertical footprint over the whole
// window: the union of every keyed state in which it is VISIBLE (a > 0),
// with its scale and rotation applied. Placement reads this instead of
// guessing from the ASS tags — the guess took the drop-in start position, the
// 170% pop and the ticker as if they were all on screen together and called a
// 600 px lockup 1130 px tall, so long hooks were skipped as "no room".
function visibleExtent(el) {
  const w = el.kind === 'shape' ? el.w : widthPx(el.text, el.font, el.px, el.italic);
  const h = el.kind === 'shape' ? el.h : el.px * 1.0;
  let top = Infinity, bot = -Infinity;
  for (const k of resolvedKeys(el)) {
    if (!(k.a > 0)) continue;
    const r = Math.abs((k.rot || 0) * Math.PI / 180);
    const sx = (k.sx || 100) / 100, sy = (k.sy || 100) / 100;
    const half = (Math.abs(Math.sin(r)) * w * sx + Math.cos(r) * h * sy) / 2 + (el.ow || 0) + (el.glow ? 10 : 0);
    top = Math.min(top, k.y - half); bot = Math.max(bot, k.y + half + (el.sd || 0));
  }
  return Number.isFinite(top) ? { top, bottom: bot } : null;
}

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const ss = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss + (cs === 100 ? 1 : 0)).padStart(2, '0')}.${String(cs === 100 ? 0 : cs).padStart(2, '0')}`;
}

// ASS writer. `scale` maps canonical 1080x1920 to PlayRes (sx, sy, ox, oy).
// libass finds these CFF .otf files by PostScript name only; the spaced full name ("Helvetica Neue Bold")
// silently falls back to Arial (checked with a real burn). Preview/measuring keep the friendly name.
const ASS_FONT_ALIAS = {
  'Helvetica Neue Bold': 'HelveticaNeue-Bold', 'Helvetica Neue Roman': 'HelveticaNeue-Roman',
  'Helvetica Neue Regular': 'HelveticaNeue-Roman', 'Helvetica Neue Light': 'HelveticaNeue-Light', 'Helvetica Neue Medium': 'HelveticaNeue-Medium',
  // Inter ships as 'Inter 18pt <Weight>' (static optical-size files); the burn finds it by that full name
  'Inter Bold': 'Inter 18pt Bold', 'Inter Regular': 'Inter 18pt Regular', 'Inter SemiBold': 'Inter 18pt SemiBold',
  // user-supplied faces: CFF .otf by PostScript name, TTF by full name
  'SF Pro Display Regular': 'SFProDisplay-Regular', 'SF Pro Display SemiBold': 'SFProDisplay-Semibold', 'SF Pro Display Bold': 'SFProDisplay-Bold', 'Alex Brush': 'Alex Brush Regular', 'Antonio': 'Antonio Regular', 'Instrument Serif Regular': 'Instrument Serif Regular',
  'Helvetica Neue Heavy': 'HelveticaNeueLTStd-Hv', 'Snell Roundhand': 'Snell Roundhand Bold Script', 'Bebas Neue': 'Bebas Neue Regular',
};
const assFontName = (f) => ASS_FONT_ALIAS[f] || f;
function toAssEvents(layoutRes, { start, end, map = {}, fadeOutMs = 220 }) {
  const lines = [];
  const durMs = Math.round((end - start) * 1000);
  const S = map.s || 1;
  // Uniform scale S about the anchor (cx,cy) -> (cxOut,cyOut).
  const cx = map.cx || 0, cy = map.cy || 0;
  const cxo = map.cxOut != null ? map.cxOut : cx * S, cyo = map.cyOut != null ? map.cyOut : cy * S;
  const X = (x) => +(cxo + (x - cx) * S).toFixed(1);
  const Y = (y) => +(cyo + (y - cy) * S).toFixed(1);
  layoutRes.elements.forEach((el, idx) => {
    const K = resolvedKeys(el);
    const k0 = K[0];
    const makeTags = (glow) => {
    const tags = [];
    tags.push('\\an5');
    // Position: one \move between the first and last key that changes x/y.
    const mv = K.filter((k, i) => i === 0 || k.x !== K[i - 1].x || k.y !== K[i - 1].y);
    if (mv.length > 1) {
      const a = mv[0], b = mv[mv.length - 1];
      const tA = K[K.indexOf(b) - 1] ? K[K.indexOf(b) - 1].t : 0;
      tags.push(`\\move(${X(a.x)},${Y(a.y)},${X(b.x)},${Y(b.y)},${Math.round(tA)},${Math.round(b.t)})`);
    } else tags.push(`\\pos(${X(k0.x)},${Y(k0.y)})`);
    tags.push(`\\frz${(-k0.rot).toFixed(1)}`);
    tags.push(`\\fscx${k0.sx}\\fscy${k0.sy}`);
    // Glow pass: fill and shadow hidden, the outline IS the halo.
    // [GLOW-VISIBLE] Two glow passes: a tight bright core + a wide soft halo
    // (one 10px outline under a 12px blur read as barely-there on video).
    // [GLOW-READ] A third, DARK pass under both: a coloured glow on a light
    // background (white shirt, grey wall) washed the letter edges away. The
    // dark halo keeps every letter crisp; the coloured glow still shows on top.
    // Bright glows (white Halo, lime Neon) on a light shirt / hijab vanish:
    // the brighter the glow (or the text, for shade-only words), the darker
    // and wider the shade, and the softer the wide halo.
    const lit = glowLum(el.glow || el.color);
    const GL = glow === 'tight' ? { op: lit > 0.7 ? 0.85 : 1, bord: 3, blur: 3 }
      : glow === 'shade' ? (lit > 0.55 ? { op: 0.9, bord: 10, blur: 11 } : { op: 0.75, bord: 8, blur: 12 })
      : { op: lit > 0.7 ? 0.5 : lit > 0.55 ? 0.62 : 0.75, bord: 14, blur: 16 };
    const A = (a) => (glow ? `\\1a&HFF&\\3a${alphaHex(a * GL.op)}\\4a&HFF&`
      : el.fillA === 0 ? `\\1a&HFF&\\3a${alphaHex(a)}\\4a${alphaHex(a)}` : `\\alpha${alphaHex(a)}`);
    const B = (v) => (glow ? GL.blur * S + v : v);
    tags.push(A(k0.a));
    if (k0.blur || glow) tags.push(`\\blur${B(k0.blur).toFixed(1)}`);
    const bord = glow ? GL.bord * S : (el.ow || 0) * S;
    tags.push(`\\bord${bord.toFixed(1)}\\3c${hexToAss(glow === 'shade' ? '#000000' : glow ? el.glow : (el.oc || '#000000'))}`);
    // [NO-SHADOW] no black shadow / dark shade behind caption-template words (KIN_SHADOW is off)
    const shad = KIN_SHADOW ? (el.sd || 0) * S : 0;
    tags.push(`\\shad${shad.toFixed(1)}\\4c${hexToAss(el.sc || '#000000')}`);
    if (KIN_SHADOW && !glow && (el.shadowSoft || el.glowSoft)) tags.push(`\\shad${(4 * S).toFixed(1)}\\4a&H70&`);
    tags.push(`\\1c${hexToAss(el.color)}`);
    const clipTag = (c, k) => {
      // clip is element-local (top-left of the element's box); convert to frame.
      const w = el.kind === 'shape' ? el.w : widthPx(el.text, el.font, el.px);
      const h = el.kind === 'shape' ? el.h : el.px * 1.3;
      const x0 = k.x - w / 2, y0 = k.y - h / 2;
      return `\\clip(${X(x0 + c[0])},${Y(y0 + c[1])},${X(x0 + c[2])},${Y(y0 + c[3])})`;
    };
    if (el.clipAbs) tags.push(`\\clip(${X(el.clipAbs[0])},${Y(el.clipAbs[1])},${X(el.clipAbs[2])},${Y(el.clipAbs[3])})`);
    if (k0.clip) tags.push(clipTag(k0.clip, k0));
    for (let i = 1; i < K.length; i++) {
      const p = K[i - 1], k = K[i];
      const ch = [];
      if (k.sx !== p.sx) ch.push(`\\fscx${k.sx}`);
      if (k.sy !== p.sy) ch.push(`\\fscy${k.sy}`);
      if (k.rot !== p.rot) ch.push(`\\frz${(-k.rot).toFixed(1)}`);
      if (k.a !== p.a) ch.push(A(k.a));
      if (k.blur !== p.blur) ch.push(`\\blur${B(k.blur).toFixed(1)}`);
      if (k.clip && JSON.stringify(k.clip) !== JSON.stringify(p.clip)) ch.push(clipTag(k.clip, k));
      if (!ch.length) continue;
      const t1 = Math.round(p.t), t2 = Math.max(t1 + 1, Math.round(k.t));
      // Instant steps (1 ms) are plain switches; others ease out.
      tags.push(t2 - t1 <= 1 ? `\\t(${t1},${t2},${ch.join('')})` : `\\t(${t1},${t2},${EASE_OUT},${ch.join('')})`);
    }
    // Shared fade-out at the end of the title window.
    if (fadeOutMs > 0) tags.push(`\\t(${Math.max(0, durMs - fadeOutMs)},${durMs},${A(0)})`);
    let body;
    if (el.kind === 'shape') {
      body = `{\\p1}${scalePath(el.path, S)}{\\p0}`;
    } else {
      const fsz = Math.round(el.px * S * ((FM && FM.fontEmScale(assFontName(el.font), fontsDir(), false, !!el.italic)) || 1));
      // \\fsp0: buildAss stamps the caption style's tracking (\\fsp-4) on every
      // line; a kinetic layout already placed each glyph, so it must not apply.
      tags.unshift(`\\fn${assFontName(el.font)}\\fs${fsz}\\fsp${el.fsp ? (el.fsp * S).toFixed(2) : 0}${el.wB ? '\\b1' : '\\b0'}${(el.italic || el.wI) ? '\\i1' : '\\i0'}`);   // [CAP-FOKUS-TRACK] el.fsp
      body = String(el.text).replace(/\\/g, '＼').replace(/[{}]/g, '');
    }
    return { tags, body };
    };
    const { tags, body } = makeTags(false);
    // The settled footprint rides in the Name field (free text, ignored by
    // libass) as @top:bottom in output pixels, for hook placement.
    const ve = visibleExtent(el);
    const foot = ve ? `@${Y(ve.top).toFixed(0)}:${Y(ve.bottom).toFixed(0)}` : '';
    const base = `kinetic-${el.bleed ? 'bleed-' : ''}${idx}`;
    const name = `${base}${foot}`;
    // pass suffix BEFORE the @top:bottom footprint, which readers parse at the end
    if (KIN_SHADOW && (el.glow || el.shade) && el.kind === 'text') {
      const sh = makeTags('shade');
      lines.push(`Dialogue: 10,${fmtTime(start)},${fmtTime(end)},Default,${base}-glow-shade${foot},0,0,0,,{${sh.tags.join('')}}${sh.body}`);
    }
    if (el.glow && el.kind === 'text') {
      for (const pass of ['wide', 'tight']) {
        const g = makeTags(pass);
        lines.push(`Dialogue: 11,${fmtTime(start)},${fmtTime(end)},Default,${base}-glow-${pass}${foot},0,0,0,,{${g.tags.join('')}}${g.body}`);
      }
    }
    lines.push(`Dialogue: ${10 + (el.kind === 'text' ? 2 : 1)},${fmtTime(start)},${fmtTime(end)},Default,${name},0,0,0,,{${tags.join('')}}${body}`);
  });
  return lines;
}


// [KIN-WORD-STYLE] Per-word overrides (colour, font, bold, italic) for a caption template, shared by the preview (renderer.js)
// and the burn (pipeline buildAss) so both draw the same thing. `tokens` = [{text, style:{color,fn,b,i}}] of the cue.
// Words are matched by their letters only (case/punctuation ignored), in order, so a repeated word takes its own token.
// A template draws one element per word (some draw per letter; those are left alone). Changing a word's font keeps its
// WIDTH: the size is scaled by old/new advance width, so the lockup the template laid out does not collide.
function applyTokenStyles(L, tokens) {
  if (!L || !Array.isArray(L.elements) || !Array.isArray(tokens)) return L;
  const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const queues = Object.create(null);
  let any = false;
  for (const tk of tokens) {
    if (!tk || !tk.text) continue;
    const st = tk.style && typeof tk.style === 'object' ? tk.style : null;
    const has = !!(st && (st.color || st.fn || st.b != null || st.i));
    (queues[norm(tk.text)] = queues[norm(tk.text)] || []).push(has ? st : null);
    if (has) any = true;
  }
  if (!any) return L;
  const used = Object.create(null);
  const elements = L.elements.map((e) => {
    if (!e || e.kind === 'shape' || !e.text) return e;
    const key = norm(e.text);
    const q = queues[key];
    if (!key || !q) return e;
    const st = q[Math.min(used[key] || 0, q.length - 1)];
    used[key] = (used[key] || 0) + 1;
    if (!st) return e;
    const n = Object.assign({}, e);
    if (st.color) { n.color = st.color; n.oc = st.color; if (n.glow) n.glow = st.color; }
    if (st.fn && st.fn !== e.font) {
      const w0 = widthPx(e.text, e.font, e.px), w1 = widthPx(e.text, st.fn, e.px);
      n.font = st.fn;
      if (w0 > 0 && w1 > 0) n.px = e.px * Math.max(0.5, Math.min(1.6, w0 / w1));
    }
    if (st.i) n.wI = true;
    if (st.b != null) n.wB = st.b ? 1 : 0;
    return n;
  });
  return Object.assign({}, L, { elements });
}

function scalePath(path, s) {
  if (s === 1) return path;
  return path.replace(/-?\d+(\.\d+)?/g, (n) => (+n * s).toFixed(1));
}

// [NO-SHADOW] One switch for every caption template: false = no black drop shadow, soft shadow or dark shade
// behind the words, in the burn AND the previews (renderer.js reads KineticTitle.KIN_SHADOW). Coloured glow stays.
const KIN_SHADOW = false;
const api = { applyTokenStyles, KIN_SHADOW, glowLum, mixChunks, estChunks, rangeChunks, chunkRule, CHUNK_RULES, kinCapFadeMs, splitSub, visibleExtent, stateAt, CC_LIST, registerCaptionTemplate, TEMPLATES, TEMPLATE_LIST, CAPTION_LIST, keyIndex, wordTimes, layout, toAssEvents, resolvedKeys, widthPx, setFontsDir, rng, hexToAss, FONTS: KINETIC_FONTS, __test: { wrapWords, letterCentres, rotPt, fmtTime, scalePath, balancedLines } };
if (IS_NODE) module.exports = api; else root.KineticTitle = api;
})(typeof window !== 'undefined' ? window : globalThis);
