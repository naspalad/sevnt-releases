// [TRACK-REFINE] Post-processes the tracker's keyframes in the app, so a framing
// fix reaches users without a new tracker bundle. Reported on a real clip: the
// opening 0.33 s was an empty centre crop of a wide shot, a 1-frame camera shot
// flashed a different crop, and the frame chased every small head movement.
'use strict';

const LEAD_SHOT_MAX = 1;      // s — a faceless opening shot this short is removed
const MICRO_SHOT_MAX = 0.25;  // s — a shot this short reads as a glitch, not a cut
const DEAD_ZONE = 0.02;       // of frame width — head movement the crop ignores
const SMOOTH_RADIUS = 0.5;    // s — each side of the moving average

// The tracker's "no face in this shot" framing.
function isFallback(kf) {
  const t = kf && kf.target;
  return !!t && t.x === 0.5 && t.y === 0.5 && t.scale === 0.9;
}

function shotsOf(kfs) {
  const shots = [];
  kfs.forEach((kf) => {
    if (!shots.length || kf.cut) shots.push([]);
    shots[shots.length - 1].push(kf);
  });
  return shots;
}

function smoothAxis(shot, axis) {
  let hold = shot[0].target[axis];
  const held = shot.map((kf) => {
    const d = kf.target[axis] - hold;
    if (Math.abs(d) > DEAD_ZONE) hold += d - Math.sign(d) * DEAD_ZONE;
    return hold;
  });
  return shot.map((kf, i) => {
    // Symmetric window, so a shot's edges stay put and nothing lags the speaker.
    const r = Math.min(SMOOTH_RADIUS, kf.t - shot[0].t, shot[shot.length - 1].t - kf.t);
    let sum = 0, n = 0;
    shot.forEach((o, j) => { if (Math.abs(o.t - kf.t) <= r) { sum += held[j]; n++; } });
    return n ? sum / n : held[i];
  });
}

// → { keyframes, leadCut } — leadCut is [0, end] of a faceless opening shot the
// render should drop, or null. Input is not mutated.
function refineTrackPlan(keyframes) {
  if (!Array.isArray(keyframes) || !keyframes.length) return { keyframes, leadCut: null };
  let shots = shotsOf(keyframes.map((kf) => (kf.target ? { ...kf, target: { ...kf.target } } : { ...kf })));
  let leadCut = null;
  if (shots.length > 1 && shots[0].every(isFallback) && shots[1][0].t <= LEAD_SHOT_MAX) {
    leadCut = [0, shots[1][0].t];
  }
  shots = shots.filter((shot, i) => {
    const next = shots[i + 1];
    return i === 0 || !next || next[0].t - shot[0].t >= MICRO_SHOT_MAX;
  });
  for (const shot of shots) {
    if (shot.length < 2 || !shot.every((kf) => kf.mode === 'single' && kf.target) || shot.every(isFallback)) continue;
    const xs = smoothAxis(shot, 'x');
    const ys = smoothAxis(shot, 'y');
    shot.forEach((kf, i) => { kf.target.x = +xs[i].toFixed(4); kf.target.y = +ys[i].toFixed(4); });
  }
  return { keyframes: shots.flat(), leadCut };
}

module.exports = { refineTrackPlan };
