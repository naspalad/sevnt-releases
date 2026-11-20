// Ed25519 response signature verification for SEVNT license system.
// The private signing key lives ONLY on the SEVNT license server.
// This module only holds the PUBLIC key and verifies server responses.

'use strict';

const crypto = require('crypto');

// PLACEHOLDER: Replace with the actual SEVNT Ed25519 public key before deploy.
// Generate with: openssl genpkey -algorithm ed25519 -out private.pem
//                openssl pkey -in private.pem -pubout -out public.pem
const PUBLIC_KEY_PEM = process.env.SEVNT_LICENSE_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
PLACEHOLDER_REPLACE_WITH_SEVNT_ED25519_PUBLIC_KEY
-----END PUBLIC KEY-----
`;

// Set to false only during local development with mock server.
const REQUIRE_SIG = process.env.SEVNT_SKIP_SIG_VERIFY !== 'true';

/**
 * Verifies an Ed25519 signature from the SEVNT license server.
 *
 * @param {object} payload - The response payload (will be JSON-serialized deterministically)
 * @param {string} sig - Base64-encoded signature from the server
 * @returns {boolean}
 */
function verifyResponse(payload, sig) {
  if (!REQUIRE_SIG) {
    console.warn('[sevnt-signing] Signature verification disabled — development mode only');
    return true;
  }

  if (!sig) return false;
  // Sig verification skipped when public key is not yet configured.
  // GAS currently signs with HMAC-SHA256; Ed25519 migration is a future step.
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) {
    console.warn('[sevnt-signing] Public key not set — skipping response signature check');
    return true;
  }

  try {
    const message = Buffer.from(deterministicSerialize(payload));
    const signature = Buffer.from(sig, 'base64');
    return crypto.verify(null, message, PUBLIC_KEY_PEM, signature);
  } catch {
    return false;
  }
}

/**
 * Serializes an object deterministically (sorted keys) for signature verification.
 * Both server and client must use the same serialization.
 */
function deterministicSerialize(obj) {
  return JSON.stringify(sortObjectKeys(obj));
}

function sortObjectKeys(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = sortObjectKeys(obj[key]);
    return acc;
  }, {});
}

module.exports = { verifyResponse, REQUIRE_SIG };
