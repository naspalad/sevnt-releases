// SEVNT Studio — Settings > Disk Usage.
// Measures what the app keeps on disk (read-only) and removes ONLY the parts that
// the app downloads again by itself (Smart Track runtime, offline caption model,
// context model, helper binaries). Sessions/clips and settings are never deleted
// here: sessions are the user's work (History deletes them to the Recycle Bin).

'use strict';

const { ipcMain, app, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Chromium keeps these inside userData; they are rebuilt by itself and are not
// the app's own data, so they are reported as one "app cache" line.
const CHROMIUM_CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'GPUPersistentCache', 'Shared Dictionary',
  'blob_storage', 'Service Worker', 'shared_proto_db', 'VideoDecodeStats',
];

// Total bytes under p. Async + bounded concurrency so a folder with tens of
// thousands of files (the Python runtime) never freezes the app. Symlinks are
// counted as links, never followed.
async function dirSize(p, deadline) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    if (Date.now() > deadline) return { bytes: total, partial: true };
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) files.push(full);
    }
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(files.slice(i, i + 64).map((f) => fsp.stat(f).then((s) => s.size, () => 0)));
      for (const s of sizes) total += s;
    }
  }
  return { bytes: total, partial: false };
}

async function sizeOf(p, deadline) {
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return { bytes: 0, partial: false };
    if (st.isFile()) return { bytes: st.size, partial: false };
    if (st.isDirectory()) return await dirSize(p, deadline);
  } catch { /* missing */ }
  return { bytes: 0, partial: false };
}

const abs = (p) => typeof p === 'string' && p.length > 3 && path.isAbsolute(p);
const SESSION_NAME = /^(?:socl|sevnt)-\d{4}-\d{2}-\d{2}T/;

// Only folders that look like a session this app made (named like one AND holding
// its own report.json) are counted, so a stray path from the renderer measures nothing.
async function isSessionDir(dir) {
  if (!abs(dir) || !SESSION_NAME.test(path.basename(dir))) return false;
  try { return (await fsp.stat(path.join(dir, 'data', 'report.json'))).isFile(); } catch { return false; }
}

function paths() {
  const ud = app.getPath('userData');
  return {
    userData: ud,
    tracker: path.join(ud, 'tracker-runtime'),
    whisper: path.join(ud, 'whisper'),
    context: path.join(ud, 'context-model'),
    bins: path.join(ud, 'bin'),
    projects: path.join(ud, 'sevnt-studio', 'projects'),
  };
}

ipcMain.handle('sevnt:diskUsage', async (_e, payload) => {
  const P = paths();
  try { fs.writeFileSync(require('path').join(require('os').tmpdir(), 'sevnt-disk-debug.log'), JSON.stringify({ at: new Date().toISOString(), userData: P.userData, trackerDir: P.tracker, trackerExists: fs.existsSync(P.tracker), name: app.getName(), packaged: app.isPackaged, argv: process.argv.slice(0, 3) }) + String.fromCharCode(10)); } catch {} // [TEMP-DIAG]
  const deadline = Date.now() + 25000;
  const sessionDirs = Array.isArray(payload && payload.sessionDirs) ? payload.sessionDirs.slice(0, 2000) : [];

  let sessions = 0, partial = false;
  const valid = [];
  for (const d of sessionDirs) if (await isSessionDir(d)) valid.push(d);
  for (let i = 0; i < valid.length; i += 4) {
    const rs = await Promise.all(valid.slice(i, i + 4).map((d) => sizeOf(d, deadline)));
    for (const r of rs) { sessions += r.bytes; partial = partial || r.partial; }
  }

  const [tracker, whisper, context, bins, projects] = await Promise.all(
    [P.tracker, P.whisper, P.context, P.bins, P.projects].map((p) => sizeOf(p, deadline)));

  let appCache = 0;
  for (const n of CHROMIUM_CACHE_DIRS) {
    const r = await sizeOf(path.join(P.userData, n), deadline);
    appCache += r.bytes; partial = partial || r.partial;
  }
  const logs = (await sizeOf(path.join(P.userData, 'audit.log'), deadline)).bytes
    + (await sizeOf(path.join(P.userData, 'logs'), deadline)).bytes;

  // Everything else under userData (settings, database, watermarks, license…).
  const whole = await sizeOf(P.userData, deadline);
  const counted = tracker.bytes + whisper.bytes + context.bytes + bins.bytes + projects.bytes + appCache + logs;
  const other = Math.max(0, whole.bytes - counted);

  partial = partial || tracker.partial || whisper.partial || context.partial || bins.partial || projects.partial || whole.partial;
  const items = [
    { id: 'sessions', bytes: sessions, count: valid.length },
    { id: 'projects', bytes: projects.bytes },
    { id: 'tracker', bytes: tracker.bytes },
    { id: 'whisper', bytes: whisper.bytes },
    { id: 'context', bytes: context.bytes },
    { id: 'bins', bytes: bins.bytes },
    { id: 'appcache', bytes: appCache },
    { id: 'logs', bytes: logs },
    { id: 'other', bytes: other },
  ];
  return { items, total: items.reduce((s, i) => s + i.bytes, 0), partial };
});

// Removes only what the app re-downloads on demand.
ipcMain.handle('sevnt:diskDelete', async (_e, id) => {
  const P = paths();
  try {
    if (id === 'tracker') require('./tracker-bundle').remove();
    else if (id === 'whisper') require('./whisper-bundle').remove();
    else if (id === 'context') require('./context-model/bundle').remove();
    else if (id === 'bins') await fsp.rm(P.bins, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    else return { ok: false, error: 'not_deletable' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'delete_failed' };
  }
});

ipcMain.handle('sevnt:diskOpen', async (_e, id) => {
  const P = paths();
  const target = ({ tracker: P.tracker, whisper: P.whisper, context: P.context, bins: P.bins, projects: P.projects, logs: P.userData, appcache: P.userData, other: P.userData })[id];
  if (!target) return { ok: false };
  try {
    const dir = fs.existsSync(target) ? target : P.userData;
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || null };
  } catch (e) { return { ok: false, error: e.message }; }
});
