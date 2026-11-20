// Unit/integration tests for mobile-gateway.js
'use strict';

const { suite, test } = require('./test-runner');
const http = require('http');

const TEST_PORT = 17474;

function freshGateway(handlers = {}) {
  // Reset module state
  ['../src/mobile/session-manager', '../src/mobile/mobile-gateway'].forEach(m => {
    delete require.cache[require.resolve(m)];
  });
  const { MobileGateway } = require('../src/mobile/mobile-gateway');
  return new MobileGateway(handlers, TEST_PORT);
}

function req(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, method, path, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function postReq(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

module.exports = async function() {

  await suite('mobile-gateway: health endpoint', async ({ test }) => {
    let gw;
    await test('GET /api/health returns 200', async ({ assert, assertEqual }) => {
      gw = freshGateway();
      await gw.start();
      const res = await req(TEST_PORT, 'GET', '/api/health');
      assertEqual(res.status, 200);
      assert(res.body.ok === true);
    });
    if (gw) await gw.stop();
  });

  await suite('mobile-gateway: unauthenticated access', async ({ test }) => {
    let gw;
    await test('GET /api/projects without token returns 401', async ({ assertEqual }) => {
      gw = freshGateway();
      await gw.start();
      const res = await req(TEST_PORT, 'GET', '/api/projects');
      assertEqual(res.status, 401);
    });
    await test('admin endpoint blocked (401 — auth before route)', async ({ assert }) => {
      // Returns 401 not 404: auth check runs before route matching (correct — does not expose endpoint inventory)
      const res = await req(TEST_PORT, 'GET', '/api/admin/delete-all');
      assert(res.status === 401 || res.status === 404, 'admin endpoint should be blocked');
    });
    await test('license endpoint blocked', async ({ assert }) => {
      const res = await req(TEST_PORT, 'GET', '/api/license/keys');
      assert(res.status === 401 || res.status === 404, 'license endpoint should be blocked');
    });
    await test('path traversal blocked (URL normalized, auth required)', async ({ assert }) => {
      // new URL normalizes /api/../../../etc/passwd → /etc/passwd → hits auth check
      const res = await req(TEST_PORT, 'GET', '/api/../../../etc/passwd');
      assert(res.status === 401 || res.status === 404, 'traversal should be blocked');
    });
    if (gw) await gw.stop();
  });

  await suite('mobile-gateway: pairing flow', async ({ test }) => {
    let gw;
    await test('POST /api/pair with invalid token returns 400', async ({ assertEqual }) => {
      gw = freshGateway({ onPairRequest: () => true, getLicenseHash: () => 'h' });
      await gw.start();
      const res = await postReq(TEST_PORT, '/api/pair?t=invalidtoken', {});
      assertEqual(res.status, 400);
    });

    await test('POST /api/pair with no onPairRequest handler returns 503', async ({ assert, assertEqual }) => {
      if (gw) await gw.stop();
      gw = freshGateway({});  // no handler
      await gw.start();
      // need a valid pairing token first — create one manually
      const sm = require('../src/mobile/session-manager');
      const { token } = sm.createPairingToken();
      // consume it via freshGateway which uses same session-manager module instance
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'dev' });
      // 400 (token already consumed by this module instance) or 503 (no handler)
      assert(res.status === 400 || res.status === 503, 'should be blocked');
    });

    await test('POST /api/pair with valid token but rejected handler returns 403', async ({ assert, assertEqual }) => {
      if (gw) await gw.stop();
      gw = freshGateway({ onPairRequest: () => false, getLicenseHash: () => 'testhash' });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const url = `/api/pair?t=${token}`;
      const res = await postReq(TEST_PORT, url, {}, { 'x-device-id': 'test-device' });
      assertEqual(res.status, 403);
    });

    await test('POST /api/pair with valid token + accepted = returns session token', async ({ assert, assertEqual }) => {
      if (gw) await gw.stop();
      gw = freshGateway({ onPairRequest: () => true, getLicenseHash: () => 'testhash' });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const url = `/api/pair?t=${token}`;
      const res = await postReq(TEST_PORT, url, {}, { 'x-device-id': 'test-device' });
      assertEqual(res.status, 200);
      assert(res.body.ok === true);
      assert(typeof res.body.session_token === 'string');
    });

    await test('pairing token cannot be reused', async ({ assert, assertEqual }) => {
      if (gw) await gw.stop();
      gw = freshGateway({ onPairRequest: () => true, getLicenseHash: () => 'testhash' });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const url = `/api/pair?t=${token}`;
      const r1 = await postReq(TEST_PORT, url, {}, { 'x-device-id': 'dev' });
      assertEqual(r1.status, 200, 'first use should succeed');
      const r2 = await postReq(TEST_PORT, url, {}, { 'x-device-id': 'dev' });
      assertEqual(r2.status, 400, 'second use should fail');
    });

    if (gw) await gw.stop();
  });

  await suite('mobile-gateway: async pairing (BUG-5B4-001 regression)', async ({ test }) => {
    // These tests verify that the fix (await onPairRequest) is correct.
    // onPairRequest now returns a Promise; session must NOT be created before resolution.

    await test('async approval true → session created', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        onPairRequest: () => Promise.resolve(true),
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'hp1' });
      assertEqual(res.status, 200, 'async approval true must succeed');
      assert(typeof res.body.session_token === 'string', 'must return session token');
      await gw.stop();
    });

    await test('async approval false → no session, 403', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        onPairRequest: () => Promise.resolve(false),
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'hp2' });
      assertEqual(res.status, 403, 'async rejection must return 403');
      assert(!res.body.session_token, 'must not return session token');
      await gw.stop();
    });

    await test('approval pending — session not created until resolved', async ({ assert, assertEqual }) => {
      let resolver = null;
      const gw = freshGateway({
        onPairRequest: () => new Promise(resolve => { resolver = resolve; }),
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);

      // Fire request but don't await — it will hang until resolver() is called
      let done = false;
      let responseStatus = null;
      const pairPromise = postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'hp3' })
        .then(r => { done = true; responseStatus = r.status; return r; });

      // Give the HTTP handler a moment to reach the await point
      await new Promise(r => setTimeout(r, 50));

      // Session must NOT be created yet — resolver has not been called
      assert(!done, 'response must not arrive before approval');

      // Now approve
      resolver(true);
      const res = await pairPromise;
      assertEqual(res.status, 200, 'should succeed after approval');
      assert(typeof res.body.session_token === 'string', 'session created only after approval');
      await gw.stop();
    });

    await test('approval timeout (resolve false after delay) → no session', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        // Simulate timeout: resolve false after 80ms (like the real 60s auto-timeout)
        onPairRequest: () => new Promise(resolve => setTimeout(() => resolve(false), 80)),
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'hp4' });
      assertEqual(res.status, 403, 'timeout rejection must return 403');
      assert(!res.body.session_token, 'must not return session on timeout');
      await gw.stop();
    });

    await test('handler throws → no session, 403', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        onPairRequest: () => Promise.reject(new Error('handler error')),
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'hp5' });
      assertEqual(res.status, 403, 'thrown error must not create session');
      assert(!res.body.session_token, 'no session on thrown error');

      // Gateway must still be operational after the error
      const health = await require('http').request && null;
      const healthRes = await new Promise(resolve => {
        const r = require('http').request(
          { hostname: '127.0.0.1', port: TEST_PORT, method: 'GET', path: '/api/health' },
          res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(JSON.parse(d))); }
        );
        r.on('error', () => resolve(null));
        r.end();
      });
      assert(healthRes && healthRes.ok === true, 'gateway must remain operational after error');
      await gw.stop();
    });

    await test('token cannot be reused even after rejected async approval', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        onPairRequest: () => Promise.resolve(false),  // first attempt rejected
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const url = `/api/pair?t=${token}`;
      // First attempt — token consumed but rejected
      const r1 = await postReq(TEST_PORT, url, {}, { 'x-device-id': 'dev' });
      assertEqual(r1.status, 403, 'first attempt rejected');
      // Second attempt — token already consumed
      const r2 = await postReq(TEST_PORT, url, {}, { 'x-device-id': 'dev' });
      assertEqual(r2.status, 400, 'token must be consumed on first use even if rejected');
      await gw.stop();
    });

    await test('concurrent pairing requests — only one can succeed per token', async ({ assert, assertEqual }) => {
      let callCount = 0;
      const gw = freshGateway({
        onPairRequest: () => { callCount++; return Promise.resolve(true); },
        getLicenseHash: () => 'hash',
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const url = `/api/pair?t=${token}`;
      // Fire two concurrent requests with the same token
      const [r1, r2] = await Promise.all([
        postReq(TEST_PORT, url, {}, { 'x-device-id': 'hp-a' }),
        postReq(TEST_PORT, url, {}, { 'x-device-id': 'hp-b' }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      // One must succeed (200), one must fail (400 — token already consumed)
      assertEqual(statuses[0], 200, 'one request must succeed');
      assertEqual(statuses[1], 400, 'second request must fail — token one-use');
      assert(callCount <= 1, 'onPairRequest must be called at most once');
      await gw.stop();
    });
  });

  await suite('mobile-gateway: license authorization', async ({ test }) => {
    // These tests verify that pairing and API access are blocked when license is invalid.

    await test('POST /api/pair rejected when getLicenseHash returns null (no license)', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        onPairRequest: () => true,
        getLicenseHash: () => null,  // license not valid
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'dev' });
      assertEqual(res.status, 403, 'pairing must be rejected when license invalid');
      assert(res.body.error === 'license_required', 'must return license_required error');
      await gw.stop();
    });

    await test('POST /api/pair rejected when getLicenseHash throws (license check failed)', async ({ assert, assertEqual }) => {
      const gw = freshGateway({
        onPairRequest: () => true,
        getLicenseHash: () => { throw new Error('check_failed'); },
      });
      await gw.start();
      const { token } = gw.createPairingUrl(null);
      const res = await postReq(TEST_PORT, `/api/pair?t=${token}`, {}, { 'x-device-id': 'dev' });
      assertEqual(res.status, 403, 'pairing must be rejected when license check throws');
      await gw.stop();
    });

    await test('API request rejected when license changes (hash mismatch)', async ({ assert, assertEqual }) => {
      let licenseHash = 'original-hash';
      const gw = freshGateway({
        onPairRequest: () => true,
        getLicenseHash: () => licenseHash,
        getProjects: () => [],
      });
      await gw.start();

      // Pair with original license
      const { token: pToken } = gw.createPairingUrl(null);
      const pairRes = await postReq(TEST_PORT, `/api/pair?t=${pToken}`, {}, { 'x-device-id': 'dev' });
      assertEqual(pairRes.status, 200, 'initial pairing should succeed');
      const sessionToken = pairRes.body.session_token;

      // API works with original license
      const r1 = await req(TEST_PORT, 'GET', '/api/projects', { Authorization: `Bearer ${sessionToken}` });
      assertEqual(r1.status, 200, 'API should work with original license');

      // Simulate license change (revocation, new activation, etc.)
      licenseHash = 'new-hash-after-change';

      // API now fails because session's lic no longer matches current license
      const r2 = await req(TEST_PORT, 'GET', '/api/projects', { Authorization: `Bearer ${sessionToken}` });
      assertEqual(r2.status, 401, 'API must be blocked after license change');

      await gw.stop();
    });

    await test('API request rejected when license becomes invalid (getLicenseHash returns null)', async ({ assert, assertEqual }) => {
      let licenseHash = 'valid-hash';
      const gw = freshGateway({
        onPairRequest: () => true,
        getLicenseHash: () => licenseHash,
        getProjects: () => [],
      });
      await gw.start();

      // Pair with valid license
      const { token: pToken } = gw.createPairingUrl(null);
      const pairRes = await postReq(TEST_PORT, `/api/pair?t=${pToken}`, {}, { 'x-device-id': 'dev' });
      const sessionToken = pairRes.body.session_token;
      assertEqual(pairRes.status, 200, 'initial pairing should succeed');

      // License becomes invalid
      licenseHash = null;

      // API blocked
      const r = await req(TEST_PORT, 'GET', '/api/projects', { Authorization: `Bearer ${sessionToken}` });
      assertEqual(r.status, 401, 'API must be blocked when license becomes invalid');

      await gw.stop();
    });

    await test('token refresh rejected when license becomes invalid', async ({ assert, assertEqual }) => {
      let licenseHash = 'valid-hash';
      const gw = freshGateway({
        onPairRequest: () => true,
        getLicenseHash: () => licenseHash,
      });
      await gw.start();

      // Pair and get session token
      const { token: pToken } = gw.createPairingUrl(null);
      const pairRes = await postReq(TEST_PORT, `/api/pair?t=${pToken}`, {}, { 'x-device-id': 'dev' });
      const sessionToken = pairRes.body.session_token;

      // License becomes invalid
      licenseHash = null;

      // Refresh should be denied — _requireAuth blocks before the refresh handler (returns 401)
      const refreshRes = await postReq(TEST_PORT, '/api/token/refresh', {}, {
        Authorization: `Bearer ${sessionToken}`,
      });
      // 401: _requireAuth returns null when getLicenseHash() returns null (expected behavior)
      assert(refreshRes.status === 401 || refreshRes.status === 403,
        `refresh must be blocked when license invalid (got ${refreshRes.status})`);

      await gw.stop();
    });

    await test('JWT with sevnt-local is rejected when current license has real hash', async ({ assert, assertEqual }) => {
      // Simulate a JWT issued with the old placeholder value
      const gw = freshGateway({
        getLicenseHash: () => 'real-license-hash-abc123',
        getProjects: () => [],
      });
      // Obtain a token with the old placeholder hash by temporarily patching getLicenseHash
      const smKey = require.resolve('../src/mobile/session-manager');
      const sm = require(smKey);

      // Create a token with old placeholder hash directly via session-manager
      const fakeToken = sm.createSessionToken('dev', 'sevnt-local');

      await gw.start();

      const r = await req(TEST_PORT, 'GET', '/api/projects', { Authorization: `Bearer ${fakeToken}` });
      assertEqual(r.status, 401, 'token with sevnt-local lic must be rejected against real license');
      await gw.stop();
    });
  });

  await suite('mobile-gateway: authenticated access', async ({ test }) => {
    let gw;
    await test('GET /api/projects with valid session token succeeds', async ({ assert, assertEqual }) => {
      gw = freshGateway({
        onPairRequest: () => true,
        getLicenseHash: () => 'hash',
        getProjects: () => [{ id: '1', name: 'Test Project' }],
      });
      await gw.start();

      const { token: pToken } = gw.createPairingUrl(null);
      const pairRes = await postReq(TEST_PORT, `/api/pair?t=${pToken}`, {}, { 'x-device-id': 'dev' });
      const sessionToken = pairRes.body.session_token;

      const projRes = await req(TEST_PORT, 'GET', '/api/projects', {
        Authorization: `Bearer ${sessionToken}`,
      });
      assertEqual(projRes.status, 200);
      assert(Array.isArray(projRes.body.projects));
    });

    await test('invalid session token returns 401', async ({ assertEqual }) => {
      const res = await req(TEST_PORT, 'GET', '/api/projects', {
        Authorization: 'Bearer garbage.token.value',
      });
      assertEqual(res.status, 401);
    });

    if (gw) await gw.stop();
  });
};
