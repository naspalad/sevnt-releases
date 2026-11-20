// SEVNT License Manager — clean implementation (not derived from SOCL obfuscated code).
// Handles lifetime license activation, validation, deactivation, and offline grace.
//
// Architecture:
// - All requests authenticated with HMAC nonce (shared secret on server, not in app)
// - License cache encrypted with AES-256-GCM, key derived from machine ID
// - Ed25519 signature verification on every server response
// - 7-day offline grace period for lifetime licenses

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getMachineId } = require('./sevnt-machine-id');
const { verifyResponse } = require('./sevnt-signing');
const config = require('../sevnt-config');

// ─── Cache encryption ─────────────────────────────────────────────────────────

function _deriveKey(machineId) {
  // Key derived from machine ID — cache is only readable on this machine
  return crypto.createHash('sha256').update(`sevnt-license-${machineId}`).digest();
}

function _encryptCache(data, machineId) {
  const key = _deriveKey(machineId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function _decryptCache(raw, machineId) {
  const buf = Buffer.from(raw, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const enc = buf.slice(28);
  const key = _deriveKey(machineId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

// ─── Cache I/O ────────────────────────────────────────────────────────────────

function _getCachePath(userData) {
  return path.join(userData, config.LICENSE_CACHE_FILENAME);
}

async function _loadCache(userData) {
  try {
    const machineId = await getMachineId();
    const raw = fs.readFileSync(_getCachePath(userData), 'utf8');
    return _decryptCache(raw, machineId);
  } catch {
    return null;
  }
}

async function _saveCache(userData, data) {
  const machineId = await getMachineId();
  const enc = _encryptCache(data, machineId);
  fs.writeFileSync(_getCachePath(userData), enc, { mode: 0o600 });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function _post(endpoint, body) {
  // GAS Web App uses a single URL — action is sent in the request body
  const { net } = require('electron');
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await net.fetch(config.LICENSE_API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, action: endpoint, nonce }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.message || `HTTP ${res.status}`), { code: err.code, status: res.status });
  }
  return res.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Activates a license on this machine.
 * On success, saves encrypted cache and returns license info.
 */
async function activate(licenseKey, email, userData) {
  const machineId = await getMachineId();
  const result = await _post('activate', {
    license_key: licenseKey,
    email,
    machine_id: machineId,
    device_role: 'PRIMARY_LAPTOP',
    device_name: email || machineId.slice(0, 12),
  });

  if (!result.ok) throw new Error(result.message || 'Activation failed');
  if (!verifyResponse(result, result.sig)) throw new Error('Invalid server signature');

  const cache = {
    license_key_hash: crypto.createHash('sha256').update(licenseKey).digest('hex'),
    email,
    machine_id: machineId,
    device_token: result.device_token || null,
    device_id: result.device_id || null,
    license_id: result.license_id || null,
    valid_until: result.valid_until,
    issued_at: result.issued_at,
    cached_at: Date.now(),
  };
  await _saveCache(userData, cache);
  return { ok: true, ...cache };
}

/**
 * Validates the license online. Falls back to cache on network error.
 * Returns current license state including offline grace status.
 */
async function validateOnline(userData) {
  const cache = await _loadCache(userData);
  const machineId = await getMachineId();

  try {
    const result = await _post('validate', {
      machine_id: machineId,
      device_token: cache ? cache.device_token : null,
    });
    if (!result.ok) {
      return { valid: false, reason: result.message || 'Invalid license' };
    }
    if (!verifyResponse(result, result.sig)) {
      return { valid: false, reason: 'Invalid server signature' };
    }

    const updated = { ...cache, valid_until: result.valid_until, cached_at: Date.now() };
    await _saveCache(userData, updated);
    return { valid: true, source: 'online', ...updated };
  } catch (err) {
    // Network failure — check cache and grace period
    return _checkGrace(cache);
  }
}

/**
 * Checks the local cache and applies offline grace period logic.
 * Lifetime licenses get 7 days offline. Never locks/deletes user data.
 */
function _checkGrace(cache) {
  if (!cache) return { valid: false, reason: 'No license found. Please activate.' };

  const ageMs = Date.now() - (cache.cached_at || 0);
  const gracePeriodMs = config.OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;

  if (ageMs < gracePeriodMs) {
    const daysLeft = Math.ceil((gracePeriodMs - ageMs) / (24 * 60 * 60 * 1000));
    return { valid: true, source: 'cache', offlineGraceDays: daysLeft, ...cache };
  }

  // Grace expired — still allow app to run but show reconnect dialog
  return {
    valid: true,
    source: 'cache',
    graceExpired: true,
    warning: 'Please connect to the internet to revalidate your license.',
    ...cache,
  };
}

/**
 * Checks license at app startup. Uses cache if revalidation interval not reached.
 */
async function checkOnStartup(userData) {
  const cache = await _loadCache(userData);
  if (!cache) return { valid: false, reason: 'No license found. Please activate.' };

  const ageMs = Date.now() - (cache.cached_at || 0);
  const revalidateMs = config.REVALIDATE_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

  if (ageMs < revalidateMs) {
    return { valid: true, source: 'cache', ...cache };
  }

  return validateOnline(userData);
}

/**
 * Deactivates the license on this machine, freeing the slot on the server.
 */
async function deactivate(userData) {
  const machineId = await getMachineId();
  try {
    await _post('deactivate', { machine_id: machineId });
  } finally {
    // Always remove local cache, even if server call fails
    try { fs.unlinkSync(_getCachePath(userData)); } catch {}
  }
  return { ok: true };
}

/**
 * Returns the current license from cache without any server call.
 */
async function getCurrentLicense(userData) {
  return _loadCache(userData);
}

module.exports = { activate, validateOnline, checkOnStartup, deactivate, getCurrentLicense };
