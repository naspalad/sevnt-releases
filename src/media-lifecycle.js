// Small, idempotent helpers for owning one decoded media source at a time.
(function (root) {
  'use strict';

  function releaseMedia(el) {
    if (!el) return;
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
    try { el.removeAttribute('src'); } catch {}
    try { el.load(); } catch {}
  }

  function setMediaSource(el, url) {
    releaseMedia(el);
    if (!el || !url) return false;
    el.src = url;
    try { el.load(); } catch {}
    return true;
  }

  function attachCaptureMirror(source, target) {
    releaseMedia(target);
    if (!source || !target || typeof source.captureStream !== 'function') return false;
    try {
      target.srcObject = source.captureStream();
      return true;
    } catch {
      return false;
    }
  }

  const api = { releaseMedia, setMediaSource, attachCaptureMirror };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediaLifecycle = api;
})(typeof self !== 'undefined' ? self : this);
