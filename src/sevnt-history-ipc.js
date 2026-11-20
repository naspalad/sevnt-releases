// SEVNT Studio — History: keep the list in step with the folders on disk, and delete to the Recycle Bin.
//
// How the files of one clip are laid out (see exportToUserFolder in pipeline-inverse-v1.js):
//   <session>/data/report.json          the batch record (clips[].file, .rawFile …)
//   <session>/subtitle|edited|raw/…     the files the app itself renders and re-edits
//   <session>/hasil/NN-title.mp4        the ready-to-upload COPY the user sees in Explorer (NN = clip number)
//   <export folder>/<session>/hasil/…   the same, when a custom export folder is set (report.exportedTo)
// History used to look only at report.clips[].file, so deleting the hasil copy in Explorer changed nothing, and
// deleting in the app left the hasil copy behind. Now "this clip exists" means: its delivered copy exists.
//
// Safety (the renderer is not trusted with arbitrary paths):
//   - Nothing is ever deleted permanently: everything goes to the OS Recycle Bin (shell.trashItem).
//   - A batch folder is only touched when it holds a report.json written by this app.
//   - A clip file is only touched when it is listed in THAT report (file / rawFile) or is that clip's delivered
//     copy (video file named "NN-…" inside the session's own hasil folder / its recorded export folder).
//   - Deleted clips stay in report.json flagged `deleted: true` (their position is the clip number NN, so the
//     remaining clips keep matching their hasil copies).

'use strict';

const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const SESSION_SUBDIRS = new Set(['hasil', 'raw', 'subtitle', 'edited', 'data', 'burn-edited', 'crop-biasa', 'crop-gaming', 'transkrip', 'efek', 'preview']);

const abs = (p) => typeof p === 'string' && p.length > 3 && path.isAbsolute(p);
const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

// The folder the renderer names is normally the session root; if it is one of the session's own sub-folders,
// step up one level. Returns { file, json, root } or null.
function readReport(dir) {
  if (!abs(dir)) return null;
  const SF = require('./session-files');
  const candidates = [path.resolve(dir)];
  if (SESSION_SUBDIRS.has(path.basename(path.resolve(dir)).toLowerCase())) candidates.push(path.dirname(path.resolve(dir)));
  for (const root of candidates) {
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      // the app keeps report.json in <session>/data/ (older sessions: the session root) — ask it where, same as everywhere else
      const file = SF.reportPathFor(root);
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!json || typeof json !== 'object') continue;
      return { file, json, root };
    } catch { /* try the next candidate */ }
  }
  return null;
}

function writeReport(file, json) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Folders that hold delivered copies of this session's clips.
function deliveredDirs(rep) {
  const dirs = [path.join(rep.root, 'hasil')];
  const e = rep.json.exportedTo;
  if (typeof e === 'string' && abs(e)) dirs.push(e);
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}
function videosIn(dir) {
  try { return fs.readdirSync(dir).filter((n) => VIDEO_EXT.test(n)).map((n) => path.join(dir, n)); } catch { return []; }
}
// Delivered copies of clip #index (NN-… in a hasil folder), newest first.
function copiesFor(dirs, index) {
  const nn = String(index + 1).padStart(2, '0');
  const out = [];
  for (const d of dirs) {
    for (const p of videosIn(d)) {
      if (!path.basename(p).startsWith(nn + '-')) continue;
      let t = 0; try { t = fs.statSync(p).mtimeMs; } catch { /* vanished */ }
      out.push({ p, t });
    }
  }
  return out.sort((a, b) => b.t - a.t).map((x) => x.p);
}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// Per session: does the folder still exist, and for each clip which file stands for it right now?
//   payload: { sessions: [{ dir, clips: [{ index, file, previewOnly }] }] }
//   result:  { [dir]: { exists, delivered, clips: { [index]: { exists, file, size } } } }
ipcMain.handle('history:inspect', (_e, payload) => {
  const sessions = Array.isArray(payload && payload.sessions) ? payload.sessions.slice(0, 500) : [];
  const out = {};
  for (const s of sessions) {
    const dir = s && s.dir;
    const res = { exists: false, delivered: false, clips: {} };
    out[dir] = res;
    const rep = readReport(dir);
    let dirOk = false;
    try { dirOk = abs(dir) && fs.statSync(dir).isDirectory(); } catch { dirOk = false; }
    if (!dirOk) continue;                       // the whole batch folder was removed
    res.exists = true;
    if (!rep) {                                  // no readable report: fall back to the plain file check
      for (const c of (Array.isArray(s.clips) ? s.clips : [])) { const f = c && c.file; res.clips[c.index] = f ? { exists: isFile(f), file: f, size: sizeOf(f) } : { exists: true, file: null, size: 0 }; }
      continue;
    }
    const dirs = deliveredDirs(rep);
    // "delivered mode": this session has handed clips out to its hasil folder, so a final clip with no copy there
    // was removed by the user (a half-empty hasil folder is not "never exported")
    const delivered = !!(typeof rep.json.exportedTo === 'string' && rep.json.exportedTo) || dirs.some((d) => videosIn(d).length > 0);
    res.delivered = delivered;
    for (const c of (Array.isArray(s.clips) ? s.clips : [])) {
      const i = Number(c && c.index);
      if (!Number.isInteger(i)) continue;
      const copies = copiesFor(dirs, i);
      if (copies.length) { res.clips[i] = { exists: true, file: copies[0], size: sizeOf(copies[0]) }; continue; }
      if (!c.file) { res.clips[i] = { exists: true, file: null, size: 0 }; continue; }       // a candidate that was never rendered
      if (delivered && !c.previewOnly) { res.clips[i] = { exists: false, file: null, size: 0 }; continue; }   // its copy is gone
      res.clips[i] = isFile(c.file) ? { exists: true, file: c.file, size: sizeOf(c.file) } : { exists: false, file: null, size: 0 };
    }
  }
  return out;
});

// Kept for older callers: which files exist and how big they are.
ipcMain.handle('history:stat', (_e, payload) => {
  const paths = Array.isArray(payload && payload.paths) ? payload.paths.slice(0, 5000) : [];
  const out = {};
  for (const p of paths) { if (abs(p) && isFile(p)) out[p] = sizeOf(p); }
  return out;
});

// items: [{ index, file }] of one batch. Moves every file of those clips to the Recycle Bin:
// the report's file / rawFile AND the delivered copies (hasil/NN-…). Returns { ok, trashed, removed, failed }.
ipcMain.handle('history:trashClips', async (_e, payload) => {
  const rep = readReport(payload && payload.dir);
  if (!rep) return { ok: false, error: 'Folder ini bukan batch SEVNT (report.json tidak ditemukan).', trashed: 0, failed: [] };
  const clips = Array.isArray(rep.json.clips) ? rep.json.clips : [];
  const dirs = deliveredDirs(rep);
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 500) : [];
  const failed = [];
  const done = new Set();
  let trashed = 0;
  for (const it of items) {
    const i = Number(it && it.index);
    const c = Number.isInteger(i) ? clips[i] : null;
    if (!c) { failed.push({ index: i, error: 'Klip tidak ada di report.' }); continue; }
    const own = [c.file, c.rawFile].filter((p) => typeof p === 'string' && p);
    // a file named by the renderer must be one the report lists, or one of this clip's delivered copies
    const copies = copiesFor(dirs, i);
    if (it.file && ![...own, ...copies].some((w) => same(w, it.file))) { failed.push({ index: i, error: 'Path tidak cocok dengan report.' }); continue; }
    let ok = true;
    for (const p of [...new Set([...own, ...copies].map((x) => path.resolve(x)))]) {
      if (!abs(p) || !VIDEO_EXT.test(p) || !isFile(p)) continue;
      try { await shell.trashItem(p); trashed++; } catch (e) { ok = false; failed.push({ index: i, error: (e && e.message) || 'gagal dipindah ke Recycle Bin' }); }
    }
    if (ok) done.add(i);
  }
  if (done.size) {
    try {
      done.forEach((i) => { clips[i].deleted = true; });      // keep the position: it is the clip number NN of the remaining copies
      writeReport(rep.file, rep.json);
    } catch (e) { return { ok: false, error: 'File dihapus tapi report gagal diperbarui: ' + ((e && e.message) || e), trashed, failed }; }
  }
  return { ok: failed.length === 0, trashed, removed: done.size, failed };
});

// Whole batch: the session folder, plus delivered copies and clip files that live outside it.
ipcMain.handle('history:trashSession', async (_e, payload) => {
  const rep = readReport(payload && payload.dir);
  if (!rep) return { ok: false, error: 'Folder ini bukan batch SEVNT (report.json tidak ditemukan).' };
  const sessionDir = rep.root;
  const parsed = path.parse(path.resolve(sessionDir));
  if (parsed.dir === parsed.root || path.resolve(sessionDir) === parsed.root) return { ok: false, error: 'Folder terlalu dekat ke root drive — dibatalkan demi keamanan.' };
  const inside = (p) => { const rel = path.relative(path.resolve(sessionDir), path.resolve(p)); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const clips = Array.isArray(rep.json.clips) ? rep.json.clips : [];
  const dirs = deliveredDirs(rep);
  const outside = [];
  clips.forEach((c, i) => {
    for (const p of [c && c.file, c && c.rawFile, ...copiesFor(dirs, i)]) {
      if (typeof p === 'string' && abs(p) && VIDEO_EXT.test(p) && !inside(p)) outside.push(p);
    }
  });
  let trashed = 0;
  const failed = [];
  for (const p of [...new Set(outside.map((x) => path.resolve(x)))]) {
    try { if (isFile(p)) { await shell.trashItem(p); trashed++; } } catch (e) { if (e && e.code !== 'ENOENT') failed.push((e && e.message) || p); }
  }
  try { await shell.trashItem(path.resolve(sessionDir)); trashed++; } catch (e) { return { ok: false, error: (e && e.message) || 'gagal dipindah ke Recycle Bin', trashed, failed }; }
  return { ok: failed.length === 0, trashed, failed };
});
