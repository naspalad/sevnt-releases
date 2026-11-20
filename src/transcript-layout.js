// Caption Editor as a page: transcript | style panel | preview.
// renderer.js builds the editor DOM and binds every handler by element id, so
// this file only MOVES existing nodes (listeners and ids survive) and adds
// proxy controls that forward to the real ones. Nothing here edits clip data.
(() => {
  'use strict';

  const studio = document.getElementById('captionStudio');
  const body = document.getElementById('captionStudioBody');
  const editorBtn = document.getElementById('openEditorBtn');
  if (!studio || !body) return;

  const SWATCHES = ['#ffffff', '#e8192c', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ff9f0a', '#636366'];

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const btn = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };

  function build(editor) {
    if (editor.dataset.txLayout) return;

    const words = editor.querySelector('#pw_words');
    const bar = editor.querySelector('#pw_bar');
    const wrap = editor.querySelector('.cap-stage-wrap');
    const stage = editor.querySelector('#capStage');
    const section = bar && bar.closest('.pw-section');
    const fix = editor.querySelector('#ce_fixtypo');
    const ids = ['pw_font', 'pw_anim', 'pw_bold', 'pw_ital', 'pw_color', 'pw_colorOff', 'pw_size', 'pw_posReset', 'pw_text'];
    const ctl = {};
    for (const id of ids) ctl[id] = editor.querySelector('#' + id);
    if (!words || !bar || !wrap || !section || !editor.querySelector('.cap-main') || ids.some(id => !ctl[id])) return;

    editor.dataset.txLayout = '1';
    editor.classList.add('tx-layout');

    // ── Left column: transcript card ─────────────────────────
    const col = el('section', 'tx-col');
    const card = el('div', 'tx-card');
    const head = el('div', 'tx-head');
    const headL = el('div', 'tx-head-l');
    const title = el('div', 'tx-title');
    const meta = el('div', 'tx-meta');
    const headR = el('div', 'tx-head-r');
    headL.append(title, meta);
    const copy = btn('mini-btn', '⎘ Copy');
    if (fix) headR.append(fix);
    headR.append(copy);
    head.append(headL, headR);
    const hint = el('div', 'tx-hint');
    hint.append('Klik kata untuk memilih · Shift/Ctrl-klik untuk banyak kata · ');
    hint.append(el('b', null, '/'));
    hint.append(' = batas chunk');
    const scroller = el('div', 'tx-body');
    scroller.append(words);
    card.append(head, hint, scroller);
    col.append(card);
    editor.insertBefore(col, editor.firstChild);

    copy.addEventListener('click', () => {
      const text = [...words.querySelectorAll('.pw-word')].map(w => w.textContent).join(' ');
      try { navigator.clipboard.writeText(text); } catch {}
      copy.textContent = '✓ Tersalin';
      setTimeout(() => { copy.textContent = '⎘ Copy'; }, 1500);
    });

    // ── Middle column: Words tab → per-word styling ──────────
    const tabBtn = editor.querySelector('.cap-tab[data-tab="words"]');
    if (tabBtn) tabBtn.textContent = 'Word';

    const sh = (t) => el('div', 'tx-sh', t);
    const intro = sh('PER-WORD STYLING · KLIK KATA DI TRANSKRIP, LALU ATUR STYLE-NYA');
    const chip = el('div', 'tx-selchip');
    chip.append(el('i'), el('span'));
    const chipText = chip.querySelector('span');
    section.insertBefore(intro, bar);
    // [KIN-WORD-NOTE] A "Caption animasi" preset is drawn by the kinetic painter, which only takes a per-word COLOUR. Say so,
    // instead of leaving Font / Bold / Italic to look broken.
    const kinNote = el('div', 'tx-hint');
    kinNote.style.cssText = 'color:#ffb454;margin:4px 0 6px;font-size:11px;line-height:1.4';
    kinNote.hidden = true;
    section.insertBefore(kinNote, bar);
    const updateKinNote = () => {
      let id = '';
      try { id = (typeof state !== 'undefined' && state.cfg && state.cfg.captionKinetic) || ''; } catch { id = ''; }
      kinNote.hidden = !id;
      if (id) kinNote.textContent = 'Preset caption animasi aktif — per kata hanya WARNA yang dipakai. Font, Bold, dan Italic berlaku setelah preset dimatikan (Clip Options → Caption animasi).';
    };
    updateKinNote();
    section.insertBefore(chip, bar);

    bar.textContent = '';

    const swRow = el('div', 'tx-swrow');
    const swatches = SWATCHES.map(hex => {
      const b = btn('tx-swatch');
      b.dataset.hex = hex;
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', () => {
        if (ctl.pw_color.disabled) return;
        ctl.pw_color.value = hex;
        ctl.pw_color.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return b;
    });
    ctl.pw_color.classList.add('tx-colorpick');
    swRow.append(...swatches, ctl.pw_color);

    const normalBtn = btn('tx-case-btn', 'Normal');
    const boldBtn = btn('tx-case-btn', 'Bold');
    boldBtn.style.fontWeight = '700';
    normalBtn.addEventListener('click', () => {
      const b = ctl.pw_bold;
      if (b.disabled) return;
      if (!b.classList.contains('on')) b.click();   // mixed selection → all bold first
      if (b.classList.contains('on')) b.click();
    });
    boldBtn.addEventListener('click', () => {
      const b = ctl.pw_bold;
      if (!b.disabled && !b.classList.contains('on')) b.click();
    });
    ctl.pw_ital.textContent = 'Italic';
    ctl.pw_ital.style.fontStyle = 'italic';
    ctl.pw_ital.classList.add('tx-case-btn');
    ctl.pw_bold.style.display = 'none';
    const weightRow = el('div', 'tx-case-row');
    weightRow.append(normalBtn, boldBtn, ctl.pw_ital);

    ctl.pw_colorOff.textContent = '⊘ Hapus warna';
    ctl.pw_posReset.textContent = '⌖ Reset posisi';
    ctl.pw_colorOff.classList.add('tx-pill');
    ctl.pw_posReset.classList.add('tx-pill');
    const actions = el('div', 'tx-actions');
    actions.append(ctl.pw_colorOff, ctl.pw_posReset);

    bar.append(
      sh('WORD COLOR'), swRow,
      sh('WORD FONT'), ctl.pw_font,
      sh('WEIGHT'), weightRow,
      sh('WORD ANIMATION'), ctl.pw_anim,
      sh('SIZE'), ctl.pw_size,
      sh('EDIT TEKS'), ctl.pw_text,
      sh('ACTIONS'), actions,
      ctl.pw_bold
    );

    // ── Right column: clean stage + play bar underneath ──────
    const videoEl = editor.querySelector('#capVideo');
    const ratioLabel = () => {
      const r = parseFloat(stage && stage.style.aspectRatio);
      if (!r) return '';
      return r < 0.8 ? '9:16' : r > 1.25 ? '16:9' : '1:1';
    };

    const prev = el('section', 'tx-preview');
    const pHead = el('div', 'tx-preview-head');
    const pLabel = el('span', null, 'PREVIEW');
    const pRatio = el('span', 'tx-ar');
    pHead.append(pLabel, pRatio);

    const pBar = el('div', 'tx-preview-controls');
    const PLAY_SVG = '<svg width="11" height="13" viewBox="0 0 9 11" fill="currentColor"><polygon points="0,0 9,5.5 0,11"/></svg>';
    const PAUSE_SVG = '<svg width="11" height="13" viewBox="0 0 9 11" fill="currentColor"><rect x="0" y="0" width="3" height="11"/><rect x="5" y="0" width="3" height="11"/></svg>';
    const back = btn('tx-pv-btn', '↺');
    back.title = 'Mundur 5 detik';
    const playBtn = btn('tx-pv-btn tx-pv-play');
    playBtn.title = 'Play / pause';
    playBtn.innerHTML = PLAY_SVG;
    const fwd = btn('tx-pv-btn', '↻');
    fwd.title = 'Maju 5 detik';
    const pTime = el('span', 'tx-pv-time', '00:00 / 00:00');
    const maxBtn = editor.querySelector('#ce_max');
    pBar.append(back, playBtn, fwd);
    if (maxBtn) pBar.append(maxBtn);
    pBar.append(pTime);

    editor.append(prev);
    prev.append(pHead, wrap, pBar);

    if (videoEl) {
      // The bar replaces the native overlay (it floats over the stage when maximised).
      videoEl.removeAttribute('controls');
      const mmss = (s) => {
        s = isFinite(s) && s > 0 ? Math.floor(s) : 0;
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      };
      const syncBar = () => {
        pTime.textContent = mmss(videoEl.currentTime) + ' / ' + mmss(videoEl.duration);
        playBtn.innerHTML = videoEl.paused ? PLAY_SVG : PAUSE_SVG;
      };
      ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked', 'play', 'pause', 'ended', 'emptied']
        .forEach(ev => videoEl.addEventListener(ev, syncBar));
      playBtn.addEventListener('click', () => {
        if (videoEl.paused) { const p = videoEl.play(); if (p && p.catch) p.catch(() => {}); }
        else videoEl.pause();
      });
      const seekBy = (d) => {
        const dur = isFinite(videoEl.duration) ? videoEl.duration : Infinity;
        videoEl.currentTime = Math.max(0, Math.min(dur, videoEl.currentTime + d));
      };
      back.addEventListener('click', () => seekBy(-5));
      fwd.addEventListener('click', () => seekBy(5));
      syncBar();
    }

    // ── Live sync from the real controls ─────────────────────
    const titleSrc = document.getElementById('csEditorTitle');
    const refresh = () => {
      try { updateKinNote(); } catch {}
      const picked = words.querySelectorAll('.pw-word.sel');
      const n = picked.length;
      chip.dataset.state = n ? 'on' : 'off';
      chipText.textContent = n === 0 ? 'Belum ada kata dipilih' : n === 1 ? '"' + picked[0].textContent + '"' : n + ' kata dipilih';

      const cur = (ctl.pw_color.value || '').toLowerCase();
      swatches.forEach(b => {
        b.disabled = ctl.pw_color.disabled;
        b.classList.toggle('on', n > 0 && b.dataset.hex === cur);
      });
      const isBold = ctl.pw_bold.classList.contains('on');
      normalBtn.disabled = boldBtn.disabled = ctl.pw_bold.disabled;
      normalBtn.classList.toggle('on', n > 0 && !isBold);
      boldBtn.classList.toggle('on', n > 0 && isBold);

      title.textContent = (titleSrc && titleSrc.textContent) || 'Transkrip';
      const count = words.querySelectorAll('.pw-word').length;
      const dur = videoEl && isFinite(videoEl.duration) && videoEl.duration > 0 ? ' · ' + videoEl.duration.toFixed(1) + 's' : '';
      meta.textContent = count + ' kata' + dur;
      pRatio.textContent = ratioLabel();
    };
    new MutationObserver(refresh).observe(words, { childList: true, subtree: true });
    new MutationObserver(refresh).observe(ctl.pw_bold, { attributes: true, attributeFilter: ['class', 'disabled'] });
    new MutationObserver(refresh).observe(ctl.pw_color, { attributes: true, attributeFilter: ['disabled'] });
    if (stage) new MutationObserver(refresh).observe(stage, { attributes: true, attributeFilter: ['style'] });
    if (videoEl) videoEl.addEventListener('loadedmetadata', refresh);

    // ── Word inline popup ─────────────────────────────────────────────────────
    const popup = el('div', 'tx-word-popup');
    popup.hidden = true;
    document.body.append(popup);

    // Row 0: label
    const wpLabel = el('div', 'tx-wp-label', 'Kata dipilih');
    popup.append(wpLabel);

    // Row 1: color swatches + color picker
    const wpSwRow = el('div', 'tx-wp-row');
    const wpSwatches = SWATCHES.map(hex => {
      const b = btn('tx-wp-swatch');
      b.style.background = hex; b.dataset.hex = hex; b.title = hex;
      b.addEventListener('click', () => {
        if (ctl.pw_color.disabled) return;
        ctl.pw_color.value = hex;
        ctl.pw_color.dispatchEvent(new Event('input', { bubbles: true }));
        syncPopup();
      });
      return b;
    });
    const wpPick = document.createElement('input');
    wpPick.type = 'color'; wpPick.className = 'tx-wp-colorpick'; wpPick.title = 'Pilih warna';
    wpPick.addEventListener('input', () => {
      if (ctl.pw_color.disabled) return;
      ctl.pw_color.value = wpPick.value;
      ctl.pw_color.dispatchEvent(new Event('input', { bubbles: true }));
      syncPopup();
    });
    wpSwRow.append(...wpSwatches, wpPick);
    popup.append(wpSwRow);

    // Row 2: B, I, separator, font selector
    const wpBtnRow = el('div', 'tx-wp-row');
    const wpB = btn('tx-wp-btn'); wpB.innerHTML = '<b>B</b>'; wpB.title = 'Bold';
    const wpI = btn('tx-wp-btn'); wpI.innerHTML = '<i style="font-style:italic">I</i>'; wpI.title = 'Italic';
    const wpSep = el('div', 'tx-wp-sep');
    const wpFont = el('select', 'tx-wp-font');
    const fillFontOpts = () => {
      if (wpFont.options.length !== ctl.pw_font.options.length) {
        wpFont.innerHTML = ctl.pw_font.innerHTML;
      }
      wpFont.value = ctl.pw_font.value;
      wpFont.disabled = ctl.pw_font.disabled;
    };
    wpFont.addEventListener('change', () => {
      ctl.pw_font.value = wpFont.value;
      ctl.pw_font.dispatchEvent(new Event('change', { bubbles: true }));
    });
    wpB.addEventListener('click', () => {
      if (!ctl.pw_bold.disabled) ctl.pw_bold.click();
      syncPopup();
    });
    wpI.addEventListener('click', () => {
      if (!ctl.pw_ital.disabled) ctl.pw_ital.click();
      syncPopup();
    });
    wpBtnRow.append(wpB, wpI, wpSep, wpFont);
    popup.append(wpBtnRow);

    // Row 3: Edit teks word
    const wpTextRow = el('div', 'tx-wp-row');
    const wpText = el('input', 'tx-wp-text');
    wpText.type = 'text'; wpText.placeholder = 'Edit teks kata…'; wpText.style.cssText = 'flex:1;height:26px;border-radius:7px;font-size:11px;background:var(--surface-2,rgba(255,255,255,.07));color:var(--ink,#e9e9e4);border:1px solid var(--hair,rgba(255,255,255,.12));padding:0 8px;min-width:0';
    wpText.addEventListener('input', () => {
      if (ctl.pw_text.disabled) return;
      ctl.pw_text.value = wpText.value;
      ctl.pw_text.dispatchEvent(new Event('input', { bubbles: true }));
    });
    wpText.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wpText.blur(); } });
    wpTextRow.append(wpText);
    popup.append(wpTextRow);

    // Row 4: Hapus warna
    const wpActRow = el('div', 'tx-wp-row');
    const wpHapus = btn('tx-wp-btn tx-wp-muted', '⊘ Hapus warna');
    wpHapus.style.flex = '1';
    wpHapus.addEventListener('click', () => {
      if (!ctl.pw_colorOff.disabled) ctl.pw_colorOff.click();
      syncPopup();
    });
    wpActRow.append(wpHapus);
    popup.append(wpActRow);

    function syncPopup() {
      wpB.classList.toggle('on', ctl.pw_bold.classList.contains('on'));
      wpI.classList.toggle('on', ctl.pw_ital.classList.contains('on'));
      const cur = (ctl.pw_color.value || '').toLowerCase();
      wpSwatches.forEach(b => b.classList.toggle('on', b.dataset.hex === cur));
      wpPick.value = cur || '#ffffff';
      fillFontOpts();
      wpB.disabled = ctl.pw_bold.disabled;
      wpI.disabled = ctl.pw_ital.disabled;
      wpHapus.disabled = ctl.pw_colorOff.disabled;
      // Sync text field
      if (document.activeElement !== wpText) wpText.value = ctl.pw_text.value || '';
      wpText.disabled = ctl.pw_text.disabled;
    }

    // [POPUP-ANCHOR] renderer.js rebuilds every .pw-word on each selection/style change, so the element that was clicked
    // is detached a moment later and its rect is all zeros — which pinned the popup to the top-left corner. Remember WHICH
    // word (cue + word index) and look the live element up again every time the popup is positioned.
    let _popupWord = null;
    let _popupKey = null;
    const currentWordEl = () => {
      if (_popupKey) {
        const el = words.querySelector('.pw-word[data-ci="' + _popupKey.ci + '"][data-wi="' + _popupKey.wi + '"]');
        if (el) return el;
      }
      return words.querySelector('.pw-word.sel');
    };
    const positionPopup = () => {
      if (popup.hidden) return;
      _popupWord = currentWordEl();
      if (!_popupWord) { popup.hidden = true; return; }
      const r = _popupWord.getBoundingClientRect();
      if (!r.width && !r.height) return;   // not laid out yet: keep the last position instead of jumping to 0,0
      // Read actual dimensions; popup must be visible for these to be non-zero
      const pw = popup.getBoundingClientRect().width || popup.offsetWidth || 220;
      const ph = popup.getBoundingClientRect().height || popup.offsetHeight || 140;
      let left = r.left + r.width / 2 - pw / 2;
      let top = r.top - ph - 10;
      // Clamp to viewport
      left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
      if (top < 8) top = r.bottom + 8;
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
      // Arrow: points at horizontal center of the clicked word
      const arrowX = (r.left + r.width / 2) - left;
      popup.style.setProperty('--arrow-x', Math.max(12, Math.min(pw - 12, arrowX)) + 'px');
    };

    words.addEventListener('click', (e) => {
      const w = e.target.closest && e.target.closest('.pw-word');
      if (!w) return;
      // rAF #1: wait for renderer.js click handler to update .sel class
      requestAnimationFrame(() => {
        const nSel = words.querySelectorAll('.pw-word.sel').length;
        if (nSel > 0) {
          _popupWord = w;
          _popupKey = { ci: w.dataset.ci, wi: w.dataset.wi };
          syncPopup();
          // Position the popup off-screen first so layout runs but it stays invisible
          popup.style.left = '-9999px'; popup.style.top = '-9999px';
          popup.hidden = false;
          const selCount = words.querySelectorAll('.pw-word.sel').length;
          wpLabel.textContent = selCount === 1 ? '"' + w.textContent + '"' : selCount + ' kata dipilih';
          // rAF #2: now popup has real dimensions, position correctly
          requestAnimationFrame(positionPopup);
        } else {
          popup.hidden = true;
          _popupWord = null; _popupKey = null;
        }
      });
    });
    // A style change re-renders the words: re-anchor (and re-sync) the popup on the new element.
    new MutationObserver(() => { if (!popup.hidden) { syncPopup(); requestAnimationFrame(positionPopup); } }).observe(words, { childList: true, subtree: true });

    document.addEventListener('click', (ev) => {
      if (popup.hidden) return;
      // [POPUP-OUTSIDE] Close on ANY click outside the popup. A click on a word is handled by the words listener above
      // (it re-opens / moves the popup), so words are the only other exception. The old test also exempted the whole
      // transcript card, so clicking its empty space (or the right-hand panels) never dismissed it.
      if (!popup.contains(ev.target) && !(ev.target.closest && ev.target.closest('.pw-word'))) {
        popup.hidden = true; _popupWord = null; _popupKey = null;
      }
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { popup.hidden = true; _popupWord = null; _popupKey = null; }
    });
    window.addEventListener('resize', positionPopup, { passive: true });
    const txBody = body.querySelector('.tx-body');
    if (txBody) txBody.addEventListener('scroll', positionPopup, { passive: true });

    refresh();
  }

  new MutationObserver(() => {
    const ed = body.querySelector('.cap-editor');
    if (ed) {
      try { build(ed); } catch (e) { console.warn('[transcript-layout]', e); }
    }
  }).observe(body, { childList: true });

  // ── Page behaviour: the rail stays visible, Editor button reads as active ──
  let held = [];
  let open = !studio.hidden;
  const sync = () => {
    if (open === !studio.hidden) return;
    open = !studio.hidden;
    if (open) {
      held = [...document.querySelectorAll('.rail-btn.active')].filter(b => b !== editorBtn);
      held.forEach(b => b.classList.remove('active'));
      if (editorBtn) editorBtn.classList.add('active');
    } else {
      if (editorBtn) editorBtn.classList.remove('active');
      held.forEach(b => b.classList.add('active'));
      held = [];
    }
  };
  new MutationObserver(sync).observe(studio, { attributes: true, attributeFilter: ['hidden'] });

  // Picking another rail page leaves the editor first (the same as its Close button).
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.rail-btn');
    if (!b || b === editorBtn || b.id === 'openOutputBtn' || studio.hidden) return;
    const close = document.getElementById('csEditorClose');
    if (close) close.click();
  }, true);
})();
