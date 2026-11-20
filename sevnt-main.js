// SEVNT Studio — Main Process Entry Point
// Wraps the original SOCL main.js, adding:
//   1. BrowserWindow monkey-patch → redirects SOCL UI to SEVNTY App React UI
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

// ══ 1. userData isolation (MUST be first — before any module reads userData) ══
const { app } = require('electron');
const path   = require('path');

if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'SEVNT_Dev'));
} else {
  // Packaged build: the original main sets the app name to "SOCL Visuals Studio", which would make Electron use
  // %APPDATA%/SOCL Visuals Studio — the profile of a separately installed SOCL app (settings, licence cache, downloaded runtimes).
  // SEVNT must have its own data folder (see AUDIT/18_APP_IDENTITY_CHECK.md).
  app.setPath('userData', path.join(app.getPath('appData'), 'SEVNT Studio'));
}

// ══ 2. (No BrowserWindow redirect — SOCL loads its own UI) ══════════════════

const electronMod    = require('electron');
const OrigBW         = electronMod.BrowserWindow;
const fs             = require('fs');

// ══ 2b. Auto-bypass license window when SEVNT cache is valid ══════════════════
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
    if (!(await _sevntLicenseValid())) return;
    // License already valid — auto-notify so SOCL closes the window
    win.webContents.executeJavaScript(
      'if (window.licenseAPI && window.licenseAPI.notifyActivated) window.licenseAPI.notifyActivated();'
    ).catch(() => {});
  });
});

// ══ 3. Register SEVNT Studio IPC handlers ════════════════════════════════════
require('./src/sevnt-studio-ipc');

// ══ 3b. Telegram delivery of exported clips (user's own bot) ═════════════════
require('./src/sevnt-telegram-ipc');

// ══ 3c. History: file checks + delete to the Recycle Bin ═══════════════════
require('./src/sevnt-history-ipc');

// ══ 3d. Settings > Disk Usage (measure + remove re-downloadable data) ══════
require('./src/sevnt-diskusage-ipc');

// ══ 4. Register Mobile Companion IPC handlers ════════════════════════════════
const { registerMobileIpc, setMainWindow } = require('./src/sevnt-mobile-ipc');
registerMobileIpc();

// ══ 5. Capture main window reference when renderer signals ready ══════════════
const { ipcMain } = require('electron');
ipcMain.once('sevnt:mainWindowReady', (event) => {
  const win = electronMod.BrowserWindow.fromWebContents(event.sender);
  if (win) setMainWindow(win);
});

// ══ 6. Local engine (Python, bundled with the app) ═══════════════════════════
// Owned by the EngineSupervisor: dynamic loopback port, per-launch token, health check, bounded restart,
// graceful shutdown, no orphan processes. No dependency on any folder outside this app.
const engineSupervisor = require('./src/sevnt-engine').init(electronMod);

// ══ 7. Cleanup on quit ════════════════════════════════════════════════════════
app.on('before-quit', async () => {
  try {
    const { stopGateway } = require('./src/sevnt-mobile-ipc');
    await stopGateway();
  } catch { /* graceful cleanup only */ }
});

// ══ 8. Load original SOCL main process (after all patches are in place) ══════
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
    try { _im.removeHandler(channel); } catch { /* not yet registered — that's fine */ }
    return _origHandle(channel, listener);
  };
  try {
    require('./src/main.js');
  } finally {
    _im.handle = _origHandle; // restore: our later registrations behave normally
  }
}
