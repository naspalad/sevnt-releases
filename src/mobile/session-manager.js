// Mobile session manager for SEVNT Studio.
// Manages pairing tokens (5 min, one-use) and session tokens (JWT, 24h).
//
// SECURITY ARCHITECTURE NOTE:
// The RSA key pair here is a LOCAL, per-session key generated fresh on every app launch.
// Its purpose: ensure that only THIS running instance of the laptop app can issue
// valid session tokens for its Mobile Gateway. It does NOT provide server-side authority.
// A compromised/malicious binary on the same laptop could generate valid tokens — that is
// an accepted risk of local companion authentication, not a JWT signing authority claim.
// The license system (sevnt-license-manager.js) uses a SERVER-SIDE Ed25519 key pair,
// which is the authoritative signing mechanism for license responses.
// No session state is persisted to disk — sessions end when the app closes.

'use strict';

const crypto = require('crypto');

// Generated fresh every app launch — sessions don't survive restarts
let _keyPair = null;

function _getKeyPair() {
  if (!_keyPair) {
    _keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  return _keyPair;
}

// Active pairing tokens: Map<token, { expiresAt, used }>
const _pairingTokens = new Map();

// Active sessions: Map<jti, { deviceId, licenseHash, expiresAt, revoked }>
const _sessions = new Map();

// ─── Pairing Tokens ───────────────────────────────────────────────────────────

/**
 * Creates a new one-time pairing token (5 minutes TTL).
 */
function createPairingToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000;
  _pairingTokens.set(token, { expiresAt, used: false });
  return { token, expiresAt };
}

/**
 * Validates and consumes a pairing token (one-use).
 * Returns true if valid, false if expired or already used.
 */
function consumePairingToken(token) {
  const entry = _pairingTokens.get(token);
  if (!entry) return false;
  if (entry.used) return false;
  if (Date.now() > entry.expiresAt) {
    _pairingTokens.delete(token);
    return false;
  }
  entry.used = true;
  _pairingTokens.delete(token);
  return true;
}

// ─── Session Tokens (JWT RS256) ───────────────────────────────────────────────

function _base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Creates a session JWT for a companion device.
 */
function createSessionToken(deviceId, licenseHash) {
  const { privateKey } = _getKeyPair();
  const jti = crypto.randomBytes(16).toString('hex');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 24 * 60 * 60;

  const header = _base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = _base64url(Buffer.from(JSON.stringify({
    sub: deviceId,
    lic: licenseHash,
    role: 'COMPANION_DEVICE',
    iat,
    exp,
    jti,
  })));

  const data = `${header}.${payload}`;
  const sig = _base64url(crypto.sign('SHA256', Buffer.from(data), privateKey));

  _sessions.set(jti, { deviceId, licenseHash, expiresAt: exp * 1000, revoked: false });
  return `${data}.${sig}`;
}

/**
 * Verifies a session JWT. Returns the payload if valid, null if invalid/expired.
 * @param {string} token
 * @param {string|null} [currentLicenseHash] - If provided, claims.lic must match.
 *   Pass the current license hash to enforce that sessions from a revoked/changed
 *   license are rejected even if the JWT signature is valid.
 */
function verifySessionToken(token, currentLicenseHash = null) {
  try {
    const [header, payload, sig] = token.split('.');
    const { publicKey } = _getKeyPair();
    const data = `${header}.${payload}`;

    const valid = crypto.verify(
      'SHA256',
      Buffer.from(data),
      publicKey,
      Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    );
    if (!valid) return null;

    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (Date.now() > claims.exp * 1000) return null;

    const session = _sessions.get(claims.jti);
    if (!session || session.revoked) return null;

    // License binding: if a current hash is provided, the token's lic must match.
    // This ensures tokens issued under a revoked or expired license stop working
    // as soon as the license hash changes — even before the JWT expires.
    if (currentLicenseHash !== null && claims.lic !== currentLicenseHash) return null;

    return claims;
  } catch {
    return null;
  }
}

/**
 * Revokes all active sessions (e.g. user clicked "Disconnect HP").
 */
function revokeAllSessions() {
  for (const session of _sessions.values()) {
    session.revoked = true;
  }
}

/**
 * Returns count of active sessions.
 */
function getActiveSessionCount() {
  const now = Date.now();
  return [..._sessions.values()].filter(s => !s.revoked && s.expiresAt > now).length;
}

/**
 * Rotates a session token: revokes the old jti and issues a new token.
 * Used for sliding-window refresh. Safe for parallel requests because:
 * - The old token remains valid until this function completes.
 * - Caller should swap to new token atomically.
 * Returns null if the original token is invalid/expired/revoked.
 * @param {string} oldToken
 * @param {string|null} [currentLicenseHash] - If provided, the old token's lic must
 *   match and the new token is issued with this hash. Pass current license hash to
 *   prevent refresh when the license has changed.
 */
function rotateSessionToken(oldToken, currentLicenseHash = null) {
  const claims = verifySessionToken(oldToken, currentLicenseHash);
  if (!claims) return null;

  // Revoke old token
  const oldSession = _sessions.get(claims.jti);
  if (oldSession) oldSession.revoked = true;

  // Issue new token: use currentLicenseHash if provided, otherwise carry forward claims.lic
  const newLicenseHash = currentLicenseHash !== null ? currentLicenseHash : claims.lic;
  return createSessionToken(claims.sub, newLicenseHash);
}

module.exports = {
  createPairingToken,
  consumePairingToken,
  createSessionToken,
  verifySessionToken,
  rotateSessionToken,
  revokeAllSessions,
  getActiveSessionCount,
};
