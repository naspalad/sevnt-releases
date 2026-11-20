// Live framing: one shared way to SHOW a clip's current format + crop before it
// is rendered. The rendered/preview file a page plays may predate the chosen
// format or crop, so the page's own <video> stays in charge of audio, time and
// events while this puts a muted copy of the master source on top, framed with
// the same math Crop Studio's "Live output" uses. Dashboard, Editor and Crop
// then show the same picture.
(function (root) {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function hasManualFraming(clip) {
    return !!(clip.manualFrame || clip.cropAspect || clip.cropRect || (Array.isArray(clip.cropKF) && clip.cropKF.length));
  }

  // Cuts/teaser make a RENDERED file non-linear against the source timeline.
  function timelineEdits(clip) {
    const tl = clip.timeline;
    return !!(tl && ((tl.teaser && tl.teaser.end > tl.teaser.start) || (tl.manualCuts && tl.manualCuts.length) || (tl.cuts && tl.cuts.length)));
  }

  // [BLUR-CROP] The crop settings of a Blur clip, or null when the whole frame is used.
  const BLUR_T = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
  function blurCropOf(clip) {
    if (!clip) return null;
    if (clip.cropAspect === 'free') {
      const r = clip.cropRect;
      return r && r.w > 0 && r.h > 0 ? { aspect: 'free', rect: { x: r.x || 0, y: r.y || 0, w: r.w, h: r.h } } : null;
    }
    if (!BLUR_T[clip.cropAspect]) return null;
    return { aspect: clip.cropAspect, scale: clip.cropScale != null ? clamp(clip.cropScale, 0.3, 1) : 1,
      x: clamp((clip.cropX != null ? clip.cropX : 50) / 100, 0, 1), y: clamp((clip.cropY != null ? clip.cropY : 50) / 100, 0, 1) };
  }
  function blurKf(clip) {
    return (Array.isArray(clip.cropKF) ? clip.cropKF : [])
      .filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.x) && Number.isFinite(k.y))
      .sort((a, b) => a.t - b.t).map((k) => ({ t: k.t, x: k.x, y: k.y }));
  }
  // A short fingerprint of a Blur clip's crop ('' when it has none), used to know whether a file already carries it.
  function blurSig(clip) {
    const bc = blurCropOf(clip);
    if (!bc) return '';
    const r4 = (n) => Math.round((+n || 0) * 10000) / 10000;
    return JSON.stringify([bc.aspect, bc.aspect === 'free' ? [r4(bc.rect.x), r4(bc.rect.y), r4(bc.rect.w), r4(bc.rect.h)] : [r4(bc.scale), r4(bc.x), r4(bc.y)], blurKf(clip).map((k) => [r4(k.t), r4(k.x), r4(k.y)])]);
  }
  // The crop box as fractions of the source (same maths as blurRegionFilter() in the pipeline), at time t.
  function blurRegion(bc, vw, vh, pos) {
    if (bc.aspect === 'free') {
      const r = bc.rect;
      const rx = pos ? pos.x * (1 - r.w) : r.x, ry = pos ? pos.y * (1 - r.h) : r.y;
      return { x: clamp(rx, 0, 1 - r.w), y: clamp(ry, 0, 1 - r.h), w: r.w, h: r.h };
    }
    const T = BLUR_T[bc.aspect], a = vw / vh, sc = bc.scale || 1;
    const w = (a > T ? T / a : 1) * sc, h = (a > T ? 1 : a / T) * sc;
    const px = pos ? pos.x : bc.x, py = pos ? pos.y : bc.y;
    return { x: px * (1 - w), y: py * (1 - h), w, h };
  }

  // Decide whether the live layer should be shown and with which framing.
  //   out  = { format, ratio }  the clip's OUTPUT (format after crop aspect, w/h)
  //   opts = { kind: 'dashboard'|'editor', mainRatio }  mainRatio = loaded file's w/h (0 = unknown)
  function plan(clip, out, opts) {
    const off = (why) => ({ use: false, why });
    if (!clip || !out || !(out.ratio > 0)) return off('no-clip');
    if (!clip.srcVideo) return off('no-source');
    const mainRatio = (opts && opts.mainRatio) || 0;
    const mismatch = mainRatio > 0 && Math.abs(mainRatio - out.ratio) / out.ratio > 0.03;
    const start = Number.isFinite(clip.start) ? clip.start : 0;
    // Blur format: the whole picture stays in the middle, the empty space is the same picture blurred.
    // A file that is already 9:16 was rendered that way, so only a shape mismatch needs the live view.
    if (out.format === 'blur') {
      // [BLUR-CROP] A crop on a Blur clip picks which part of the source sits in the middle (and feeds the blurred
      // background); the 9:16 canvas stays. Until the bake that applies it has finished, draw it live.
      const bc = blurCropOf(clip);
      if (bc) {
        const kf = blurKf(clip);
        // The master source is decoded a second time while the live layer is on, which is heavy on a weak PC, so it is only
        // used while the file on screen does NOT carry the crop. The renderer stamps clip.frameSigFile / frameSigRaw with
        // blurSig(clip) when a bake succeeds (file = what the Dashboard plays, Raw = the clean plate the Editor plays).
        const sig = blurSig(clip);
        const editor = ((opts && opts.kind) || 'dashboard') === 'editor';
        const stamp = editor ? clip.frameSigRaw : clip.frameSigFile;
        const baked = editor ? (stamp === sig && !clip.editPlate) : (stamp === sig || (stamp === undefined && !clip.previewOnly));
        if (!mismatch && !clip.framePending && baked) return off('file-matches');
        return { use: true, mode: 'blur', start, x: 0.5, y: 0.5, scale: 1, kf, bc };
      }
      if (!mismatch) return off('file-matches');
      return { use: true, mode: 'blur', start, x: 0.5, y: 0.5, scale: 1, kf: [] };
    }
    if (clip.splitCrop || clip.splitPending) return off('split');        // composite of two boxes
    const kind = (opts && opts.kind) || 'dashboard';
    if (clip.cropAspect === 'free') {
      // The rendered file is the dragged rectangle at its own ratio, fitted whole into the frame.
      // The Editor plays the clean plate, so it must draw that rectangle itself.
      const r = clip.cropRect;
      if (kind === 'editor' && r && r.w > 0 && r.h > 0) {
        const kf = (Array.isArray(clip.cropKF) ? clip.cropKF : [])
          .filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.x) && Number.isFinite(k.y))
          .sort((a, b) => a.t - b.t).map((k) => ({ t: k.t, x: k.x, y: k.y }));
        return { use: true, mode: 'rect', start, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, kf, x: 0.5, y: 0.5, scale: 1 };
      }
      return off('free');
    }
    if (kind === 'dashboard') {
      // A burned file carries captions/titles/watermark/effects for the framing it was rendered with.
      // It is only re-framed live when the picture is the wrong shape or a new crop is still being baked.
      const burned = clip.subsBurned || clip.titlesBurned || clip.fxBurned || clip.watermarkBurnedSnapshot;
      if (burned && !mismatch && !clip.framePending && !(opts && opts.forceClean)) return off('burned');
      if (!clip.previewOnly && timelineEdits(clip)) return off('non-linear');
    }
    // Smart face tracking is baked into the Dashboard's rendered file, but the Editor plays the clean
    // plate (centred). Re-create the tracked camera path live so both show the same face position.
    let trackKf = null;
    const forced = !!(opts && opts.forceClean);
    if ((kind === 'editor' || forced) && !hasManualFraming(clip) && clip.trackPlan && Array.isArray(clip.trackPlan.keyframes)) {
      const kfs = clip.trackPlan.keyframes;
      if (kfs.length && kfs.every((k) => k && k.mode !== 'split' && k.mode !== 'grid' && k.target && Number.isFinite(k.t))) {
        trackKf = kfs.map((k) => ({ t: k.t, x: clamp(Number(k.target.x) || 0, 0, 1), y: clamp(Number(k.target.y) || 0, 0, 1) }));
      }
    }
    if (!hasManualFraming(clip) && !mismatch && !trackKf && !forced) return off('file-matches');
    if (trackKf) {
      const sc = Number(clip.trackPlan.keyframes[0].target.scale);
      return { use: true, start, x: trackKf[0].x, y: trackKf[0].y, scale: Number.isFinite(sc) ? clamp(sc, 0.3, 1) : 1, kf: trackKf.sort((a, b) => a.t - b.t) };
    }
    const kf = (Array.isArray(clip.cropKF) ? clip.cropKF : [])
      .filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.x) && Number.isFinite(k.y))
      .sort((a, b) => a.t - b.t)
      .map((k) => ({ t: k.t, x: k.x, y: k.y }));
    return {
      use: true,
      start,
      x: clamp((clip.cropX != null ? clip.cropX : 50) / 100, 0, 1),
      y: clamp((clip.cropY != null ? clip.cropY : 50) / 100, 0, 1),
      scale: clip.cropScale != null ? clamp(clip.cropScale, 0.3, 1) : 1,
      kf,
    };
  }

  // Keyframes hold (step) at the latest one — same as Crop Studio and the render.
  function positionAt(p, t) {
    if (!p.kf.length) return { x: p.x, y: p.y };
    let k = p.kf[0];
    for (let i = 0; i < p.kf.length; i++) { if (t >= p.kf[i].t) k = p.kf[i]; else break; }
    return { x: k.x, y: k.y };
  }

  // Same CSS Crop Studio puts on its output video: object-fit:cover anchored at
  // the crop position, zoomed by 1/scale around that point.
  function frameStyle(p, t) {
    const pos = positionAt(p, t);
    const ox = (pos.x * 100).toFixed(1) + '%';
    const oy = (pos.y * 100).toFixed(1) + '%';
    return {
      objectPosition: ox + ' ' + oy,
      transformOrigin: ox + ' ' + oy,
      transform: p.scale < 1 ? 'scale(' + (1 / p.scale).toFixed(3) + ')' : '',
    };
  }

  function sameFile(a, b) {
    const norm = (u) => { try { return decodeURIComponent(String(u || '').split('?')[0]).toLowerCase(); } catch { return String(u || '').split('?')[0].toLowerCase(); } };
    return !!a && !!b && norm(a) === norm(b);
  }

  // cfg: { host, main, getClip, getOutput(clip)->{format,ratio}, toURL(path), enabled?(), before? }
  function attach(cfg) {
    const { host, main } = cfg;
    const live = document.createElement('video');
    live.className = 'live-frame-video';
    live.muted = true;
    live.defaultMuted = true;
    live.playsInline = true;
    live.preload = 'auto';
    live.setAttribute('aria-hidden', 'true');
    live.tabIndex = -1;
    if (cfg.before && cfg.before.parentNode === host) host.insertBefore(live, cfg.before);
    else if (main.nextSibling && main.parentNode === host) host.insertBefore(live, main.nextSibling);
    else host.appendChild(live);

    const note = document.createElement('div');
    note.className = 'live-frame-note';
    note.hidden = true;
    host.appendChild(note);
    function setNote(t) { note.textContent = t || ''; note.hidden = !t; }

    let blurOn = false;
    let lastKey = '';
    let current = null;      // active plan
    let url = '';            // source currently loaded into `live`
    let failedUrl = '';
    let ready = false;
    let raf = 0;

    const alive = () => live.isConnected && main.isConnected;
    const masterTime = () => (current ? current.start : 0) + (main.currentTime || 0);

    function hide(why) {
      setNote(why || '');
      if (blurOn) setBlurLook(false);
      if (rectOn) setRectLook(false);
      const wasLive = !!current;
      current = null;
      ready = false;
      if (wasLive && cfg.onChange) { try { cfg.onChange(); } catch {} }
      live.style.visibility = 'hidden';
      if (url) {
        url = '';
        try { live.pause(); } catch {}
        try { live.removeAttribute('src'); live.load(); } catch {}
      }
    }

    // Blur background: a tiny canvas (cheap to blur, ~10 fps) behind the picture, instead of
    // blurring a full-size video every frame.
    let bg = null, bgLast = 0;
    function drawBg(force) {
      if (!bg || !current || current.mode !== 'blur') return;
      const now = performance.now();
      if (!force && now - bgLast < 100) return;
      bgLast = now;
      const src = ready && live.videoWidth ? live : main;
      const vw = src.videoWidth, vh = src.videoHeight;
      const W = host.clientWidth || 1, H = host.clientHeight || 1;
      if (!vw || !vh) return;
      const cw = 48, ch = Math.max(8, Math.round(48 * H / W));
      if (bg.width !== cw || bg.height !== ch) { bg.width = cw; bg.height = ch; }
      if (current.bc) {
        // [BLUR-CROP] the blurred background comes from the cropped part too (cover-fitted)
        const g = blurRegion(current.bc, vw, vh, current.kf && current.kf.length ? positionAt(current, main.currentTime || 0) : null);
        const sx = g.x * vw, sy = g.y * vh, sw = g.w * vw, sh = g.h * vh;
        const k2 = Math.max(cw / sw, ch / sh), dw2 = sw * k2, dh2 = sh * k2;
        try { bg.getContext('2d').drawImage(src, sx, sy, sw, sh, (cw - dw2) / 2, (ch - dh2) / 2, dw2, dh2); } catch {}
        return;
      }
      const k = Math.max(cw / vw, ch / vh), dw = vw * k, dh = vh * k;
      try { bg.getContext('2d').drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh); } catch {}
    }
    function setBlurLook(on) {
      if (on) {
        if (!bg) { bg = document.createElement('canvas'); bg.className = 'live-blur-bg'; host.insertBefore(bg, host.firstChild); }
        bg.hidden = false;
        main.style.setProperty('visibility', 'hidden', 'important');
        live.classList.add('is-blur');
        live.style.setProperty('object-fit', 'contain', 'important');
        blurOn = true;
        drawBg(true);
      } else {
        if (bg) bg.hidden = true;
        main.style.removeProperty('visibility');
        live.classList.remove('is-blur');
        live.style.removeProperty('object-fit');
        blurOn = false;
      }
    }
    // Free crop: show only the dragged rectangle, fitted whole inside the frame (like the rendered file).
    let rectOn = false;
    function setRectLook(on) {
      if (on === rectOn) return;
      rectOn = on;
      if (on) main.style.setProperty('visibility', 'hidden', 'important');
      else {
        main.style.removeProperty('visibility');
        ['width', 'height', 'left', 'top', 'right', 'bottom', 'inset', 'object-fit', 'clip-path'].forEach((p) => live.style.removeProperty(p));
        lastKey = '';
      }
    }
    function paintRect() {
      const vw = live.videoWidth, vh = live.videoHeight;
      const W = host.clientWidth, H = host.clientHeight;
      if (!vw || !vh || !W || !H) return;
      const r = current.rect;
      let rx = r.x, ry = r.y;
      if (current.kf.length) {
        const pos = positionAt(current, main.currentTime || 0);
        rx = pos.x * (1 - r.w); ry = pos.y * (1 - r.h);
      }
      rx = clamp(rx, 0, 1 - r.w); ry = clamp(ry, 0, 1 - r.h);
      const rr = (r.w * vw) / (r.h * vh);
      let bw = W, bh = W / rr;
      if (bh > H) { bh = H; bw = H * rr; }
      const key = ['rect', W, H, rx.toFixed(4), ry.toFixed(4), r.w, r.h, vw, vh].join('|');
      setRectLook(true);
      if (key === lastKey) return;
      lastKey = key;
      const fw = bw / r.w, fh = bh / r.h;
      const left = (W - bw) / 2 - rx * fw, top = (H - bh) / 2 - ry * fh;
      const set = (p, v) => live.style.setProperty(p, v, 'important');
      set('inset', 'auto');
      set('left', left.toFixed(2) + 'px'); set('top', top.toFixed(2) + 'px');
      set('width', fw.toFixed(2) + 'px'); set('height', fh.toFixed(2) + 'px');
      set('object-fit', 'fill');
      set('clip-path', 'inset(' + (ry * 100).toFixed(3) + '% ' + ((1 - rx - r.w) * 100).toFixed(3) + '% ' + ((1 - ry - r.h) * 100).toFixed(3) + '% ' + (rx * 100).toFixed(3) + '%)');
      live.style.objectPosition = '50% 50%'; live.style.transform = '';
    }
    function paintBlurCrop() {
      const vw = live.videoWidth, vh = live.videoHeight;
      const W = host.clientWidth, H = host.clientHeight;
      if (!vw || !vh || !W || !H) return;
      drawBg();
      const g = blurRegion(current.bc, vw, vh, current.kf && current.kf.length ? positionAt(current, main.currentTime || 0) : null);
      const rr = (g.w * vw) / (g.h * vh);
      let bw = W, bh = W / rr;
      if (bh > H) { bh = H; bw = H * rr; }
      const key = ['bcrop', W, H, g.x.toFixed(4), g.y.toFixed(4), g.w.toFixed(4), g.h.toFixed(4), vw, vh].join('|');
      if (key === lastKey) return;
      lastKey = key;
      setRectLook(true);
      main.style.setProperty('visibility', 'hidden', 'important');
      const fw = bw / g.w, fh = bh / g.h;
      const left = (W - bw) / 2 - g.x * fw, top = (H - bh) / 2 - g.y * fh;
      const set = (p, v) => live.style.setProperty(p, v, 'important');
      set('inset', 'auto');
      set('left', left.toFixed(2) + 'px'); set('top', top.toFixed(2) + 'px');
      set('width', fw.toFixed(2) + 'px'); set('height', fh.toFixed(2) + 'px');
      set('object-fit', 'fill');
      set('clip-path', 'inset(' + (g.y * 100).toFixed(3) + '% ' + ((1 - g.x - g.w) * 100).toFixed(3) + '% ' + ((1 - g.y - g.h) * 100).toFixed(3) + '% ' + (g.x * 100).toFixed(3) + '%)');
      live.style.objectPosition = '50% 50%'; live.style.transform = '';
    }
    function paintFrame() {
      if (!current) return;
      if (current.mode === 'rect') {
        if (blurOn) setBlurLook(false);
        paintRect();
        return;
      }
      if (current.mode === 'blur' && current.bc) {
        // [BLUR-CROP] the cropped part fitted whole inside the 9:16 frame, over the blurred copy of the same part
        if (ready && !blurOn) setBlurLook(true);
        paintBlurCrop();
        return;
      }
      if (rectOn) { setRectLook(false); if (blurOn) main.style.setProperty('visibility', 'hidden', 'important'); }
      if (current.mode === 'blur') {
        if (ready && !blurOn) setBlurLook(true);
        lastKey = '';
        drawBg();
        live.style.objectPosition = '50% 50%'; live.style.transformOrigin = '50% 50%'; live.style.transform = '';
        return;
      }
      if (blurOn) setBlurLook(false);
      const s = frameStyle(current, main.currentTime || 0);
      const key = s.objectPosition + '|' + s.transform;
      if (key === lastKey) return;          // only touch style when the crop actually moved
      lastKey = key;
      live.style.objectPosition = s.objectPosition;
      live.style.transformOrigin = s.transformOrigin;
      live.style.transform = s.transform;
    }

    function syncTime(force) {
      if (!current || !ready) return;
      const target = masterTime();
      if (force || Math.abs(live.currentTime - target) > 0.25) {
        try { live.currentTime = target; } catch {}
      }
    }

    function stopTick() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    function tick() {
      raf = 0;
      if (!alive() || !current) return;
      paintFrame();
      if (ready && !main.paused && !main.ended) {
        const err = live.currentTime - masterTime();   // > 0: the copy is ahead
        if (Math.abs(err) > 0.25) syncTime(true);
        else {
          // Nudge the speed only when really drifting; changing it every frame makes the decoder work harder.
          const base = main.playbackRate || 1;
          const want = Math.abs(err) > 0.06 ? clamp(base * (1 - clamp(err, -0.2, 0.2) * 0.5), 0.5, 2) : base;
          if (Math.abs(live.playbackRate - want) > 0.02) live.playbackRate = want;
        }
        if (live.paused) { const p = live.play(); if (p && p.catch) p.catch(() => {}); }
        raf = requestAnimationFrame(tick);
      }
    }

    function refresh() {
      if (!alive()) return;
      const clip = cfg.getClip();
      const enabled = !cfg.enabled || cfg.enabled();
      if (!clip || !enabled || !main.currentSrc || main.hidden) { stopTick(); hide(); return; }
      const out = cfg.getOutput(clip);
      const mainRatio = main.videoWidth > 0 && main.videoHeight > 0 ? main.videoWidth / main.videoHeight : 0;
      const p = plan(clip, out, { kind: cfg.kind, mainRatio, forceClean: !!(cfg.forceClean && cfg.forceClean(clip)) });
      if (!p.use) {
        stopTick();
        const shaped = mainRatio > 0 && Math.abs(mainRatio - out.ratio) / out.ratio > 0.03;
        hide(shaped && p.why === 'no-source' ? 'Video sumber tidak ada — preview memakai file klip lama' : '');
        return;
      }
      const next = cfg.toURL(clip.srcVideo);
      // The page already plays the master itself (clip file missing): nothing to layer.
      if (!next || next === failedUrl || sameFile(main.currentSrc, next)) { stopTick(); hide(next && next === failedUrl ? 'Video sumber tidak bisa diputar — preview memakai file klip lama' : ''); return; }
      current = p;
      if (url !== next) {
        url = next;
        ready = false;
        live.style.visibility = 'hidden';
        live.src = next;
        try { live.load(); } catch {}
      } else {
        paintFrame();
        syncTime(false);   // refresh also runs on every resize; only re-seek when actually out of step
      }
      if (ready && !main.paused) { stopTick(); raf = requestAnimationFrame(tick); }
    }

    live.addEventListener('loadedmetadata', () => {
      if (!current) return;
      try { live.currentTime = masterTime(); } catch {}
    });
    live.addEventListener('seeked', () => {
      if (!current) return;
      if (!ready) {
        // A seek that did not land (source not seekable yet) must not reveal the wrong frame.
        if (Math.abs(live.currentTime - masterTime()) > 0.5) { try { live.currentTime = masterTime(); } catch {} return; }
        ready = true;
        paintFrame();
        live.style.visibility = 'visible';
        if (cfg.onChange) { try { cfg.onChange(); } catch {} }
        if (!main.paused) { const p = live.play(); if (p && p.catch) p.catch(() => {}); stopTick(); raf = requestAnimationFrame(tick); }
      }
    });
    live.addEventListener('error', () => {
      failedUrl = url;
      try { console.warn('[live-framing] source could not be loaded, showing the file instead:', url); } catch {}
      stopTick();
      hide('Video sumber tidak bisa diputar — preview memakai file klip lama');
    });

    main.addEventListener('loadedmetadata', refresh);
    main.addEventListener('loadeddata', refresh);
    main.addEventListener('canplay', refresh);
    // A late retry covers pages that attach before the file's metadata exists.
    setTimeout(refresh, 400); setTimeout(refresh, 1800);
    main.addEventListener('emptied', refresh);
    // Seek only when actually out of step: a forced seek on every play/pause makes the big master
    // decoder restart from its last keyframe, which is what stalled playback after a crop.
    main.addEventListener('play', () => { if (!current) return; syncTime(false); stopTick(); raf = requestAnimationFrame(tick); });
    main.addEventListener('pause', () => { stopTick(); try { live.pause(); } catch {} syncTime(false); paintFrame(); });
    main.addEventListener('ended', () => { stopTick(); try { live.pause(); } catch {} });
    main.addEventListener('seeking', () => syncTime(true));
    main.addEventListener('seeked', () => { syncTime(true); paintFrame(); });
    main.addEventListener('timeupdate', () => { if (main.paused) paintFrame(); });
    main.addEventListener('ratechange', () => { live.playbackRate = main.playbackRate || 1; });

    return {
      refresh,
      destroy() { stopTick(); hide(); live.remove(); note.remove(); if (bg) bg.remove(); },
      get active() { return !!current && ready; },
      get wanted() { return !!current; },
      element: live,
    };
  }

  const api = { plan, frameStyle, positionAt, attach, blurSig };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveFraming = api;
})(typeof self !== 'undefined' ? self : this);
