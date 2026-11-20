// License Authorization Bridge for Mobile Companion.
// Wraps sevnt-license-manager to provide a strict license check
// suitable for feature-gated premium functionality.
//
// Stricter than the app's own grace period logic:
//   - graceExpired → denied (no reconnect-dialog grace for premium features)
//   - no license_key_hash in cache → denied
//   - valid_until expired → denied
//   - check_failed (Electron not ready, file error) → denied

'use strict';

const { app } = require('electron');
const licenseManager = require('./sevnt-license-manager');

// In-memory cache — avoids repeated disk I/O on every API request
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Returns the current license status for Mobile Companion authorization.
 * @returns {Promise<{ valid: boolean, licenseHash: string|null, reason?: string }>}
 */
async function getLicenseStatus() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  try {
    const userData = app.getPath('userData');
    const result = await licenseManager.checkOnStartup(userData);

    let status;
    if (!result.valid) {
      status = { valid: false, licenseHash: null, reason: result.reason || 'invalid' };
    } else if (result.graceExpired) {
      // Grace period expired — app shows reconnect dialog but we deny premium features
      status = { valid: false, licenseHash: null, reason: 'grace_expired' };
    } else if (!result.license_key_hash) {
      status = { valid: false, licenseHash: null, reason: 'no_hash' };
    } else if (result.valid_until && now > new Date(result.valid_until).getTime()) {
      status = { valid: false, licenseHash: null, reason: 'expired' };
    } else {
      status = { valid: true, licenseHash: result.license_key_hash };
    }

    _cache = status;
    _cacheAt = now;
    return status;
  } catch {
    return { valid: false, licenseHash: null, reason: 'check_failed' };
  }
}

/**
 * Invalidates the in-memory cache.
 * Call when license state changes (activation, deactivation, server revocation).
 */
function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { getLicenseStatus, invalidateCache };
