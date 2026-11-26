// SEVNT Studio â€” Main Process Entry Point
// Wraps the original SOCL main.js, adding:
//   1. BrowserWindow monkey-patch â†’ redirects SOCL UI to SEVNTY App React UI
//   2. SEVNT Studio IPC handlers (license, folder, caption, etc.)
//   3. Mobile Companion IPC handlers
//   4. Local engine (Python) supervision
//   5. userData isolation (dev only)
//
// RULES:
//   - src/main.js is NOT modified
//   - SOCL production data is NOT touched
//   - No second License Manager, no second engine process

'use strict';

// â•â• 1. userData isolation (MUST be first â€” before any module reads userData) â•â•
const { app } = require('electron');
const path   = require('path');

const __sevntQaMode = !app.isPackaged && process.env.SEVNT_QA_MODE === '1';
if (!app.isPackaged) {
  if (__sevntQaMode && process.env.SEVNT_QA_USER_DATA) {
    const requested = path.resolve(process.env.SEVNT_QA_USER_DATA);
    const tempRoot = path.resolve(require('os').tmpdir());
    const relative = path.relative(tempRoot, requested);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('SEVNT_QA_USER_DATA must be a child directory of the OS temp directory');
    }
    app.setPath('userData', requested);
  } else {
    app.setPath('userData', path.join(app.getPath('appData'), 'SEVNT_Dev'));
  }
} else {
  // Packaged build: the original main sets the app name to "SOCL Visuals Studio", which would make Electron use
  // %APPDATA%/SOCL Visuals Studio â€” the profile of a separately installed SOCL app (settings, licence cache, downloaded runtimes).
  // SEVNT must have its own data folder (see AUDIT/18_APP_IDENTITY_CHECK.md).
  app.setPath('userData', path.join(app.getPath('appData'), 'SEVNT Studio'));
}

// â•â• 2. (No BrowserWindow redirect â€” SOCL loads its own UI) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const electronMod    = require('electron');
const OrigBW         = electronMod.BrowserWindow;
const fs             = require('fs');

// ==========================================
// SEVNT PERSISTENT STARTUP LOGGER
// ==========================================
const __sevntTracePath = require('path').join(
  require('os').tmpdir(),
  'sevnt-startup-trace.log'
);

function __sevntPersistentTrace(label, detail = '') {
  try {
    require('fs').appendFileSync(
      __sevntTracePath,
      `${new Date().toISOString()} [SEVNT-TRACE] ${label} ${String(detail)}\n`
    );
  } catch (_) {}
}

__sevntPersistentTrace('MAIN ENTRY', `${process.platform}/${process.arch}`);
__sevntPersistentTrace('ARGV', JSON.stringify(process.argv));

process.on('beforeExit', code => {
  __sevntPersistentTrace('PROCESS beforeExit', code);
});

process.on('exit', code => {
  __sevntPersistentTrace('PROCESS exit', code);
});

process.on('uncaughtExceptionMonitor', error => {
  __sevntPersistentTrace('UNCAUGHT', error.stack || error);
});

app.on('before-quit', () => {
  __sevntPersistentTrace('APP before-quit');
});

app.on('will-quit', () => {
  __sevntPersistentTrace('APP will-quit');
});

app.on('window-all-closed', () => {
  __sevntPersistentTrace('APP window-all-closed');
});

// Web links open in the user's browser, not in a bare Electron window.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('browser-window-created', (_event, win) => {
  __sevntPersistentTrace('BROWSER WINDOW CREATED', win.id);

  win.on('closed', () => {
    __sevntPersistentTrace('BROWSER WINDOW CLOSED', win.id);
  });
});

const __sevntOriginalQuit = app.quit.bind(app);
app.quit = (...args) => {
  __sevntPersistentTrace('app.quit CALLED', new Error().stack);
  return __sevntOriginalQuit(...args);
};

const __sevntOriginalExit = app.exit.bind(app);
app.exit = (...args) => {
  __sevntPersistentTrace('app.exit CALLED', new Error().stack);
  return __sevntOriginalExit(...args);
};


// â•â• 2b. Auto-bypass license window when SEVNT cache is valid â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// SOCL main.js always creates a license BrowserWindow at startup.
// If SEVNT's license_status.json says valid:true, we auto-fire notifyActivated()
// so the window closes immediately without asking the user to re-enter the key.

// [NO-TRIAL] Trust only a REAL license check (signed cache via the license
// manager), never the derived license_status.json: that file can be stale
// (a leftover valid:true let the app skip the activation screen with no
// license installed). No license => the window stays on the activation screen.
async function _sevntLicenseValid() {
  const userData = app.getPath('userData');
  let valid = false;
  try {
    const r = await require('./src/license/sevnt-license-manager').checkOnStartup(userData);
    valid = !!(r && r.valid);
  } catch { valid = false; }
  if (!valid) {
    // Keep the derived status file honest so nothing else reads a stale "valid".
    try {
      const dir = path.join(userData, 'sevnt-studio');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'license_status.json'),
        JSON.stringify({ status: 'inactive', valid: false, source: null, validUntil: null }, null, 2), 'utf8');
    } catch { /* non-critical */ }
  }
  return valid;
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const url = win.webContents.getURL();
    if (!url.includes('license-window')) return;
    // The QA-only bypass is restricted to unpackaged runs with an explicit test flag
    // and an isolated temp userData directory. Packaged builds always require a real license.
    if (!__sevntQaMode && !(await _sevntLicenseValid())) return;
    // License already valid â€” auto-notify so SOCL closes the window
    win.webContents.executeJavaScript(
      'if (window.licenseAPI && window.licenseAPI.notifyActivated) window.licenseAPI.notifyActivated();'
    ).catch(() => {});
  });
});

// â•â• 3. Register SEVNT Studio IPC handlers â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
require('./src/sevnt-studio-ipc');

// â•â• 3b. Telegram delivery of exported clips (user's own bot) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
require('./src/sevnt-telegram-ipc');

// â•â• 3c. History: file checks + delete to the Recycle Bin â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
require('./src/sevnt-history-ipc');

// â•â• 3d. Settings > Disk Usage (measure + remove re-downloadable data) â•â•â•â•â•â•
require('./src/sevnt-diskusage-ipc');

// â•â• 4. Register Mobile Companion IPC handlers â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const { registerMobileIpc, setMainWindow } = require('./src/sevnt-mobile-ipc');
registerMobileIpc();

// â•â• 5. Capture main window reference when renderer signals ready â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const { ipcMain } = require('electron');
ipcMain.once('sevnt:mainWindowReady', (event) => {
  const win = electronMod.BrowserWindow.fromWebContents(event.sender);
  if (win) setMainWindow(win);
});

// â•â• 6. Local engine (Python, bundled with the app) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Owned by the EngineSupervisor: dynamic loopback port, per-launch token, health check, bounded restart,
// graceful shutdown, no orphan processes. No dependency on any folder outside this app.
const engineSupervisor = require('./src/sevnt-engine').init(electronMod);

// â•â• 7. Cleanup on quit â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.on('before-quit', async () => {
  try {
    const { stopGateway } = require('./src/sevnt-mobile-ipc');
    await stopGateway();
  } catch { /* graceful cleanup only */ }
});

// â•â• 8. Load original SOCL main process (after all patches are in place) â•â•â•â•â•â•
//
// SOCL src/main.js registers 'license:activate' twice internally (obfuscated bug).
// Electron throws on duplicate ipcMain.handle() calls. Patch handle() so that a
// second registration on the same channel silently replaces the first instead of
// crashing. The patch is applied only for the duration of src/main.js load, then
// removed so all future registrations behave normally.
{
  const _im = ipcMain;
  const _origHandle = _im.handle.bind(_im);
  _im.handle = function patchedHandle(channel, listener) {
    try { _im.removeHandler(channel); } catch { /* not yet registered â€” that's fine */ }
    return _origHandle(channel, listener);
  };
  try {
    
// ==========================================
// SEVNT MACOS STARTUP DIAGNOSTIC
// Temporary diagnostic
// ==========================================

console.error('[SEVNT-TRACE] Main entry loaded:', process.platform, process.arch);

const originalQuit = app.quit.bind(app);
app.quit = (...args) => {
  console.error('[SEVNT-TRACE] app.quit() CALLED');
  console.error(new Error('QUIT STACK').stack);
  return originalQuit(...args);
};

const originalExit = app.exit.bind(app);
app.exit = (...args) => {
  console.error('[SEVNT-TRACE] app.exit() CALLED', args);
  console.error(new Error('EXIT STACK').stack);
  return originalExit(...args);
};

app.on('before-quit', () => {
  console.error('[SEVNT-TRACE] EVENT: before-quit');
});

app.on('will-quit', () => {
  console.error('[SEVNT-TRACE] EVENT: will-quit');
});

app.on('window-all-closed', () => {
  console.error('[SEVNT-TRACE] EVENT: window-all-closed');
});

app.on('browser-window-created', (_event, win) => {
  console.error('[SEVNT-TRACE] BrowserWindow CREATED:', win.id);
  win.on('closed', () => {
    console.error('[SEVNT-TRACE] BrowserWindow CLOSED:', win.id);
  });
});

process.on('uncaughtException', (error) => {
  console.error('[SEVNT-TRACE] UNCAUGHT EXCEPTION:', error.stack || error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SEVNT-TRACE] UNHANDLED REJECTION:', reason);
});

require('./src/main.js');
  } finally {
    _im.handle = _origHandle; // restore: our later registrations behave normally
  }
}


