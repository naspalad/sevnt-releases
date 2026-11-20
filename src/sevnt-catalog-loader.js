// SEVNT Preset Catalog Loader
// Loads, verifies, and caches the signed preset catalog from the SEVNT catalog server.
// Based on the same architecture as SOCL's catalog-loader, but with SEVNT's own URLs and keys.
//
// ISP Note: Some providers block *.workers.dev — always use a custom domain as primary URL.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./sevnt-config');
const { PUBLIC_KEY_PEM } = require('./sevnt-preset-catalog-key');
const { validateCatalog, verifySigned } = require('./preset-catalog');  // reuse SOCL's pure validators

const CACHE_FILENAME = 'sevnt-preset-catalog.json';

let _current = null;

/**
 * Loads the catalog from local cache (userData dir).
 * Returns null if cache doesn't exist or is corrupt.
 */
function loadCached(userData) {
  try {
    const cachePath = path.join(userData, CACHE_FILENAME);
    const raw = fs.readFileSync(cachePath, 'utf8');
    const envelope = JSON.parse(raw);
    const catalog = verifySigned(envelope, PUBLIC_KEY_PEM);
    _current = catalog;
    return catalog;
  } catch {
    return null;
  }
}

/**
 * Fetches the latest catalog from the SEVNT server.
 * Verifies signature and validates schema before saving to cache.
 * Returns the validated catalog on success.
 */
async function refresh(userData, opts = {}) {
  const { net } = require('electron');
  const urls = [config.CATALOG_URL, config.CATALOG_FALLBACK_URL].filter(Boolean);

  let lastErr;
  for (const url of urls) {
    try {
      const res = await net.fetch(url, {
        headers: { 'User-Agent': `SEVNT-Studio/${config.APP_VERSION}` },
        signal: AbortSignal.timeout(opts.timeoutMs || 10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const envelope = await res.json();

      // Verify Ed25519 signature from SEVNT catalog server
      const catalog = verifySigned(envelope, PUBLIC_KEY_PEM);

      // Validate schema
      const fontExists = opts.fontExists || (() => true);
      const errors = validateCatalog(catalog, { fontExists });
      if (errors.length > 0) throw new Error(`Catalog schema errors: ${errors.join(', ')}`);

      // Save to cache
      const cachePath = path.join(userData, CACHE_FILENAME);
      fs.writeFileSync(cachePath, JSON.stringify(envelope), { mode: 0o600 });

      _current = catalog;
      return catalog;
    } catch (err) {
      lastErr = err;
      // try next URL
    }
  }

  throw lastErr || new Error('All catalog URLs failed');
}

/**
 * Returns the last successfully loaded catalog (from cache or refresh).
 */
function current() {
  return _current;
}

module.exports = { loadCached, refresh, current };
