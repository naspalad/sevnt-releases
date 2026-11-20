// SEVNT Mobile Companion — IPC Handler Registration
// Registers ipcMain handlers for mobile gateway lifecycle.
// Required early in the main process (before BrowserWindow is created).
//
// IPC channels added:
//   mobile:start         → start gateway + pairing, return { pairingUrl, mode, lanUrl }
//   mobile:stop          → stop gateway + revoke sessions
//   mobile:status        → { running, connectedDevice, mode, pairingUrl }
//   mobile:getPairingUrl → generate new pairing URL (gateway must be running)
//   mobile:approve       → approve pending pair request (called from dialog)
//   mobile:reject        → reject pending pair request

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { PairingManager } = require('./mobile/pairing-manager');
const { getLicenseStatus } = require('./license/license-status');

let _manager = null;
let _pendingPairResolve = null;  // resolves the onPairRequest promise
let _connectedDevice = null;     // { deviceId, connectedAt }
let _mainWindow = null;          // reference set by setMainWindow()

function setMainWindow(win) {
  _mainWindow = win;
}

function _getManager() {
  if (!_manager) {
    // PairingManager passes opts.handlers directly to MobileGateway constructor
    _manager = new PairingManager({
      handlers: {
        onPairRequest: (ip) => _onPairRequest(ip),
        getLicenseHash: () => _getLicenseHash(),
        getProjects: () => _getProjects(),
        saveTranscript: ({ projectId, transcript }) => _saveTranscript(projectId, transcript),
        getStatus: () => _status,
        getClips: () => _clips.map(({ file, ...c }) => ({ ...c, media: !!file })),
        getHistory: () => { _send('mobile:refreshHistory'); return _history.map((b) => ({ ...b, clips: (b.clips || []).map(({ file, ...c }) => ({ ...c, media: !!file })) })); },
        getMediaPath: (id) => _mediaPath(id),
        startJob: (url) => _startJob(url),
        cancelJob: () => { _send('mobile:cancelJob'); return { ok: true }; },
        saveCues: (p) => _saveCues(p),
        getCues: (p) => _getCues(p),
        getSettings: () => { _send('mobile:refreshSettings'); return _settings; },
        setSettings: (p) => _setSettings(p),
        runOp: (name, body) => _runOp(name, body),
      },
    });
  }
  return _manager;
}

// ─── Pair request handler ─────────────────────────────────────────────────────

function _onPairRequest(ip) {
  return new Promise((resolve) => {
    // Reject any in-flight pair request to prevent Promise leak (concurrent pairing fix)
    if (_pendingPairResolve) {
      const prev = _pendingPairResolve;
      _pendingPairResolve = null;
      prev(false);
    }
    _pendingPairResolve = resolve;
    // Notify renderer to show approval dialog
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send('mobile:pairRequest', { ip });
    }
    // Auto-timeout: reject after 60s if user doesn't respond
    setTimeout(() => {
      if (_pendingPairResolve === resolve) {
        _pendingPairResolve = null;
        resolve(false);
      }
    }, 60000);
  });
}

// ─── Helpers (read from renderer state via IPC) ───────────────────────────────

async function _getLicenseHash() {
  const status = await getLicenseStatus();
  if (!status.valid) return null;
  return status.licenseHash;
}

function _getProjects() {
  // Returns project list from last known renderer state
  return _projectsCache || [];
}

let _projectsCache = [];

// ─── Remote control of the desktop app ────────────────────────────────────────
// The renderer owns all state; it pushes snapshots here (mobile:sync*), and the HP asks for them through the gateway.
// A file path never leaves this process: the HP only sees an id and streams it through /api/media.
let _status = { running: false };
let _clips = [];       // [{ id, title, start, end, cues:[{start,end,text}], file }]
let _history = [];     // [{ id, title, when, clips:[{ id, title, file, cues }] }]
let _settings = {};
const _MEDIA_EXT = ['.mp4', '.mov', '.m4v', '.webm'];
function _send(ch, payload) { if (_mainWindow && !_mainWindow.isDestroyed()) _mainWindow.webContents.send(ch, payload); }
function _mediaPath(id) {
  const want = String(id || '');
  if (!want) return null;
  let hit = _clips.find((c) => String(c.id) === want);
  if (!hit) for (const b of _history) { hit = (b.clips || []).find((c) => String(c.id) === want); if (hit) break; }
  const f = hit && hit.file;
  if (!f || typeof f !== 'string' || !require('path').isAbsolute(f)) return null;
  if (!_MEDIA_EXT.includes(require('path').extname(f).toLowerCase())) return null;
  return f;
}
function _startJob(url) {
  if (_status && _status.running) return { ok: false, error: 'busy' };
  if (!_mainWindow || _mainWindow.isDestroyed()) return { ok: false, error: 'desktop_unavailable' };
  _status = { running: true, pct: 0, step: 'Memulai', detail: '', url };
  _send('mobile:startJob', { url });
  return { ok: true };
}
function _saveCues({ id, cues }) {
  const clip = _clips.find((c) => String(c.id) === String(id));
  if (!clip) return { ok: false, error: 'clip_not_found' };
  if (!Array.isArray(cues) || cues.length > 2000) return { ok: false, error: 'bad_cues' };
  const clean = [];
  for (const c of cues) {
    const start = Number(c && c.start), end = Number(c && c.end), text = c && typeof c.text === 'string' ? c.text.slice(0, 500) : '';
    if (!isFinite(start) || !isFinite(end) || end <= start) return { ok: false, error: 'bad_cue' };
    clean.push({ start, end, text });
  }
  clip.cues = clean;
  _send('mobile:saveCues', { id: String(id), cues: clean });
  return { ok: true };
}
function _getCues({ id }) {
  const clip = _clips.find((c) => String(c.id) === String(id));
  if (clip) return { ok: true, cues: clip.cues || [] };
  for (const batch of _history) {
    const hc = batch.clips && batch.clips.find((c) => String(c.id) === String(id));
    if (hc) return { ok: true, cues: hc.cues || [] };
  }
  return null;
}
// What the phone may change (everything else on the desktop stays out of reach): key -> type check
const _SETTING_RULES = {
  clipCount: (v) => Number.isInteger(v) && v >= 1 && v <= 30,
  clipDuration: (v) => typeof v === 'string' && v.length <= 8,
  clipMode: (v) => v === 'auto' || v === 'manual',
  deadAirCut: (v) => typeof v === 'boolean',
  burnSubtitles: (v) => typeof v === 'boolean',
  subtitleAnim: (v) => ['pop', 'fade', 'rise', 'drop', 'zoom', 'blur', 'type', 'none'].includes(v),
  subtitleWordsPerChunk: (v) => v === 'auto' || (Number.isInteger(v) && v >= 1 && v <= 8),
  captionKinetic: (v) => typeof v === 'string' && v.length <= 40,
  resolution: (v) => typeof v === 'string' && v.length <= 8,
  subtitleX: (v) => Number.isFinite(v) && v >= 0 && v <= 1080,
  subtitleY: (v) => Number.isFinite(v) && v >= 50 && v <= 1850,
  subtitleFontSize: (v) => Number.isFinite(v) && v >= 32 && v <= 120,
  collageBroll: (v) => typeof v === 'boolean',
  collageStyle: (v) => ['auto', 'kolase', 'poster', 'partikel', 'impact', 'glitch', 'stiker'].includes(v),
  brollSec: (v) => ['auto', '2', '3', '4', '5'].includes(String(v)),
  hookPreset: (v) => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v),
  trackerAsdMode: (v) => v === 'motion_vad' || v === 'blendshape',
  subtitleTracking: (v) => Number.isInteger(v) && v >= -10 && v <= 30,
  fastMode: (v) => typeof v === 'boolean',
  smartTrack: (v) => typeof v === 'boolean',
  subtitleLang: (v) => typeof v === 'string' && /^[a-zA-Z-]{2,10}$/.test(v),
  subtitleOffsetMs: (v) => Number.isFinite(v) && v >= -600 && v <= 600,
  deadAirLevel: (v) => typeof v === 'string' && /^[a-z0-9_-]{1,16}$/i.test(v),
  format: (v) => typeof v === 'string' && /^[a-z0-9_:x-]{1,16}$/i.test(v),
  hookAutoBurn: (v) => typeof v === 'boolean',
  hookCase: (v) => ['', 'upper', 'title', 'lower'].includes(v),
  captionDim: (v) => Number.isFinite(v) && v >= 0 && v <= 0.6,
  videoFx: (v) => typeof v === 'string' && v.length <= 24,
  watermark: (v) => v && typeof v === 'object' && !Array.isArray(v),   // only enabled / anchor / opacity / sizePct are taken, see below
};
const _WM_RULES = {
  enabled: (v) => typeof v === 'boolean',
  anchor: (v) => ['tl', 'tr', 'bl', 'br', 'tc', 'bc', 'c'].includes(v),
  opacity: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  sizePct: (v) => typeof v === 'number' && v >= 2 && v <= 80,
};
function _setSettings(patch) {
  const out = {};
  for (const k of Object.keys(patch || {})) {
    const rule = _SETTING_RULES[k];
    if (!rule || !rule(patch[k])) continue;
    if (k === 'watermark') {
      const wm = {};
      for (const w of Object.keys(patch[k])) if (_WM_RULES[w] && _WM_RULES[w](patch[k][w])) wm[w] = patch[k][w];
      if (Object.keys(wm).length) out.watermark = wm;
    } else out[k] = patch[k];
  }
  if (!Object.keys(out).length) return { ok: false, error: 'nothing_allowed' };
  _settings = { ..._settings, ...out, ...(out.watermark ? { watermark: { ...(_settings.watermark || {}), ...out.watermark } } : {}) };
  _send('mobile:setSettings', out);
  return { ok: true, settings: _settings };
}

// Whitelisted desktop actions the phone may trigger. Ids refer to clips the renderer pushed; no paths cross this line.
const _clipId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 120;
const _OPS = {
  renderClips: (b) => ({ ids: Array.isArray(b.ids) ? b.ids.filter(_clipId).slice(0, 60) : [] }),                 // [] = all
  clipFrame: (b) => (_clipId(b.id) && Number.isFinite(b.x) && Number.isFinite(b.y) ? { id: b.id, x: Math.min(100, Math.max(0, b.x)), y: Math.min(100, Math.max(0, b.y)) } : null),
  wmText: (b) => {
    const lines = Array.isArray(b.lines) ? b.lines.slice(0, 5).map((l) => ({ text: String((l && l.text) || '').slice(0, 200), scale: Math.min(200, Math.max(30, Math.round(+(l && l.scale) || 100))) })) : [];
    return { lines, font: typeof b.font === 'string' ? b.font.slice(0, 60) : undefined, color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : undefined,
      sizePct: Number.isFinite(b.sizePct) ? Math.min(20, Math.max(1, b.sizePct)) : undefined, opacity: Number.isFinite(b.opacity) ? Math.min(1, Math.max(0, b.opacity)) : undefined };
  },
  wmGeom: (b) => ({ xPct: Number.isFinite(b.xPct) ? Math.min(40, Math.max(0, b.xPct)) : undefined, yPct: Number.isFinite(b.yPct) ? Math.min(40, Math.max(0, b.yPct)) : undefined }),
  wmRemoveImage: () => ({}),
  wmImage: (b) => (typeof b.b64 === 'string' && b.b64.length < 7.2e6 ? { name: String(b.name || 'watermark'), b64: b.b64 } : null),
  stopRender: () => ({}),
};
function _runOp(name, body) {
  const f = Object.prototype.hasOwnProperty.call(_OPS, name) ? _OPS[name] : null;
  if (!f) return { ok: false, error: 'unknown_op' };
  const clean = f(body || {});
  if (!clean) return { ok: false, error: 'bad_args' };
  if (!_mainWindow || _mainWindow.isDestroyed()) return { ok: false, error: 'desktop_unavailable' };
  if ((name === 'renderClips') && _status && _status.running) return { ok: false, error: 'busy' };
  _send('mobile:op', { op: name, ...clean });
  return { ok: true };
}

function _saveTranscript(projectId, transcript) {
  // Validate projectId against known projects (BUG-5B-004 fix)
  const known = _projectsCache.find(p => String(p.id) === String(projectId));
  if (!known) return false;
  // Persist via main window IPC back to renderer (renderer owns project state)
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send('mobile:saveTranscript', { projectId, transcript });
  }
  return true;
}

// ─── QR Code generator (local, no external service) ──────────────────────────

async function _generateQrSvg(url) {
  // SEC-5B1-001 fix: generate QR locally, never send token to external service
  const QRCode = require('qrcode');
  return QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } });
}

// ─── IPC Handler Registration ─────────────────────────────────────────────────

function registerMobileIpc() {
  // mobile:start — block if device already connected (BUG-5B-003 fix)
  ipcMain.handle('mobile:start', async (_event, opts = {}) => {
    if (_connectedDevice) {
      return { ok: false, error: 'companion_slot_occupied', connectedDevice: _connectedDevice };
    }
    // License check — Mobile Companion is a premium feature requiring active license
    const licenseStatus = await getLicenseStatus();
    if (!licenseStatus.valid) {
      return { ok: false, error: 'license_required', reason: licenseStatus.reason };
    }
    try {
      const mgr = _getManager();
      const result = await mgr.startPairing({ ...opts });
      // SEC-5B1-001 fix: generate QR locally, include SVG in response
      let qrSvg = null;
      if (result.pairingUrl) {
        try { qrSvg = await _generateQrSvg(result.pairingUrl); } catch { /* non-fatal */ }
      }
      return { ok: true, ...result, qrSvg };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // mobile:generateQr — generate local QR SVG for a pairing URL (SEC-5B1-001 fix)
  ipcMain.handle('mobile:generateQr', async (_event, url) => {
    if (!url || typeof url !== 'string') return { ok: false, error: 'invalid_url' };
    try {
      const qrSvg = await _generateQrSvg(url);
      return { ok: true, qrSvg };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // mobile:stop
  ipcMain.handle('mobile:stop', async () => {
    try {
      if (_manager) await _manager.stopPairing();
      _connectedDevice = null;  // always clear slot on stop
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // mobile:status
  ipcMain.handle('mobile:status', () => {
    if (!_manager) return { running: false, connectedDevice: null, pairingUrl: null };
    return {
      running: _manager.isActive,
      connectedDevice: _connectedDevice,
      pairingUrl: null,
      tunnelUrl: _manager.tunnelUrl || null,
    };
  });

  // mobile:getPairingUrl — generates fresh one-use token
  ipcMain.handle('mobile:getPairingUrl', async () => {
    try {
      const mgr = _getManager();
      if (!mgr.isActive) {
        const result = await mgr.startPairing({});
        return { ok: true, ...result };
      }
      const { MobileGateway } = require('./mobile/mobile-gateway');
      // Re-use the active gateway's createPairingUrl
      const url = mgr._gateway
        ? mgr._gateway.createPairingUrl(mgr.tunnelUrl || null)
        : null;
      if (!url) return { ok: false, error: 'gateway_not_running' };
      return { ok: true, pairingUrl: url.pairingUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // mobile:approve — renderer approves a pending pair request; sets 1-device slot
  ipcMain.handle('mobile:approve', () => {
    if (_pendingPairResolve) {
      _connectedDevice = { connectedAt: Date.now() };  // BUG-5B-003: occupy slot
      _pendingPairResolve(true);
      _pendingPairResolve = null;
    }
    return { ok: true };
  });

  // mobile:reject — renderer rejects a pending pair request
  ipcMain.handle('mobile:reject', () => {
    if (_pendingPairResolve) {
      _pendingPairResolve(false);
      _pendingPairResolve = null;
    }
    return { ok: true };
  });

  // snapshots pushed by the renderer for the phone to read
  ipcMain.handle('mobile:syncStatus', (_e, s) => { if (s && typeof s === 'object') _status = s; return { ok: true }; });
  ipcMain.handle('mobile:syncClips', (_e, c) => { if (Array.isArray(c)) _clips = c.slice(0, 200); return { ok: true }; });
  ipcMain.handle('mobile:syncHistory', (_e, h) => { if (Array.isArray(h)) _history = h.slice(0, 300); return { ok: true }; });
  ipcMain.handle('mobile:syncSettings', (_e, st) => { if (st && typeof st === 'object') _settings = st; return { ok: true }; });

  // mobile:syncProjects — renderer pushes current project list to cache
  ipcMain.handle('mobile:syncProjects', (_event, projects) => {
    if (Array.isArray(projects)) _projectsCache = projects;
    return { ok: true };
  });
}

// BUG-5B-001 fix: export stopGateway so sevnt-main.js can call it on quit
async function stopGateway() {
  if (_manager) {
    await _manager.stopPairing();
    _connectedDevice = null;
  }
}

// Test-only: simulate a connected device to verify slot limit
function _testSetConnected(val) { _connectedDevice = val || null; }

module.exports = { registerMobileIpc, setMainWindow, stopGateway, _testSetConnected };
