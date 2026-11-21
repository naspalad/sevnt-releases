'use strict';

const { contextBridge } = require('electron');
const calls = [];
const record = (name, value) => { calls.push({ name, value: value ?? null }); };

const asyncResult = (name, value) => async (...args) => {
  record(name, args[0]);
  return typeof value === 'function' ? value(...args) : value;
};
const eventNoop = () => () => {};

const socl = {
  platform: process.platform,
  pickVideo: asyncResult('pickVideo', null),
  pickSubtitle: asyncResult('pickSubtitle', null),
  runPipeline: asyncResult('runPipeline', { ok: true, qa: true, clips: [] }),
  renderEdit: asyncResult('renderEdit', { ok: true, output: null }),
  batchRenderPlan: asyncResult('batchRenderPlan', { concurrency: 1 }),
  trackClip: asyncResult('trackClip', { ok: true }),
  renderPreview: asyncResult('renderPreview', { ok: true }),
  applyCrop: asyncResult('applyCrop', { ok: true }),
  fixTypos: asyncResult('fixTypos', { ok: true, text: '' }),
  regenHook: asyncResult('regenHook', { ok: true, hook: '' }),
  saveClipMeta: asyncResult('saveClipMeta', { ok: true }),
  saveClipEdits: asyncResult('saveClipEdits', { ok: true }),
  cancel: asyncResult('cancel', { ok: true }),
  getSettings: asyncResult('getSettings', {}),
  setSettings: asyncResult('setSettings', (args) => args[0] || {}),
  testProvider: asyncResult('testProvider', { ok: true }),
  secretsAvailable: asyncResult('secretsAvailable', []),
  secretsDiagnose: asyncResult('secretsDiagnose', {}),
  pickFolder: asyncResult('pickFolder', null),
  setCookies: asyncResult('setCookies', { ok: true }),
  catalogGet: asyncResult('catalogGet', []),
  appInfo: asyncResult('appInfo', { version: 'QA', platform: process.platform, arch: process.arch }),
  fontMetrics: asyncResult('fontMetrics', {}),
  checkUpdate: asyncResult('checkUpdate', { ok: true, hasUpdate: false }),
  openDownloadPage: asyncResult('openDownloadPage', { ok: true }),
  getLicense: asyncResult('getLicense', null),
  openPurchase: asyncResult('openPurchase', { ok: true }),
  clearCache: asyncResult('clearCache', { ok: true }),
  diskUsage: asyncResult('diskUsage', { items: [], total: 0 }),
  diskDelete: asyncResult('diskDelete', { ok: true }),
  diskOpen: asyncResult('diskOpen', { ok: true }),
  listHistory: asyncResult('listHistory', []),
  historyThumb: asyncResult('historyThumb', null),
  openOutput: asyncResult('openOutput', { ok: true }),
  revealClip: asyncResult('revealClip', { ok: true }),
  pathForFile: () => '',
  onRenderProgress: eventNoop, onProgress: eventNoop, onLog: eventNoop,
  onSourcePreview: eventNoop, onClipsDetected: eventNoop, onClipState: eventNoop,
  onClip: eventNoop, onDone: eventNoop, onError: eventNoop, onCatalogUpdated: eventNoop,
  watermark: {
    saveAsset: asyncResult('watermark.saveAsset', { path: '/tmp/qa-watermark.png', filename: 'qa.png', ext: 'png', bytes: 1 }),
    deleteAsset: asyncResult('watermark.deleteAsset', { ok: true }),
  },
  history: {
    inspect: asyncResult('history.inspect', []), stat: asyncResult('history.stat', {}),
    trashClips: asyncResult('history.trashClips', { ok: true }),
    trashSession: asyncResult('history.trashSession', { ok: true }),
  },
  telegram: { status: asyncResult('telegram.status', {}), save: asyncResult('telegram.save', { ok: true }), clear: asyncResult('telegram.clear', { ok: true }), send: asyncResult('telegram.send', { ok: true }), onProgress: eventNoop },
  whisper: { status: asyncResult('whisper.status', { installed: false }), ensure: asyncResult('whisper.ensure', { ok: true }), remove: asyncResult('whisper.remove', { ok: true }), onProgress: eventNoop },
  ctxModel: { status: asyncResult('ctxModel.status', { installed: false }), ensure: asyncResult('ctxModel.ensure', { ok: true }), remove: asyncResult('ctxModel.remove', { ok: true }), onProgress: eventNoop },
  engines: { status: asyncResult('engines.status', {}), update: asyncResult('engines.update', { ok: true }), fixYoutube: asyncResult('engines.fixYoutube', { ok: true }), onProgress: eventNoop },
  tracker: { isInstalled: asyncResult('tracker.isInstalled', false), ready: asyncResult('tracker.ready', false), platform: asyncResult('tracker.platform', process.platform), version: asyncResult('tracker.version', null), ensure: asyncResult('tracker.ensure', { ok: true }), remove: asyncResult('tracker.remove', { ok: true }), onProgress: eventNoop },
  mobile: { start: asyncResult('mobile.start', { ok: true }), stop: asyncResult('mobile.stop', { ok: true }), status: asyncResult('mobile.status', { running: false, connected: false }), getPairingUrl: asyncResult('mobile.getPairingUrl', null), generateQr: asyncResult('mobile.generateQr', ''), approve: asyncResult('mobile.approve', { ok: true }), reject: asyncResult('mobile.reject', { ok: true }), syncProjects: asyncResult('mobile.syncProjects', { ok: true }), syncStatus: asyncResult('mobile.syncStatus', { ok: true }), syncClips: asyncResult('mobile.syncClips', { ok: true }), syncHistory: asyncResult('mobile.syncHistory', { ok: true }), syncSettings: asyncResult('mobile.syncSettings', { ok: true }), onRemote: eventNoop, onPairRequest: eventNoop, onConnected: eventNoop, onDisconnected: eventNoop },
};

const sevnt = {
  platform: process.platform, isDesktop: true,
  licenseStatus: asyncResult('sevnt.licenseStatus', { valid: false, reason: 'qa-mock' }),
  licenseActivate: asyncResult('sevnt.licenseActivate', { ok: false, error: 'qa-disabled' }),
  licenseDeactivate: asyncResult('sevnt.licenseDeactivate', { ok: true }),
  applyCaption: asyncResult('sevnt.applyCaption', { ok: true }),
  pickFolder: asyncResult('sevnt.pickFolder', null),
  openOutputFolder: asyncResult('sevnt.openOutputFolder', { ok: true }),
  openFolder: asyncResult('sevnt.openFolder', { ok: true }),
  getAppVersion: asyncResult('sevnt.getAppVersion', 'QA'),
  checkUpdate: asyncResult('sevnt.checkUpdate', { hasUpdate: false }),
  checkBinaryVersion: asyncResult('sevnt.checkBinaryVersion', { status: 'unknown' }),
  reinstallBinary: asyncResult('sevnt.reinstallBinary', { ok: false, reason: 'qa-disabled' }),
  onEngineStatus: eventNoop,
  signalReady: () => record('sevnt.signalReady'),
};

contextBridge.exposeInMainWorld('socl', socl);
contextBridge.exposeInMainWorld('sevnt', sevnt);
contextBridge.exposeInMainWorld('qaBridge', {
  getCalls: () => calls.slice(),
  resetCalls: () => { calls.length = 0; },
});
