// Mobile Companion panel logic — QR pairing for SEVNT Studio.
// Relies on window.socl.mobile.* exposed by src/preload.js.
(function () {
  'use strict';

  const overlay      = document.getElementById('mcOverlay');
  const mobileBtn    = document.getElementById('mobileBtn');
  const mcClose      = document.getElementById('mcClose');
  const mcBtnStart   = document.getElementById('mcBtnStart');
  const mcBtnStop    = document.getElementById('mcBtnStop');
  const mcBtnRefresh = document.getElementById('mcBtnRefreshQr');
  const mcQrWrap     = document.getElementById('mcQrWrap');
  const mcQr         = document.getElementById('mcQr');
  const mcUrlText    = document.getElementById('mcUrlText');
  const mcConnected  = document.getElementById('mcConnectedInfo');
  const mcDot        = document.getElementById('mcDot');
  const mcStatusText = document.getElementById('mcStatusText');
  const mcBadge      = document.getElementById('mobileBadge');

  if (!overlay || !mobileBtn) return; // guard: elements not found

  // ── Open / close ──────────────────────────────────────────────────────────────
  mobileBtn.addEventListener('click', () => {
    const opening = overlay.hidden;
    overlay.hidden = !opening;
    overlay.setAttribute('aria-hidden', String(!opening));
    if (opening) refreshStatus();
  });

  mcClose.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function close() {
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
  }

  // ── State rendering ───────────────────────────────────────────────────────────
  function render(state) {
    // state: { running, connectedDevice, pairingUrl } or null (error)
    if (!state) {
      setDot('idle'); mcStatusText.textContent = 'Gagal cek status';
      mcQrWrap.hidden = true; mcConnected.hidden = true;
      mcBtnStart.hidden = false; mcBtnStop.hidden = true; mcBtnRefresh.hidden = true;
      return;
    }

    if (state.connectedDevice) {
      setDot('connected'); mcStatusText.textContent = 'HP terhubung';
      mcQrWrap.hidden = true; mcConnected.hidden = false;
      mcBtnStart.hidden = true; mcBtnStop.hidden = false; mcBtnRefresh.hidden = true;
      if (mcBadge) { mcBadge.hidden = false; mcBadge.textContent = '1'; }
    } else if (state.running) {
      setDot('waiting'); mcStatusText.textContent = 'Menunggu HP scan QR…';
      mcQrWrap.hidden = false; mcConnected.hidden = true;
      mcBtnStart.hidden = true; mcBtnStop.hidden = false; mcBtnRefresh.hidden = false;
      if (mcBadge) mcBadge.hidden = true;
    } else {
      setDot('idle'); mcStatusText.textContent = 'Belum aktif';
      mcQrWrap.hidden = true; mcConnected.hidden = true;
      mcBtnStart.hidden = false; mcBtnStop.hidden = true; mcBtnRefresh.hidden = true;
      if (mcBadge) mcBadge.hidden = true;
    }
  }

  function setDot(state) {
    mcDot.className = 'mc-dot mc-dot--' + state;
  }

  function showQr(qrSvg, url) {
    if (qrSvg) mcQr.innerHTML = qrSvg;
    mcUrlText.textContent = url || '';
  }

  // ── Refresh status from main process ─────────────────────────────────────────
  async function refreshStatus() {
    try {
      const s = await window.socl.mobile.status();
      render(s);
    } catch {
      render(null);
    }
  }

  // ── Start gateway ─────────────────────────────────────────────────────────────
  mcBtnStart.addEventListener('click', async () => {
    mcBtnStart.disabled = true;
    mcBtnStart.textContent = 'Memulai…';
    try {
      const res = await window.socl.mobile.start();
      if (!res.ok) {
        if (res.error === 'companion_slot_occupied') {
          // Already connected — just refresh
          await refreshStatus();
        } else {
          setDot('idle');
          mcStatusText.textContent = 'Error: ' + (res.error || 'gagal memulai');
        }
        return;
      }
      showQr(res.qrSvg, res.lanUrl || res.pairingUrl);
      render({ running: true, connectedDevice: null, pairingUrl: res.pairingUrl });
    } catch (e) {
      setDot('idle');
      mcStatusText.textContent = 'Error: ' + e.message;
    } finally {
      mcBtnStart.disabled = false;
      mcBtnStart.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg> Mulai &amp; Tampilkan QR';
    }
  });

  // ── Stop gateway ──────────────────────────────────────────────────────────────
  mcBtnStop.addEventListener('click', async () => {
    await window.socl.mobile.stop().catch(() => {});
    render({ running: false, connectedDevice: null });
  });

  // ── Refresh QR (new pairing token) ────────────────────────────────────────────
  mcBtnRefresh.addEventListener('click', async () => {
    try {
      const res = await window.socl.mobile.getPairingUrl();
      if (res.ok && res.qrSvg) {
        showQr(res.qrSvg, res.lanUrl || res.pairingUrl);
      } else if (res.ok && res.pairingUrl) {
        // generate QR from URL
        const qr = await window.socl.mobile.generateQr(res.pairingUrl);
        if (qr.ok) showQr(qr.qrSvg, res.lanUrl || res.pairingUrl);
      }
    } catch {}
  });

  // ── Events from main process ──────────────────────────────────────────────────
  if (window.socl.mobile.onConnected) {
    window.socl.mobile.onConnected(() => {
      refreshStatus();
    });
  }
  if (window.socl.mobile.onDisconnected) {
    window.socl.mobile.onDisconnected(() => {
      refreshStatus();
    });
  }
})();
