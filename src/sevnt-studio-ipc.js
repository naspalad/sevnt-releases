// SEVNT Studio IPC — handlers for window.sevnt.* channels
// Registers all ipcMain handlers that the unified preload exposes as window.sevnt.*
//
// Security contract:
//   - License operations delegate ONLY to sevnt-license-manager (sole authority)
//   - No raw license key is ever sent to renderer
//   - All file/folder operations use Electron shell/dialog, not arbitrary shell commands

'use strict';

const { ipcMain, app, shell, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs   = require('fs');

const licenseManager = require('./license/sevnt-license-manager');
const { invalidateCache: invalidateMobileLicenseCache } = require('./license/license-status');

function _writeLicenseStatusFile(userData, payload) {
  try {
    const sevntDir = path.join(userData, 'sevnt-studio');
    if (!fs.existsSync(sevntDir)) fs.mkdirSync(sevntDir, { recursive: true });
    const statusPath = path.join(sevntDir, 'license_status.json');
    const filePayload = {
      status: payload.valid ? (payload.source === 'grace' ? 'grace' : 'active') : 'inactive',
      valid:  payload.valid,
      source: payload.source,
      validUntil: payload.validUntil,
    };
    fs.writeFileSync(statusPath, JSON.stringify(filePayload, null, 2), 'utf8');
  } catch { /* non-critical */ }
}

// ── License ──────────────────────────────────────────────────────────────────

ipcMain.handle('sevnt:getLicenseStatus', async () => {
  const userData = app.getPath('userData');
  try {
    const result = await licenseManager.checkOnStartup(userData);
    const payload = {
      valid:            !!result?.valid,
      source:           result?.source    ?? null,
      licenseKeyHash:   result?.license_key_hash ?? null,
      validUntil:       result?.valid_until ?? null,
      graceExpired:     result?.graceExpired ?? false,
      reason:           result?.reason ?? null,
    };
    // Write license_status.json so Python engine /api/v1/license/status can read it
    _writeLicenseStatusFile(userData, payload);
    return payload;
  } catch {
    return { valid: false, reason: 'check_failed' };
  }
});

// License window handler — channel 'sevnt:licenseActivate' avoids conflict with SOCL's 'license:activate'
ipcMain.handle('sevnt:licenseActivate', async (_event, { email = '', licenseKey = '' } = {}) => {
  if (!licenseKey.trim()) return { ok: false, error: 'MISSING_FIELD', message: 'license_key required' };
  const userData = app.getPath('userData');
  try {
    const result = await licenseManager.activate(licenseKey.trim(), email.trim(), userData);
    const payload = { ok: true, valid: true, source: result?.source ?? null,
      licenseKeyHash: result?.license_key_hash ?? null, validUntil: result?.valid_until ?? null };
    _writeLicenseStatusFile(userData, payload);
    invalidateMobileLicenseCache();
    return payload;
  } catch (err) {
    const msg = err.message || '';
    const codes = {
      'License key not found': 'license_not_found', 'LICENSE_NOT_FOUND': 'license_not_found',
      'Email does not match':  'email_mismatch',    'EMAIL_MISMATCH':    'email_mismatch',
      'License is revoked':    'license_revoked',   'LICENSE_REVOKED':   'license_revoked',
      'Machine blocked':       'machine_blocked',   'MACHINE_BLOCKED':   'machine_blocked',
      'Already bound':         'already_bound_other_machine',
    };
    const matched = Object.keys(codes).find(k => msg.includes(k));
    return { ok: false, error: matched ? codes[matched] : 'activate_failed', message: msg };
  }
});

// Settings > License card. Reads SEVNT's own cache (NOT SOCL's 'license:getCurrent',
// which looks at a different file and always reported "not active").
ipcMain.handle('sevnt:getLicenseInfo', async () => {
  try {
    const c = await licenseManager.getCurrentLicense(app.getPath('userData'));
    if (!c || !c.email) return null;
    const until = c.valid_until ? new Date(c.valid_until) : null;
    return {
      email: c.email,
      licenseKey: c.license_key_hash || '',
      machineId: c.machine_id || '',
      tier: until && !isNaN(until) ? 's/d ' + until.toISOString().slice(0, 10) : 'Lifetime',
    };
  } catch { return null; }
});

ipcMain.handle('sevnt:activateLicense', async (_event, key) => {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Invalid license key');
  const userData = app.getPath('userData');
  const email = '';
  const result = await licenseManager.activate(key.trim(), email, userData);
  const payload = {
    valid:          !!result?.valid,
    source:         result?.source ?? null,
    licenseKeyHash: result?.license_key_hash ?? null,
    validUntil:     result?.valid_until ?? null,
  };
  _writeLicenseStatusFile(userData, payload);
  invalidateMobileLicenseCache();
  return payload;
});

ipcMain.handle('sevnt:deactivateLicense', async () => {
  const userData = app.getPath('userData');
  await licenseManager.deactivate(userData);
  _writeLicenseStatusFile(userData, {
    valid: false,
    source: null,
    validUntil: null,
  });
  invalidateMobileLicenseCache();
  return { ok: true };
});

// ── Folder picker & shell ──────────────────────────────────────────────────

ipcMain.handle('sevnt:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('sevnt:openFolder', async (_event, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath) throw new Error('Invalid path');
  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved)) throw new Error('Path does not exist');
  await shell.openPath(resolved);
  return { ok: true };
});

ipcMain.handle('sevnt:openOutputFolder', async () => {
  const userData = app.getPath('userData');
  const outputDir = path.join(userData, 'sevnt-studio', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  await shell.openPath(outputDir);
  return { ok: true };
});

// ── App version & update ──────────────────────────────────────────────────

ipcMain.handle('sevnt:getAppVersion', () => {
  return app.getVersion();
});

ipcMain.handle('sevnt:checkUpdate', async () => {
  // Placeholder — wire to auto-updater when available
  return { hasUpdate: false };
});

// ── Binary management (delegated to Python Engine status) ─────────────────

ipcMain.handle('sevnt:checkBinaryVersion', async (_event, binId) => {
  // Returns version string or null — Python Engine owns binary management
  return { id: binId, version: null, status: 'unknown' };
});

ipcMain.handle('sevnt:reinstallBinary', async (_event, binId) => {
  return { id: binId, ok: false, reason: 'not_implemented' };
});

// ── Caption / Apply (proxied to Python Engine) ────────────────────────────

ipcMain.handle('sevnt:applyCaption', async (_event, config) => {
  // Forward to Python Engine via HTTP (engine runs on localhost:8765)
  const url = 'http://127.0.0.1:8765/api/v1/caption/apply';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Engine error ${res.status}: ${text}`);
    }
    return res.json();
  } catch (err) {
    throw new Error(`applyCaption failed: ${err.message}`);
  }
});

module.exports = {};
