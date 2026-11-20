// SEVNT Update Check — semver utilities for update detection.
// Pure functions only — no network, no Electron dependency.
// Network fetch is done in main.js using Electron's net module.
// Rewritten from scratch (not derived from SOCL's obfuscated code).

'use strict';

/**
 * Parses a semver string into { major, minor, patch, pre }.
 * pre is an array of identifiers (e.g. ['beta', '2']) or empty for stable.
 */
function parse(v) {
  const clean = v.replace(/^v/, '');
  const [base, pre] = clean.split('-', 2);
  const [major, minor, patch] = base.split('.').map(Number);
  return {
    major: major || 0,
    minor: minor || 0,
    patch: patch || 0,
    pre: pre ? pre.split('.') : [],
  };
}

/**
 * Compares two version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Stable releases are always newer than any pre-release of the same version.
 */
function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);

  for (const field of ['major', 'minor', 'patch']) {
    if (pa[field] !== pb[field]) return pa[field] > pb[field] ? 1 : -1;
  }

  // Both have same base version — compare pre-release
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;   // stable > pre-release
  if (pb.pre.length === 0) return -1;  // pre-release < stable

  // Both pre-release — compare identifier by identifier
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = Number(ia);
    const nb = Number(ib);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na > nb ? 1 : -1;
    } else {
      if (ia !== ib) return ia > ib ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Returns true if version string has a pre-release identifier (e.g. "-beta", "-rc.1").
 */
function isPrerelease(v) {
  return parse(v).pre.length > 0;
}

/**
 * Picks the latest applicable release from a GitHub releases API response.
 *
 * @param {Array} releases - GitHub releases array
 * @param {string} current - Current installed version
 * @param {object} opts - { includePrerelease: boolean }
 * @returns {string} Latest tag name, or '' if no update available
 */
function pickLatestTag(releases, current, opts = {}) {
  const { includePrerelease = false } = opts;

  const candidates = releases
    .filter(r => !r.draft)
    .filter(r => includePrerelease || !r.prerelease)
    .map(r => r.tag_name)
    .filter(tag => {
      try { parse(tag); return true; } catch { return false; }
    })
    .sort((a, b) => compareVersions(b, a));  // descending

  const latest = candidates[0];
  if (!latest) return '';
  if (compareVersions(latest, current) <= 0) return '';
  return latest;
}

module.exports = { parse, compareVersions, isPrerelease, pickLatestTag };
