// Unit tests for sevnt-update-check.js
'use strict';

const { suite, test } = require('./test-runner');
const { parse, compareVersions, isPrerelease, pickLatestTag } = require('../src/sevnt-update-check');

module.exports = async function() {
  await suite('sevnt-update-check: parse', async ({ test }) => {
    await test('parses stable version', async ({ assertEqual }) => {
      const r = parse('1.2.3');
      assertEqual(r.major, 1); assertEqual(r.minor, 2); assertEqual(r.patch, 3);
      assertEqual(r.pre.length, 0);
    });
    await test('parses v-prefixed version', async ({ assertEqual }) => {
      const r = parse('v2.0.0');
      assertEqual(r.major, 2); assertEqual(r.minor, 0); assertEqual(r.patch, 0);
    });
    await test('parses beta version', async ({ assertEqual }) => {
      const r = parse('1.1.0-beta');
      assertEqual(r.pre[0], 'beta');
    });
    await test('parses beta.2', async ({ assertEqual }) => {
      const r = parse('1.1.0-beta.2');
      assertEqual(r.pre[0], 'beta'); assertEqual(r.pre[1], '2');
    });
  });

  await suite('sevnt-update-check: compareVersions', async ({ test }) => {
    await test('1.1.0 > 1.0.0', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.1.0', '1.0.0'), 1);
    });
    await test('1.0.0 < 1.1.0', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.0.0', '1.1.0'), -1);
    });
    await test('equal versions', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.0.0', '1.0.0'), 0);
    });
    await test('stable > prerelease of same version', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.1.0', '1.1.0-beta'), 1);
    });
    await test('prerelease < stable of same version', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.1.0-beta', '1.1.0'), -1);
    });
    await test('beta.2 > beta.1', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
    });
    await test('v-prefix handled', async ({ assertEqual }) => {
      assertEqual(compareVersions('v1.1.0', '1.0.0'), 1);
    });
    await test('major version comparison', async ({ assertEqual }) => {
      assertEqual(compareVersions('2.0.0', '1.9.9'), 1);
    });
    await test('patch comparison', async ({ assertEqual }) => {
      assertEqual(compareVersions('1.0.1', '1.0.0'), 1);
    });
  });

  await suite('sevnt-update-check: isPrerelease', async ({ test }) => {
    await test('stable is not prerelease', async ({ assert }) => {
      assert(!isPrerelease('1.0.0'));
    });
    await test('beta is prerelease', async ({ assert }) => {
      assert(isPrerelease('1.0.0-beta'));
    });
    await test('rc is prerelease', async ({ assert }) => {
      assert(isPrerelease('1.0.0-rc.1'));
    });
  });

  await suite('sevnt-update-check: pickLatestTag', async ({ test }) => {
    const makeRelease = (tag, opts = {}) => ({
      tag_name: tag,
      draft: opts.draft || false,
      prerelease: opts.prerelease || false,
    });

    await test('picks newer stable over current', async ({ assertEqual }) => {
      const releases = [makeRelease('v1.1.0'), makeRelease('v1.0.0')];
      assertEqual(pickLatestTag(releases, '1.0.0'), 'v1.1.0');
    });
    await test('returns empty if no newer release', async ({ assertEqual }) => {
      const releases = [makeRelease('v1.0.0')];
      assertEqual(pickLatestTag(releases, '1.0.0'), '');
    });
    await test('returns empty list', async ({ assertEqual }) => {
      assertEqual(pickLatestTag([], '1.0.0'), '');
    });
    await test('skips draft releases', async ({ assertEqual }) => {
      const releases = [makeRelease('v1.1.0', { draft: true }), makeRelease('v1.0.1')];
      assertEqual(pickLatestTag(releases, '1.0.0'), 'v1.0.1');
    });
    await test('skips prerelease by default', async ({ assertEqual }) => {
      const releases = [makeRelease('v1.1.0-beta', { prerelease: true }), makeRelease('v1.0.1')];
      assertEqual(pickLatestTag(releases, '1.0.0'), 'v1.0.1');
    });
    await test('includes prerelease when opted in', async ({ assertEqual }) => {
      const releases = [makeRelease('v1.1.0-beta', { prerelease: true }), makeRelease('v1.0.1')];
      assertEqual(pickLatestTag(releases, '1.0.0', { includePrerelease: true }), 'v1.1.0-beta');
    });
    await test('does not pick older version', async ({ assertEqual }) => {
      const releases = [makeRelease('v0.9.0')];
      assertEqual(pickLatestTag(releases, '1.0.0'), '');
    });
    await test('picks stable over beta when both available', async ({ assertEqual }) => {
      const releases = [
        makeRelease('v1.1.0-beta', { prerelease: true }),
        makeRelease('v1.0.1'),
      ];
      const tag = pickLatestTag(releases, '1.0.0');
      assertEqual(tag, 'v1.0.1');
    });
  });
};
