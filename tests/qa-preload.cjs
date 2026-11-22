'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const qaVideo = path.join(__dirname, 'fixtures', 'qa-source.mp4');
const qaTranscript = path.join(__dirname, 'fixtures', 'qa-transcript.srt');
const qaHistoryDir = path.join(os.tmpdir(), 'sevnt-qa-history-' + process.pid);
const qaHistoryReport = {
  createdAt: '2026-01-15T10:00:00.000Z',
  source: 'QA History Session',
  inputPath: qaVideo,
  cfg: { format: 'face', resolution: '1080p' },
  clips: [{
    title: 'QA History Clip',
    hook: 'QA history fixture',
    start: 0,
    end: 4,
    dur: 4,
    score: 9.2,
    isHot: true,
    file: qaVideo,
    rawFile: qaVideo,
    srcVideo: qaVideo,
    previewOnly: false,
  }],
};
fs.mkdirSync(qaHistoryDir, { recursive: true });
fs.writeFileSync(path.join(qaHistoryDir, 'report.json'), JSON.stringify(qaHistoryReport, null, 2));
if (!fs.existsSync(qaVideo) || !fs.statSync(qaVideo).size) {
  throw new Error('Prepared QA video fixture is missing: ' + qaVideo);
}
if (!fs.existsSync(qaTranscript) || !fs.statSync(qaTranscript).size) {
  throw new Error('QA transcript fixture is missing: ' + qaTranscript);
}

// QA starts from a fresh temporary Electron profile for each test. Mark the
// first-run tutorial as already completed before renderer scripts execute.
try { window.localStorage.setItem('sevnt.tour.v3', '1'); } catch {}

const { contextBridge } = require('electron');
const calls = [];
const listeners = new Map();
let renderSequence = 0;
let qaSettings = {};
const qaPipelineDiagnostics = { started: 0, detected: 0, completed: 0, renders: [], errors: [] };
const record = (name, value) => { calls.push({ name, value: value ?? null }); };
const asyncResult = (name, value) => async (...args) => {
  record(name, args[0]);
  return typeof value === 'function' ? value(...args) : value;
};
const subscribe = (eventName) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const bucket = listeners.get(eventName) || new Set();
  bucket.add(callback);
  listeners.set(eventName, bucket);
  return () => bucket.delete(callback);
};
const emit = (eventName, value) => {
  for (const callback of [...(listeners.get(eventName) || [])]) {
    try { callback(value); } catch (error) { console.error('[QA event]', eventName, error); }
  }
};

function renderFixture(payload = {}) {
  const ffmpeg = process.env.SEVNT_QA_FFMPEG_BIN || require('ffmpeg-static');
  const input = payload.srcVideo || payload.clipFile || qaVideo;
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('QA FFmpeg binary is unavailable: ' + ffmpeg);
  if (!fs.existsSync(input)) throw new Error('QA render input is missing: ' + input);
  const start = Math.max(0, Number(payload.clipStart) || 0);
  const end = Number(payload.clipEnd);
  const duration = Number.isFinite(end) && end > start ? Math.min(6, end - start) : 4;
  const output = path.join(os.tmpdir(), 'sevnt-qa-render-' + process.pid + '-' + (++renderSequence) + '.mp4');
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start), '-i', input, '-t', String(duration),
    '-vf', 'scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart', output,
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg QA render failed');
  if (!fs.existsSync(output) || fs.statSync(output).size < 1000) {
    throw new Error('FFmpeg did not produce a usable QA video');
  }
  record('ffmpegRender', { input, output, start, duration });
  return { ok: true, file: output, fileName: path.basename(output) };
}

async function runQaPipeline(payload = {}) {
  record('runPipeline', payload);
  qaPipelineDiagnostics.started++;
  const source = payload.source && fs.existsSync(payload.source) ? payload.source : qaVideo;
  const candidates = [
    { candidateId: 'qa-clip-1', title: 'QA Highlight One', score: 9.4, isHot: true, category: 'highlight', start: 0, end: 4, dur: 4, srcVideo: source, state: 'rendering' },
    { candidateId: 'qa-clip-2', title: 'QA Highlight Two', score: 8.7, isHot: true, category: 'highlight', start: 0, end: 4, dur: 4, srcVideo: source, state: 'rendering' },
  ];
  emit('sourcePreview', { phase: 'local', srcVideo: source, file: source });
  emit('clipsDetected', candidates);
  qaPipelineDiagnostics.detected += candidates.length;
  const completed = [];
  for (const candidate of candidates) {
    emit('clipState', { candidateId: candidate.candidateId, state: 'rendering', detail: 'QA fixture clip' });
    let rendered;
    try {
      rendered = renderFixture({ srcVideo: source, clipStart: candidate.start, clipEnd: candidate.end });
      qaPipelineDiagnostics.renders.push({ candidateId: candidate.candidateId, ok: true, file: rendered.file, exists: fs.existsSync(rendered.file), size: fs.existsSync(rendered.file) ? fs.statSync(rendered.file).size : 0 });
    } catch (error) {
      const detail = { candidateId: candidate.candidateId, message: error?.message || String(error), stack: error?.stack || null };
      qaPipelineDiagnostics.errors.push(detail);
      emit('error', detail);
      throw error;
    }
    const clip = {
      ...candidate,
      state: 'ready',
      file: rendered.file,
      rawFile: rendered.file,
      srcVideo: source,
      thumbnail: null,
      words: [
        { text: 'SEVNT', start: 0.2, end: 0.8 },
        { text: 'QA', start: 0.9, end: 1.4 },
        { text: 'highlight', start: 1.5, end: 2.2 },
      ],
      cueWords: [
        { text: 'SEVNT', start: 0.2, end: 0.8 },
        { text: 'QA', start: 0.9, end: 1.4 },
        { text: 'highlight', start: 1.5, end: 2.2 },
      ],
      // The fixture has a real FFmpeg output file and represents a completed,
      // final render (not a fast-mode preview). The gallery's Rendered filter
      // uses isFinalRendered(file && !previewOnly), so make that state explicit.
      previewOnly: false,
      subsBurned: false,
      titlesBurned: false,
      isHot: true,
    };
    completed.push(clip);
    emit('clip', clip);
    qaPipelineDiagnostics.completed++;
  }
  emit('done', { clips: completed });
  return { ok: true, qa: true, clips: completed };
}

const eventMethods = {
  onRenderProgress: 'renderProgress', onProgress: 'progress', onLog: 'log',
  onSourcePreview: 'sourcePreview', onClipsDetected: 'clipsDetected',
  onClipState: 'clipState', onClip: 'clip', onDone: 'done', onError: 'error',
  onCatalogUpdated: 'catalogUpdated',
};

const socl = {
  platform: process.platform,
  pickVideo: asyncResult('pickVideo', qaVideo),
  pickSubtitle: asyncResult('pickSubtitle', qaTranscript),
  runPipeline: runQaPipeline,
  renderEdit: asyncResult('renderEdit', (payload) => renderFixture(payload)),
  batchRenderPlan: asyncResult('batchRenderPlan', { concurrency: 1 }),
  trackClip: asyncResult('trackClip', { ok: true }),
  renderPreview: asyncResult('renderPreview', (payload) => renderFixture(payload)),
  applyCrop: asyncResult('applyCrop', (payload) => renderFixture(payload)),
  fixTypos: asyncResult('fixTypos', { ok: true, text: '' }),
  regenHook: asyncResult('regenHook', { ok: true, hook: '' }),
  saveClipMeta: asyncResult('saveClipMeta', { ok: true }),
  saveClipEdits: asyncResult('saveClipEdits', { ok: true }),
  cancel: asyncResult('cancel', { ok: true }),
  getSettings: asyncResult('getSettings', () => ({ ...qaSettings })),
  setSettings: asyncResult('setSettings', (args) => { qaSettings = { ...qaSettings, ...(args[0] || {}) }; return { ...qaSettings }; }),
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
  listHistory: asyncResult('listHistory', [{ jobId: 'qa-history-session', dir: qaHistoryDir, report: qaHistoryReport }]),
  historyThumb: asyncResult('historyThumb', null),
  openOutput: asyncResult('openOutput', { ok: true }),
  revealClip: asyncResult('revealClip', { ok: true }),
  pathForFile: () => '',
  watermark: {
    saveAsset: asyncResult('watermark.saveAsset', (payload) => { const filename = String(payload && payload.filename || ''); const ext = path.extname(filename).toLowerCase(); if (!['.png', '.webp', '.jpg', '.jpeg'].includes(ext)) return { error: 'unsupported_file_type' }; return { path: path.join(os.tmpdir(), 'qa-watermark.png'), filename, ext: ext.slice(1), bytes: payload && payload.bytes ? payload.bytes.length : 1 }; }),
    deleteAsset: asyncResult('watermark.deleteAsset', { ok: true }),
  },
  history: {
    inspect: asyncResult('history.inspect', (payload) => Object.fromEntries((payload.sessions || []).map(session => [session.dir, { exists: true, clips: { 0: { exists: true, file: qaVideo, size: fs.statSync(qaVideo).size } } }]))),
    stat: asyncResult('history.stat', {}),
    trashClips: asyncResult('history.trashClips', { ok: true }),
    trashSession: asyncResult('history.trashSession', { ok: true }),
  },
  telegram: { status: asyncResult('telegram.status', {}), save: asyncResult('telegram.save', { ok: true }), clear: asyncResult('telegram.clear', { ok: true }), send: asyncResult('telegram.send', { ok: true }), onProgress: subscribe('telegramProgress') },
  whisper: { status: asyncResult('whisper.status', { installed: false }), ensure: asyncResult('whisper.ensure', { ok: true }), remove: asyncResult('whisper.remove', { ok: true }), onProgress: subscribe('whisperProgress') },
  ctxModel: { status: asyncResult('ctxModel.status', { installed: false }), ensure: asyncResult('ctxModel.ensure', { ok: true }), remove: asyncResult('ctxModel.remove', { ok: true }), onProgress: subscribe('ctxModelProgress') },
  engines: { status: asyncResult('engines.status', {}), update: asyncResult('engines.update', { ok: true }), fixYoutube: asyncResult('engines.fixYoutube', { ok: true }), onProgress: subscribe('engineProgress') },
  tracker: { isInstalled: asyncResult('tracker.isInstalled', false), ready: asyncResult('tracker.ready', false), platform: asyncResult('tracker.platform', process.platform), version: asyncResult('tracker.version', null), ensure: asyncResult('tracker.ensure', { ok: true }), remove: asyncResult('tracker.remove', { ok: true }), onProgress: subscribe('trackerProgress') },
  mobile: { start: asyncResult('mobile.start', { ok: true }), stop: asyncResult('mobile.stop', { ok: true }), status: asyncResult('mobile.status', { running: false, connected: false }), getPairingUrl: asyncResult('mobile.getPairingUrl', null), generateQr: asyncResult('mobile.generateQr', ''), approve: asyncResult('mobile.approve', { ok: true }), reject: asyncResult('mobile.reject', { ok: true }), syncProjects: asyncResult('mobile.syncProjects', { ok: true }), syncStatus: asyncResult('mobile.syncStatus', { ok: true }), syncClips: asyncResult('mobile.syncClips', { ok: true }), syncHistory: asyncResult('mobile.syncHistory', { ok: true }), syncSettings: asyncResult('mobile.syncSettings', { ok: true }), onRemote: subscribe('mobileRemote'), onPairRequest: subscribe('mobilePairRequest'), onConnected: subscribe('mobileConnected'), onDisconnected: subscribe('mobileDisconnected') },
};

for (const [method, eventName] of Object.entries(eventMethods)) socl[method] = subscribe(eventName);

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
  onEngineStatus: subscribe('sevntEngineStatus'),
  signalReady: () => record('sevnt.signalReady'),
};

contextBridge.exposeInMainWorld('socl', socl);
contextBridge.exposeInMainWorld('sevnt', sevnt);
contextBridge.exposeInMainWorld('qaBridge', {
  getCalls: () => calls.slice(),
  resetCalls: () => { calls.length = 0; },
  getPipelineDiagnostics: () => JSON.parse(JSON.stringify(qaPipelineDiagnostics)),
});
