// app/src/edit-decision.js
// Pure logic for a clip's non-destructive edit decision: which ranges of the
// clip to keep (cut/split) and the editable framing keyframes seeded from the
// tracker's trackPlan. Loaded BOTH by the Electron renderer (script tag →
// window.EditDecision) and by node tests (require). Never touch the DOM here.
//
// Time axis: seconds relative to the clip start — the SAME axis trackPlan
// keyframes use — so nothing here ever needs clipStart.
(function (root) {
  'use strict';
  const MIN_RANGE = 0.30;   // shorter kept ranges are merged away
  const SNAP_TOL = 0.15;    // split points snap to a word edge within this
  const EPS = 1e-6;

  const r3 = v => +(+v).toFixed(3);
  const clamp01 = v => Math.max(0, Math.min(1, v));

  function fullDecision(clipDur) {
    return { v: 1, keep: [{ s: 0, e: r3(clipDur) }], framing: null };
  }

  // Sort, clamp to [0,clipDur], merge overlaps, drop ranges under MIN_RANGE.
  // Never returns an empty list: if everything would vanish, keep the longest.
  function normalizeKeep(keep, clipDur) {
    const rs = (keep || [])
      .map(r => ({ s: Math.max(0, +r.s), e: Math.min(clipDur, +r.e) }))
      .filter(r => r.e - r.s > EPS)
      .sort((a, b) => a.s - b.s);
    const merged = [];
    for (const r of rs) {
      const last = merged[merged.length - 1];
      if (last && r.s <= last.e + EPS) last.e = Math.max(last.e, r.e);
      else merged.push({ ...r });
    }
    const ok = merged.filter(r => r.e - r.s >= MIN_RANGE - EPS);
    if (ok.length) return ok.map(r => ({ s: r3(r.s), e: r3(r.e) }));
    if (!merged.length) return [{ s: 0, e: r3(clipDur) }];
    const longest = merged.reduce((a, b) => (b.e - b.s > a.e - a.s ? b : a));
    return [{ s: r3(longest.s), e: r3(longest.e) }];
  }

  // Nearest word start/end within SNAP_TOL, else t unchanged.
  function snapToWord(t, words) {
    let best = t, bestD = SNAP_TOL + EPS;
    for (const w of words || []) {
      for (const edge of [w.start, w.end]) {
        const d = Math.abs(edge - t);
        if (Number.isFinite(edge) && d < bestD) { best = edge; bestD = d; }
      }
    }
    return r3(best);
  }

  // Split the kept range containing t into two. No-op when t is outside every
  // range or either half would be shorter than MIN_RANGE.
  function splitAt(keep, t, words) {
    const at = snapToWord(t, words);
    const out = [];
    let did = false;
    for (const r of keep) {
      if (!did && at - r.s >= MIN_RANGE - EPS && r.e - at >= MIN_RANGE - EPS) {
        out.push({ s: r.s, e: at }, { s: at, e: r.e });
        did = true;
      } else out.push({ ...r });
    }
    return out;
  }

  // Remove the kept range at index i. Refuses to remove the last range.
  function removeRange(keep, i) {
    if (keep.length <= 1 || i < 0 || i >= keep.length) return keep.map(r => ({ ...r }));
    return keep.filter((_, j) => j !== i).map(r => ({ ...r }));
  }

  function outDuration(keep) {
    return r3(keep.reduce((a, r) => a + (r.e - r.s), 0));
  }

  // Kept ranges → the removed gaps as [a, b] pairs, the shape the render's
  // [CLIP-TIMELINE] stores as timeline.manualCuts.
  function keepToCuts(keep, clipDur) {
    const cuts = [];
    let cur = 0;
    for (const r of keep) {
      if (r.s > cur + EPS) cuts.push([r3(cur), r3(r.s)]);
      cur = Math.max(cur, r.e);
    }
    if (clipDur > cur + EPS) cuts.push([r3(cur), r3(clipDur)]);
    return cuts;
  }

  // Inverse of keepToCuts, for reopening a clip in the editor.
  function cutsToKeep(cuts, clipDur) {
    const keep = [];
    let cur = 0;
    for (const [a, b] of (cuts || []).slice().sort((p, q) => p[0] - q[0])) {
      if (a > cur + EPS) keep.push({ s: cur, e: Math.min(a, clipDur) });
      cur = Math.max(cur, b);
    }
    if (clipDur > cur + EPS) keep.push({ s: cur, e: clipDur });
    return normalizeKeep(keep, clipDur);
  }

  // Clip time → output time; null when t falls in a removed gap.
  function mapClipToOut(keep, t) {
    let acc = 0;
    for (const r of keep) {
      if (t >= r.s - EPS && t <= r.e + EPS) return r3(acc + Math.min(Math.max(t, r.s), r.e) - r.s);
      acc += r.e - r.s;
    }
    return null;
  }

  // Output time → clip time (clamped to the output duration).
  function mapOutToClip(keep, t) {
    let acc = 0;
    for (const r of keep) {
      const d = r.e - r.s;
      if (t <= acc + d + EPS) return r3(r.s + Math.max(0, t - acc));
      acc += d;
    }
    const last = keep[keep.length - 1];
    return last ? last.e : 0;
  }

  // Map a [start,end] interval onto the output. An interval that crosses a cut
  // is clamped to the kept range holding most of it; one entirely inside a gap
  // returns null (the item is dropped).
  function mapInterval(keep, start, end) {
    let best = null, bestLen = 0, acc = 0;
    for (const r of keep) {
      const s = Math.max(start, r.s), e = Math.min(end, r.e);
      if (e - s > bestLen + EPS) { bestLen = e - s; best = { start: r3(acc + s - r.s), end: r3(acc + e - r.s) }; }
      acc += r.e - r.s;
    }
    return best;
  }

  // Cues of shape { start, end, text, tokens:[{text,start,end}] }. Tokens
  // fully in a gap are dropped; the cue keeps only its surviving tokens.
  function remapCues(keep, cues) {
    const out = [];
    for (const c of cues || []) {
      const toks = Array.isArray(c.tokens) ? c.tokens : null;
      if (toks) {
        const kept = [];
        for (const tk of toks) {
          const m = mapInterval(keep, tk.start, tk.end);
          if (m) kept.push({ ...tk, start: m.start, end: m.end });
        }
        if (!kept.length) continue;
        out.push({ ...c, start: kept[0].start, end: kept[kept.length - 1].end,
          text: kept.map(k => k.text).join(' '), tokens: kept });
      } else {
        const m = mapInterval(keep, c.start, c.end);
        if (m) out.push({ ...c, start: m.start, end: m.end });
      }
    }
    return out;
  }

  // Generic timed items (titles, manual captions): { start, end, ... }.
  function remapTimed(keep, items) {
    const out = [];
    for (const it of items || []) {
      const m = mapInterval(keep, it.start, it.end);
      if (m) out.push({ ...it, start: m.start, end: m.end });
    }
    return out;
  }

  // Seed editable framing from a trackPlan. Every keyframe starts unlocked.
  function seedFraming(trackPlan) {
    const kfs = (trackPlan && Array.isArray(trackPlan.keyframes)) ? trackPlan.keyframes : [];
    return {
      source: 'trackPlan',
      keyframes: [...kfs].sort((a, b) => a.t - b.t).map(k => ({ ...k, locked: false })),
    };
  }

  // Re-run of the tracker: take the fresh keyframes but keep every locked
  // (user-edited) one, dropping fresh keyframes too close to a locked one.
  function mergeRetrack(framing, trackPlan, minGap = 0.25) {
    const locked = ((framing && framing.keyframes) || []).filter(k => k.locked);
    const fresh = seedFraming(trackPlan).keyframes
      .filter(k => locked.every(l => Math.abs(l.t - k.t) >= minGap));
    return { source: locked.length ? 'manual' : 'trackPlan',
      keyframes: [...fresh, ...locked].sort((a, b) => a.t - b.t) };
  }

  // Linear value of a single-target keyframe track at time t.
  function targetAt(kfs, t) {
    const singles = kfs.filter(k => k.target);
    if (!singles.length) return { x: 0.5, y: 0.5, scale: 1 };
    if (t <= singles[0].t) return { ...singles[0].target };
    for (let i = 0; i < singles.length - 1; i++) {
      const a = singles[i], b = singles[i + 1];
      if (t <= b.t) {
        const u = (b.t - a.t) > EPS ? (t - a.t) / (b.t - a.t) : 0;
        const lerp = k => (a.target[k] ?? 1) + ((b.target[k] ?? 1) - (a.target[k] ?? 1)) * u;
        return { x: clamp01(lerp('x')), y: clamp01(lerp('y')), scale: lerp('scale') };
      }
    }
    return { ...singles[singles.length - 1].target };
  }

  // Cut the framing track to the kept ranges and re-time it onto the output
  // axis. A synthetic keyframe is inserted at every range edge so the framing
  // never jumps at a join. Result is a trackPlan-shaped object for
  // track-plan.js buildSegmentJobs.
  function framingToOutPlan(keep, framing) {
    const kfs = ((framing && framing.keyframes) || []).slice().sort((a, b) => a.t - b.t);
    if (!kfs.length) return { keyframes: [] };
    const out = [];
    let acc = 0;
    for (const r of keep) {
      const inside = kfs.filter(k => k.t > r.s + EPS && k.t < r.e - EPS);
      const before = kfs.filter(k => k.t <= r.s + EPS).pop();
      const head = before && !before.target
        ? { ...before }                                   // split/grid: hold the panel layout
        : { mode: (before || kfs[0]).mode || 'single', target: targetAt(kfs, r.s) };
      const { locked: _l, ...h } = head;
      out.push({ ...h, t: r3(acc) });
      for (const k of inside) {
        const { locked: _l2, ...rest } = k;
        out.push({ ...rest, t: r3(acc + k.t - r.s) });
      }
      acc += r.e - r.s;
    }
    return { keyframes: out };
  }

  const api = {
    MIN_RANGE, SNAP_TOL, fullDecision, normalizeKeep, snapToWord, splitAt, removeRange,
    keepToCuts, cutsToKeep, outDuration, mapClipToOut, mapOutToClip, mapInterval, remapCues, remapTimed,
    seedFraming, mergeRetrack, targetAt, framingToOutPlan,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EditDecision = api;
})(typeof self !== 'undefined' ? self : this);
