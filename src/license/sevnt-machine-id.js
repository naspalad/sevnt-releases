// Device fingerprinting for SEVNT Studio license system.
// Generates a stable, non-reversible machine identifier using hardware info.
// The ID is a SHA256 hash — cannot be traced back to actual hardware identifiers.

'use strict';

const crypto = require('crypto');
const os = require('os');

/**
 * Collects stable hardware attributes to build a fingerprint.
 * Uses only OS-provided info, no external binaries required.
 */
async function _collectAttributes() {
  const attrs = [];

  // CPU model (stable across reboots)
  const cpus = os.cpus();
  if (cpus.length > 0) {
    attrs.push(`cpu:${cpus[0].model}`);
    attrs.push(`cpu_count:${cpus.length}`);
  }

  // Platform
  attrs.push(`platform:${process.platform}`);
  attrs.push(`arch:${process.arch}`);

  // Hostname (stable unless user changes it)
  attrs.push(`hostname:${os.hostname()}`);

  // Total memory (stable hardware value)
  attrs.push(`mem:${os.totalmem()}`);

  // macOS: use ioreg for serial number (most stable)
  if (process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      const serial = execSync("ioreg -l | grep IOPlatformSerialNumber | awk '{print $NF}'", {
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim().replace(/"/g, '');
      if (serial) attrs.push(`serial:${serial}`);
    } catch {
      // fall through to other attributes
    }
  }

  // Windows: use wmic for motherboard serial
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const serial = execSync('wmic baseboard get serialnumber /value', {
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().match(/SerialNumber=(.+)/)?.[1]?.trim();
      if (serial && serial !== 'To be filled by O.E.M.') {
        attrs.push(`board_serial:${serial}`);
      }
    } catch {
      // fall through
    }
  }

  return attrs;
}

/**
 * Returns the stable device ID (SHA256 hex string, 64 chars).
 * The same hardware always produces the same ID on the same OS install.
 * Result is cached in memory after first call.
 */
let _cachedId = null;

async function getMachineId() {
  if (_cachedId) return _cachedId;

  const attrs = await _collectAttributes();
  if (attrs.length < 3) {
    throw new Error('Insufficient hardware attributes for machine ID');
  }

  const raw = attrs.sort().join('|');
  _cachedId = crypto.createHash('sha256').update(raw).digest('hex');
  return _cachedId;
}

/**
 * Synchronous fallback using only os module (less stable but always available).
 * Used when async version cannot be called (e.g. during early init).
 */
function getMachineIdSync() {
  const attrs = [
    `cpu:${os.cpus()[0]?.model || 'unknown'}`,
    `platform:${process.platform}`,
    `arch:${process.arch}`,
    `hostname:${os.hostname()}`,
    `mem:${os.totalmem()}`,
  ];
  return crypto.createHash('sha256').update(attrs.sort().join('|')).digest('hex');
}

module.exports = { getMachineId, getMachineIdSync };
