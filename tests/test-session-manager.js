// Unit tests for session-manager.js
'use strict';

const { suite, test } = require('./test-runner');

function freshSessionManager() {
  const key = require.resolve('../src/mobile/session-manager');
  delete require.cache[key];
  return require('../src/mobile/session-manager');
}

module.exports = async function() {
  await suite('session-manager: pairing tokens', async ({ test }) => {
    await test('createPairingToken returns 64-char hex token', async ({ assert, assertEqual }) => {
      const sm = freshSessionManager();
      const { token, expiresAt } = sm.createPairingToken();
      assert(/^[0-9a-f]{64}$/.test(token), 'token should be 64 hex chars');
      assert(expiresAt > Date.now(), 'expiresAt should be in the future');
    });

    await test('token expires in ~5 minutes', async ({ assert }) => {
      const sm = freshSessionManager();
      const { expiresAt } = sm.createPairingToken();
      const diff = expiresAt - Date.now();
      assert(diff > 4 * 60 * 1000, 'should expire > 4 min from now');
      assert(diff <= 5 * 60 * 1000 + 100, 'should expire <= 5 min from now');
    });

    await test('valid token can be consumed once', async ({ assert }) => {
      const sm = freshSessionManager();
      const { token } = sm.createPairingToken();
      assert(sm.consumePairingToken(token) === true, 'first consume should succeed');
    });

    await test('token cannot be consumed twice (one-use)', async ({ assert }) => {
      const sm = freshSessionManager();
      const { token } = sm.createPairingToken();
      sm.consumePairingToken(token);
      assert(sm.consumePairingToken(token) === false, 'second consume should fail');
    });

    await test('invalid token returns false', async ({ assert }) => {
      const sm = freshSessionManager();
      assert(sm.consumePairingToken('deadbeef') === false);
    });

    await test('each createPairingToken produces unique token', async ({ assert }) => {
      const sm = freshSessionManager();
      const t1 = sm.createPairingToken().token;
      const t2 = sm.createPairingToken().token;
      assert(t1 !== t2, 'tokens should be unique');
    });
  });

  await suite('session-manager: JWT session tokens', async ({ test }) => {
    await test('createSessionToken returns a 3-part JWT', async ({ assert }) => {
      const sm = freshSessionManager();
      const token = sm.createSessionToken('device-abc', 'licensehash123');
      const parts = token.split('.');
      assert(parts.length === 3, 'JWT should have 3 parts');
    });

    await test('verifySessionToken returns claims for valid token', async ({ assert }) => {
      const sm = freshSessionManager();
      const token = sm.createSessionToken('device-abc', 'hash123');
      const claims = sm.verifySessionToken(token);
      assert(claims !== null, 'should return claims');
      assert(claims.sub === 'device-abc', 'sub should match deviceId');
      assert(claims.role === 'COMPANION_DEVICE', 'role should be set');
    });

    await test('invalid token returns null', async ({ assert }) => {
      const sm = freshSessionManager();
      assert(sm.verifySessionToken('not.a.token') === null);
    });

    await test('tampered token returns null', async ({ assert }) => {
      const sm = freshSessionManager();
      const token = sm.createSessionToken('device-abc', 'hash');
      // Tamper with payload
      const parts = token.split('.');
      const fakePayload = Buffer.from(JSON.stringify({ sub: 'hacked', role: 'admin' })).toString('base64');
      const tampered = `${parts[0]}.${fakePayload}.${parts[2]}`;
      assert(sm.verifySessionToken(tampered) === null, 'tampered token should fail');
    });

    await test('revokeAllSessions invalidates existing tokens', async ({ assert }) => {
      const sm = freshSessionManager();
      const token = sm.createSessionToken('device-abc', 'hash');
      sm.revokeAllSessions();
      assert(sm.verifySessionToken(token) === null, 'revoked session should not verify');
    });

    await test('getActiveSessionCount reflects active sessions', async ({ assert, assertEqual }) => {
      const sm = freshSessionManager();
      assertEqual(sm.getActiveSessionCount(), 0, 'starts at 0');
      sm.createSessionToken('d1', 'h1');
      assertEqual(sm.getActiveSessionCount(), 1);
      sm.createSessionToken('d2', 'h2');
      assertEqual(sm.getActiveSessionCount(), 2);
      sm.revokeAllSessions();
      assertEqual(sm.getActiveSessionCount(), 0);
    });

    await test('rotateSessionToken returns new valid token', async ({ assert }) => {
      const sm = freshSessionManager();
      const { rotateSessionToken } = sm;
      const token1 = sm.createSessionToken('dev', 'hash');
      const token2 = sm.rotateSessionToken(token1);
      assert(token2 !== null, 'rotation should return new token');
      assert(token2 !== token1, 'new token should differ');
      assert(sm.verifySessionToken(token2) !== null, 'new token should be valid');
      assert(sm.verifySessionToken(token1) === null, 'old token should be invalid after rotation');
    });

    await test('rotateSessionToken on invalid token returns null', async ({ assert }) => {
      const sm = freshSessionManager();
      assert(sm.rotateSessionToken('bad.token.here') === null);
    });

    await test('token not in sessions map returns null', async ({ assert }) => {
      // Forge a structurally valid JWT with wrong jti
      const sm = freshSessionManager();
      // Create a token from a fresh module (different key pair)
      const sm2 = freshSessionManager();
      const token = sm2.createSessionToken('dev', 'hash');
      // Try to verify with original sm (different key)
      assert(sm.verifySessionToken(token) === null, 'token from different key should fail');
    });
  });
};
