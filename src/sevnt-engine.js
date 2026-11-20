'use strict';
// Electron-side owner of the local Python engine (see AUDIT/16_INTEGRATION_ARCHITECTURE.md).
// Starts it automatically after the window is up, reports status to the renderer, stops it on quit.
// Nothing here may block or crash app start: a missing/failed engine only means "unavailable" and the pipeline
// keeps using whisper.cpp.

const fs = require('fs');
const path = require('path');
const { EngineSupervisor } = require('./engine/engine-supervisor');

let supervisor = null;
let initialised = false;

function platformKey() { return `${process.platform}-${process.arch}`; }

/** Where the Python runtime lives. No path outside this app, no system Python. */
function resolveRuntime(app) {
  const exe = process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3');
  const candidates = [];
  if (process.env.SEVNT_ENGINE_PYTHON) candidates.push({ python: process.env.SEVNT_ENGINE_PYTHON, source: 'env' });   // dev/test override
  if (process.resourcesPath) candidates.push({ python: path.join(process.resourcesPath, 'engine-runtime', platformKey(), exe), source: 'packaged' });
  candidates.push({ python: path.join(__dirname, '..', 'build', 'engine-runtime', platformKey(), exe), source: 'build' });
  const found = candidates.find((c) => fs.existsSync(c.python));
  const packagedEngine = process.resourcesPath && path.join(process.resourcesPath, 'engine');
  const engineDir = packagedEngine && fs.existsSync(path.join(packagedEngine, 'sevnt_engine')) ? packagedEngine : path.join(__dirname, '..', 'engine');
  return { python: found ? found.python : null, source: found ? found.source : null, engineDir };
}

function ffmpegPaths() {
  const unpack = (p) => (p ? p.replace('app.asar', 'app.asar.unpacked') : p);
  let ffmpeg = null, ffprobe = null;
  try { ffmpeg = unpack(require('ffmpeg-static')); } catch { /* optional */ }
  try { ffprobe = unpack(require('@ffprobe-installer/ffprobe').path); } catch { /* optional */ }
  return { ffmpeg, ffprobe };
}

function broadcast(electron, payload) {
  try {
    for (const w of electron.BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('sevnt:engineStatus', payload);
  } catch { /* window gone */ }
}

function init(electron) {
  if (initialised) return supervisor;
  initialised = true;
  const { app, ipcMain } = electron;
  const userData = app.getPath('userData');
  const rt = resolveRuntime(app);
  const bins = ffmpegPaths();
  supervisor = new EngineSupervisor({
    pythonPath: rt.python || path.join(userData, '__no_runtime__'),
    engineDir: rt.engineDir,
    dataDir: path.join(userData, 'sevnt-studio'),
    modelsDir: process.env.SEVNT_ENGINE_MODELS_DIR || path.join(userData, 'engine-models'),
    ffmpegPath: bins.ffmpeg, ffprobePath: bins.ffprobe,
    lockFile: path.join(userData, 'engine.lock'),
    log: (m) => { try { console.log(`[SEVNT] ${m}`); } catch { /* ignore */ } },
  });
  supervisor.on('status', (st) => broadcast(electron, { status: st.state === 'ready' ? 'ready' : st.state, port: st.port, error: st.error }));
  // Existing channel name is kept ('sevnt:engineStatus' is the push channel); this one lets the UI ask on demand.
  try { ipcMain.removeHandler('sevnt:engine.status'); } catch { /* none */ }
  ipcMain.handle('sevnt:engine.status', () => {
    const s = supervisor.status;
    return { state: s.state, error: s.error, restarts: s.restarts, runtime: rt.source };   // never expose port/token to the renderer
  });
  process.on('exit', () => { try { supervisor.killNow(); } catch { /* ignore */ } });
  app.on('before-quit', () => { try { supervisor.killNow(); } catch { /* ignore */ } });

  if (process.env.SEVNT_ENGINE_DISABLED === '1') { supervisor.o.log('engine: dinonaktifkan oleh SEVNT_ENGINE_DISABLED'); return supervisor; }
  app.whenReady().then(() => {
    // let the window paint first; the engine is optional and must never slow the first screen
    setTimeout(() => { supervisor.start().catch((e) => supervisor.o.log(`engine: start gagal: ${e.message}`)); }, 1500);
  });
  return supervisor;
}

/** For the pipeline (main process). null before init() or when disabled. */
function getSupervisor() { return supervisor; }

module.exports = { init, getSupervisor, resolveRuntime };
