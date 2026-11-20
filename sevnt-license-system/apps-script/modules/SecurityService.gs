/**
 * SecurityService — Cryptographic operations for the SEVNT License System.
 *
 * Responsibilities:
 * - License key generation (cryptographically random)
 * - Device token generation (high entropy)
 * - SHA-256 hashing
 * - HMAC-SHA256 response signing
 * - Admin secret verification
 *
 * SECURITY NOTES:
 * - GAS does not expose a CSPRNG directly. We use Utilities.getUuid() (UUID v4,
 *   which GAS generates server-side) as the entropy source. This is acceptable
 *   for a hosted GAS environment where the runtime is controlled by Google.
 * - HMAC signing uses a server-only key from Script Properties — never sent to
 *   client. Client-side verification is done in Phase 3 (Ed25519 upgrade).
 * - All hashing is irreversible: license keys and device tokens are NEVER stored
 *   in plaintext, only as SHA-256 hashes.
 *
 * PHASE 3 TODO: Replace HMAC-SHA256 with Ed25519 signing for client-verifiable
 * response signatures without sharing a server secret with the client.
 */

const SecurityService = (function() {

  const HMAC_KEY_PROP    = 'HMAC_SIGNING_KEY';
  const ADMIN_SECRET_KEY = 'ADMIN_SECRET';

  // ─── Key/Token Generation ────────────────────────────────────────────────

  /**
   * Generate a new license key.
   * Format: XXXXX-XXXXX-XXXXX-XXXXX (20 uppercase hex chars in 4 groups)
   * Entropy: 2 × UUID v4 = 256 bits combined (we take 20 chars = ~95 bits).
   * This is sufficient for license key uniqueness with a small user base.
   *
   * @returns {string} Formatted license key, e.g. "A1B2C-D3E4F-56789-ABCDE"
   */
  function generateLicenseKey() {
    // Use 2 UUIDs for headroom; take first 20 hex chars from concatenation
    const raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toUpperCase();
    return [raw.slice(0,5), raw.slice(5,10), raw.slice(10,15), raw.slice(15,20)].join('-');
  }

  /**
   * Hash a license key for storage and lookup.
   * Input is normalized (trim + uppercase) before hashing.
   *
   * @param {string} licenseKey - Raw license key from user input
   * @returns {string} SHA-256 hex string
   */
  function hashLicenseKey(licenseKey) {
    const normalized = licenseKey.trim().toUpperCase();
    return sha256Hex('license:' + normalized);
  }

  /**
   * Extract a display prefix for support lookup (never reveals full key).
   *
   * @param {string} licenseKey - Raw license key
   * @returns {string} First 8 characters, uppercase (e.g. "A1B2C-D3")
   */
  function licenseKeyPrefix(licenseKey) {
    return licenseKey.trim().toUpperCase().slice(0, 8);
  }

  /**
   * Generate a device token with high entropy.
   * Format: 96 hex chars (3 × UUID v4 = 384 bits).
   * Sent to device ONCE at activation. Never re-sent.
   *
   * @returns {string} Raw token (not stored; store only the hash)
   */
  function generateDeviceToken() {
    return [
      Utilities.getUuid().replace(/-/g, ''),
      Utilities.getUuid().replace(/-/g, ''),
      Utilities.getUuid().replace(/-/g, '')
    ].join('');
  }

  /**
   * Hash a device token for database storage.
   *
   * @param {string} token - Raw device token
   * @returns {string} SHA-256 hex string
   */
  function hashDeviceToken(token) {
    return sha256Hex('device_token:' + token);
  }

  /**
   * Hash a machine fingerprint for storage.
   * Client sends raw machine_id; we hash it before storing.
   *
   * @param {string} machineId - Raw machine fingerprint from client
   * @returns {string} SHA-256 hex string
   */
  function hashMachineId(machineId) {
    return sha256Hex('machine:' + machineId);
  }

  /**
   * Generate a UUID v4 for use as event/record IDs.
   *
   * @returns {string} UUID v4 string
   */
  function generateId() {
    return Utilities.getUuid();
  }

  // ─── Hashing ─────────────────────────────────────────────────────────────

  /**
   * Compute SHA-256 of a UTF-8 string, return lowercase hex string.
   *
   * @param {string} input
   * @returns {string} 64-char hex string
   */
  function sha256Hex(input) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      input,
      Utilities.Charset.UTF_8
    );
    return bytes.map(function(b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
  }

  // ─── Signing ─────────────────────────────────────────────────────────────

  /**
   * Sign a response payload with HMAC-SHA256.
   * Key is loaded from Script Properties (server-only).
   *
   * PHASE 3 NOTE: This will be replaced with Ed25519 RSA-based signing
   * so clients can verify without sharing a secret.
   *
   * @param {Object} payload - Response payload (fields that must be verified)
   * @returns {string} HMAC-SHA256 hex signature
   */
  function signResponse(payload) {
    const key = PropertiesService.getScriptProperties().getProperty(HMAC_KEY_PROP);
    if (!key) throw new Error('HMAC signing key not configured in Script Properties');

    // Canonical form: sorted keys JSON
    const message = canonicalJson(payload);
    const bytes = Utilities.computeHmacSha256Signature(message, key, Utilities.Charset.UTF_8);
    return bytes.map(function(b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
  }

  /**
   * Build a canonical (sorted-key) JSON string for deterministic signing.
   * Matches SEVNT client's deterministicSerialize() pattern.
   *
   * @param {Object} obj
   * @returns {string}
   */
  function canonicalJson(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(function(k) {
      return JSON.stringify(k) + ':' + canonicalJson(obj[k]);
    });
    return '{' + pairs.join(',') + '}';
  }

  // ─── Authentication ───────────────────────────────────────────────────────

  /**
   * Verify the provided admin secret against the stored Script Property.
   * GAS does not have a timing-safe equals; server-side timing attacks are
   * not a practical concern for a single-server GAS deployment, but we still
   * avoid short-circuit evaluation by hashing both sides before comparing.
   *
   * @param {string} provided - Secret from request body
   * @returns {boolean}
   */
  function verifyAdminSecret(provided) {
    if (!provided) return false;
    const expected = PropertiesService.getScriptProperties().getProperty(ADMIN_SECRET_KEY);
    if (!expected) return false;
    // Compare SHA-256 hashes to avoid short-circuit timing leak
    return sha256Hex(provided) === sha256Hex(expected);
  }

  // ─── Validation Helpers ───────────────────────────────────────────────────

  /**
   * Validate that a machine_id is non-empty and within expected length.
   *
   * @param {string} machineId
   * @returns {boolean}
   */
  function isValidMachineId(machineId) {
    return typeof machineId === 'string' &&
           machineId.trim().length >= 8 &&
           machineId.trim().length <= 256;
  }

  /**
   * Validate a license key format: XXXXX-XXXXX-XXXXX-XXXXX
   *
   * @param {string} key
   * @returns {boolean}
   */
  function isValidLicenseKeyFormat(key) {
    if (typeof key !== 'string') return false;
    return /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(key.trim());
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    generateLicenseKey:   generateLicenseKey,
    hashLicenseKey:       hashLicenseKey,
    licenseKeyPrefix:     licenseKeyPrefix,
    generateDeviceToken:  generateDeviceToken,
    hashDeviceToken:      hashDeviceToken,
    hashMachineId:        hashMachineId,
    generateId:           generateId,
    sha256Hex:            sha256Hex,
    signResponse:         signResponse,
    canonicalJson:        canonicalJson,
    verifyAdminSecret:    verifyAdminSecret,
    isValidMachineId:     isValidMachineId,
    isValidLicenseKeyFormat: isValidLicenseKeyFormat
  };

})();
