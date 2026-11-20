// SEVNT Studio — Unified Preload
// Exposes:
//   window.sevnt.*  — SEVNTY App IPC channels + SEVNT Studio IPC
//   window.socl.*   — Existing SOCL channels (mobile companion, pipeline, watermark, etc.)
//
// Security contract:
//   - No raw ipcRenderer exposure
//   - No Node.js module exposure (require, fs, path)
//   - Each handler exposes one specific, named operation
//   - Input type validation before invoke
//   - Event listeners return an unsubscribe function

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ══ window.sevnt — SEVNTY App + SEVNT Studio IPC ═══════════════════════════════
contextBridge.exposeInMainWorld('sevnt', {
  // ── Platform info ──────────────────────────────────────────────────────────
  platform:  process.platform,
  isDesktop: true,

  // ── License (SEVNT Electron License Manager — sole authority) ─────────────
  licenseStatus:     ()    => ipcRenderer.invoke('sevnt:getLicenseStatus'),
  licenseActivate:   (key) => {
    if (typeof key !== 'string' || !key.trim()) return Promise.reject(new Error('Invalid key'));
    return ipcRenderer.invoke('sevnt:activateLicense', key.trim());
  },
  licenseDeactivate: ()    => ipcRenderer.invoke('sevnt:deactivateLicense'),

  // ── Caption / Watermark apply → Python Engine ─────────────────────────────
  applyCaption: (config) => {
    if (typeof config !== 'object' || config === null) return Promise.reject(new Error('Invalid config'));
    return ipcRenderer.invoke('sevnt:applyCaption', config);
  },

  // ── Folder picker & navigation ─────────────────────────────────────────────
  pickFolder:       ()     => ipcRenderer.invoke('sevnt:pickFolder'),
  openOutputFolder: ()     => ipcRenderer.invoke('sevnt:openOutputFolder'),
  openFolder:       (p)    => {
    if (typeof p !== 'string') return Promise.reject(new Error('Invalid path'));
    return ipcRenderer.invoke('sevnt:openFolder', p);
  },

  // ── App version & update ───────────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('sevnt:getAppVersion'),
  checkUpdate:   () => ipcRenderer.invoke('sevnt:checkUpdate'),

  // ── Binary management ──────────────────────────────────────────────────────
  checkBinaryVersion: (id) => {
    if (typeof id !== 'string') return Promise.reject(new Error('Invalid id'));
    return ipcRenderer.invoke('sevnt:checkBinaryVersion', id);
  },
  reinstallBinary: (id) => {
    if (typeof id !== 'string') return Promise.reject(new Error('Invalid id'));
    return ipcRenderer.invoke('sevnt:reinstallBinary', id);
  },

  // ── Python Engine status notifications ────────────────────────────────────
  onEngineStatus: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('sevnt:engineStatus', listener);
    return () => ipcRenderer.off('sevnt:engineStatus', listener);
  },

  // ── Main window ready signal ───────────────────────────────────────────────
  signalReady: () => ipcRenderer.send('sevnt:mainWindowReady'),
});

// ══ window.socl — Existing SOCL / SEVNT channels (mobile, pipeline, etc.) ════
contextBridge.exposeInMainWorld('socl', {
  platform: process.platform,

  // ── Pipeline ───────────────────────────────────────────────────────────────
  pickVideo:       ()        => ipcRenderer.invoke('pick-video'),
  pickSubtitle:    ()        => ipcRenderer.invoke('pick-subtitle'),
  runPipeline:     (payload) => ipcRenderer.invoke('run-pipeline', payload),
  renderEdit:      (payload) => ipcRenderer.invoke('render-edit', payload),
  batchRenderPlan: (payload) => ipcRenderer.invoke('batch-render-plan', payload),
  trackClip:       (payload) => ipcRenderer.invoke('track-clip', payload),
  renderPreview:   (payload) => ipcRenderer.invoke('render-preview', payload),
  applyCrop:       (payload) => ipcRenderer.invoke('apply-crop', payload),
  fixTypos:        (payload) => ipcRenderer.invoke('ai-fix-typos', payload),
  regenHook:       (payload) => ipcRenderer.invoke('ai-regen-hook', payload),
  saveClipMeta:    (payload) => ipcRenderer.invoke('clip:saveMeta', payload),
  saveClipEdits:   (payload) => ipcRenderer.invoke('clip:saveEdits', payload),
  cancel:          ()        => ipcRenderer.invoke('cancel-pipeline'),

  // ── Settings ───────────────────────────────────────────────────────────────
  getSettings:        ()        => ipcRenderer.invoke('get-settings'),
  setSettings:        (cfg)     => ipcRenderer.invoke('set-settings', cfg),
  testProvider:       (payload) => ipcRenderer.invoke('ai:test-provider', payload),
  secretsAvailable:   ()        => ipcRenderer.invoke('secrets:available'),
  secretsDiagnose:    ()        => ipcRenderer.invoke('secrets:diagnose'),
  pickFolder:         ()        => ipcRenderer.invoke('pick-folder'),
  setCookies:         (opts)    => ipcRenderer.invoke('set-cookies', opts),
  catalogGet:         ()        => ipcRenderer.invoke('catalog:get'),
  appInfo:            ()        => ipcRenderer.invoke('app-info'),
  fontMetrics:        (names)   => ipcRenderer.invoke('fonts:metrics', names),
  checkUpdate:        ()        => ipcRenderer.invoke('check-update'),
  openDownloadPage:   ()        => ipcRenderer.invoke('open-download-page'),
  getLicense:         ()        => ipcRenderer.invoke('sevnt:getLicenseInfo'),
  openPurchase:       ()        => ipcRenderer.invoke('license:openPurchase'),
  clearCache:         ()        => ipcRenderer.invoke('clear-cache'),
  diskUsage: (p)            => ipcRenderer.invoke('sevnt:diskUsage', p),
  diskDelete: (id)           => ipcRenderer.invoke('sevnt:diskDelete', id),
  diskOpen: (id)           => ipcRenderer.invoke('sevnt:diskOpen', id),
  listHistory:        ()        => ipcRenderer.invoke('list-history'),
  historyThumb:       (p)       => ipcRenderer.invoke('history-thumb', p),
  openOutput:         (dir)     => ipcRenderer.invoke('open-output', dir),
  revealClip:         (payload) => ipcRenderer.invoke('reveal-clip', payload),
  pathForFile:        (file)    => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },

  // ── Streaming events ────────────────────────────────────────────────────────
  onRenderProgress:  (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('render-progress', h); return () => ipcRenderer.removeListener('render-progress', h); },
  onProgress:        (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-progress', h); return () => ipcRenderer.removeListener('pipeline-progress', h); },
  onLog:             (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-log', h); return () => ipcRenderer.removeListener('pipeline-log', h); },
  onSourcePreview:   (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-source-preview', h); return () => ipcRenderer.removeListener('pipeline-source-preview', h); },
  onClipsDetected:   (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-clips-detected', h); return () => ipcRenderer.removeListener('pipeline-clips-detected', h); },
  onClipState:       (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-clip-state', h); return () => ipcRenderer.removeListener('pipeline-clip-state', h); },
  onClip:            (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-clip', h); return () => ipcRenderer.removeListener('pipeline-clip', h); },
  onDone:            (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-done', h); return () => ipcRenderer.removeListener('pipeline-done', h); },
  onError:           (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pipeline-error', h); return () => ipcRenderer.removeListener('pipeline-error', h); },
  onCatalogUpdated:  (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('catalog:updated', h); return () => ipcRenderer.removeListener('catalog:updated', h); },

  // ── Watermark ───────────────────────────────────────────────────────────────
  watermark: {
    saveAsset:   (payload) => ipcRenderer.invoke('wm:saveAsset', payload),
    deleteAsset: (p)       => ipcRenderer.invoke('wm:deleteAsset', p),
  },

  // ── Whisper ─────────────────────────────────────────────────────────────────
  // History: which files exist, and delete-to-Recycle-Bin (main process validates every path against report.json)
  history: {
    inspect:      (sessions) => ipcRenderer.invoke('history:inspect', { sessions: Array.isArray(sessions) ? sessions.map((s) => ({ dir: String((s && s.dir) || ''), clips: Array.isArray(s && s.clips) ? s.clips.map((c) => ({ index: Number(c && c.index), file: c && c.file ? String(c.file) : '', previewOnly: !!(c && c.previewOnly) })) : [] })) : [] }),
    stat:         (paths) => ipcRenderer.invoke('history:stat', { paths: Array.isArray(paths) ? paths.map(String) : [] }),
    trashClips:   (dir, items) => ipcRenderer.invoke('history:trashClips', { dir: String(dir || ''), items: Array.isArray(items) ? items.map((i) => ({ index: Number(i && i.index), file: i && i.file ? String(i.file) : '' })) : [] }),
    trashSession: (dir) => ipcRenderer.invoke('history:trashSession', { dir: String(dir || '') }),
  },
  // Telegram delivery (the bot token never leaves the main process)
  telegram: {
    status: () => ipcRenderer.invoke('telegram:status'),
    save:   (p) => ipcRenderer.invoke('telegram:save', { token: String((p && p.token) || ''), chatId: String((p && p.chatId) || '') }),
    clear:  () => ipcRenderer.invoke('telegram:clear'),
    send:   (files) => ipcRenderer.invoke('telegram:send', { files: Array.isArray(files) ? files.map((f) => ({ id: Number(f && f.id) || 0, path: String((f && f.path) || ''), caption: String((f && f.caption) || '') })) : [] }),
    onProgress: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('telegram:progress', h); return () => ipcRenderer.removeListener('telegram:progress', h); },
  },
  whisper: {
    status:     (model) => ipcRenderer.invoke('whisper:status', model),
    ensure:     (model) => ipcRenderer.invoke('whisper:ensure', model),
    remove:     ()      => ipcRenderer.invoke('whisper:remove'),
    onProgress: (cb)    => { const h = (_e, d) => cb(d); ipcRenderer.on('whisper-progress', h); return () => ipcRenderer.removeListener('whisper-progress', h); },
  },

  // ── Context model ───────────────────────────────────────────────────────────
  ctxModel: {
    status:     () => ipcRenderer.invoke('ctxmodel:status'),
    ensure:     () => ipcRenderer.invoke('ctxmodel:ensure'),
    remove:     () => ipcRenderer.invoke('ctxmodel:remove'),
    onProgress: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('ctxmodel-progress', h); return () => ipcRenderer.removeListener('ctxmodel-progress', h); },
  },

  // ── Engines ─────────────────────────────────────────────────────────────────
  engines: {
    status:     ()   => ipcRenderer.invoke('engines:status'),
    update:     (id) => ipcRenderer.invoke('engines:update', id),
    fixYoutube: ()   => ipcRenderer.invoke('engines:fixYoutube'),
    onProgress: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('engines-progress', h); return () => ipcRenderer.removeListener('engines-progress', h); },
  },

  // ── Tracker ─────────────────────────────────────────────────────────────────
  tracker: {
    isInstalled: () => ipcRenderer.invoke('tracker:isInstalled'),
    ready:       () => ipcRenderer.invoke('tracker:ready'),
    platform:    () => ipcRenderer.invoke('tracker:platform'),
    version:     () => ipcRenderer.invoke('tracker:version'),
    ensure:      () => ipcRenderer.invoke('tracker:ensure'),
    remove:      () => ipcRenderer.invoke('tracker:remove'),
    onProgress:  (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('tracker-progress', h); return () => ipcRenderer.removeListener('tracker-progress', h); },
  },

  // ── Mobile Companion ────────────────────────────────────────────────────────
  mobile: {
    start:        (opts)     => ipcRenderer.invoke('mobile:start', opts),
    stop:         ()         => ipcRenderer.invoke('mobile:stop'),
    status:       ()         => ipcRenderer.invoke('mobile:status'),
    getPairingUrl:()         => ipcRenderer.invoke('mobile:getPairingUrl'),
    generateQr:   (url)      => ipcRenderer.invoke('mobile:generateQr', url),
    approve:      ()         => ipcRenderer.invoke('mobile:approve'),
    reject:       ()         => ipcRenderer.invoke('mobile:reject'),
    syncProjects: (projects) => ipcRenderer.invoke('mobile:syncProjects', projects),
    syncStatus:   (s) => ipcRenderer.invoke('mobile:syncStatus', s),
    syncClips:    (c) => ipcRenderer.invoke('mobile:syncClips', c),
    syncHistory:  (h) => ipcRenderer.invoke('mobile:syncHistory', h),
    syncSettings: (s) => ipcRenderer.invoke('mobile:syncSettings', s),
    onRemote: (cb) => {   // startJob / cancelJob / saveCues / setSettings / refreshHistory / refreshSettings from the phone
      const chans = ['mobile:startJob', 'mobile:cancelJob', 'mobile:saveCues', 'mobile:setSettings', 'mobile:refreshHistory', 'mobile:refreshSettings', 'mobile:op'];
      const hs = chans.map((ch) => { const h = (_e, d) => cb(ch.slice(7), d); ipcRenderer.on(ch, h); return [ch, h]; });
      return () => hs.forEach(([ch, h]) => ipcRenderer.removeListener(ch, h));
    },
    onPairRequest: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('mobile:pairRequest', h);
      return () => ipcRenderer.removeListener('mobile:pairRequest', h);
    },
    onConnected: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('mobile:connected', h);
      return () => ipcRenderer.removeListener('mobile:connected', h);
    },
    onDisconnected: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on('mobile:disconnected', h);
      return () => ipcRenderer.removeListener('mobile:disconnected', h);
    },
  },
});

// Notify main process that this window is the main UI window
ipcRenderer.send('sevnt:mainWindowReady');
