// Centralized configuration for SEVNT Studio
// All server URLs use environment variable overrides for deployment flexibility.
// PLACEHOLDER values must be replaced before production deployment.

'use strict';

module.exports = {
  // ─── App Identity ────────────────────────────────────────────────────────────
  APP_NAME: 'SEVNT Studio',
  COMPANY: 'Seventy',
  APP_VERSION: require('../package.json').version,

  // ─── License API (server required) ──────────────────────────────────────────
  LICENSE_API_ENDPOINT: process.env.SEVNT_LICENSE_API
    || 'https://script.google.com/macros/s/AKfycbxaN2QJsscNRX7JY-Txf_GlT_cVV6KqddkB6dDhI6NtzP5lrh5yG-EquT3SPrY-D9OhXA/exec',

  OFFLINE_GRACE_DAYS: 7,
  REVALIDATE_INTERVAL_DAYS: 3,
  LICENSE_CACHE_FILENAME: '.sevnt-license-cache',

  // ─── Preset Catalog (server required) ────────────────────────────────────────
  CATALOG_URL: process.env.SEVNT_CATALOG_URL
    || 'https://sevnt-catalog.naspalad.workers.dev/v1/catalog',
  CATALOG_FALLBACK_URL: process.env.SEVNT_CATALOG_FALLBACK
    || 'https://sevnt-catalog.naspalad.workers.dev/v1/catalog',

  // ─── Update & Binary Releases (server required) ───────────────────────────────
  UPDATE_REPO: process.env.SEVNT_UPDATE_REPO
    || 'naspalad/sevnt-releases',
  UPDATE_API: `https://api.github.com/repos/${process.env.SEVNT_UPDATE_REPO || 'naspalad/sevnt-releases'}/releases`,

  // ─── Mobile Companion ────────────────────────────────────────────────────────
  MOBILE_GATEWAY_PORT: parseInt(process.env.SEVNT_MOBILE_PORT, 10) || 7474,
  PAIRING_TOKEN_TTL_MS: 5 * 60 * 1000,  // 5 minutes
  SESSION_TOKEN_TTL_S: 24 * 60 * 60,    // 24 hours
  MOBILE_RATE_LIMIT_RPS: 40,

  // ─── Purchase / Store ─────────────────────────────────────────────────────────
  PURCHASE_URL: process.env.SEVNT_PURCHASE_URL
    || 'https://sevntstudio.com/buy',                   // PLACEHOLDER

  // ─── Feature Flags ────────────────────────────────────────────────────────────
  ENABLE_MOBILE_COMPANION: true,
  ENABLE_BETA_UPDATES: false,

  // ─── DO NOT add API secrets or private keys here. ─────────────────────────────
  // User API keys → OS keychain via sevnt-secrets.js
  // License signing keys → server only
  // Shared secrets → environment variable on server, never in app
};
