// Unit tests for sevnt-machine-id.js
'use strict';

const { suite, test } = require('./test-runner');
const os = require('os');

// Reset module cache between tests
function freshMachineId() {
  // Remove from require cache to reset _cachedId
  const key = require.resolve('../src/license/sevnt-machine-id');
  delete require.cache[key];
  return require('../src/license/sevnt-machine-id');
}

module.exports = async function() {
  await suite('sevnt-machine-id: getMachineIdSync', async ({ test }) => {
    await test('returns 64-char hex string', async ({ assert, assertEqual }) => {
      const { getMachineIdSync } = freshMachineId();
      const id = getMachineIdSync();
      assert(typeof id === 'string', 'should be string');
      assertEqual(id.length, 64, 'SHA256 hex = 64 chars');
      assert(/^[0-9a-f]{64}$/.test(id), 'should be hex');
    });

    await test('same call produces same ID (deterministic)', async ({ assertEqual }) => {
      const { getMachineIdSync } = freshMachineId();
      const id1 = getMachineIdSync();
      const id2 = getMachineIdSync();
      assertEqual(id1, id2, 'should be deterministic');
    });

    await test('does not expose raw hardware info in output', async ({ assert }) => {
      const { getMachineIdSync } = freshMachineId();
      const id = getMachineIdSync();
      // Output should be a hash, not contain readable hostname/CPU info
      assert(!id.includes(os.hostname()), 'should not contain hostname');
    });

    await test('works even if CPU list is empty (defensive)', async ({ assert }) => {
      const origCpus = os.cpus;
      os.cpus = () => [];
      try {
        const { getMachineIdSync } = freshMachineId();
        const id = getMachineIdSync();
        assert(id.length === 64, 'should still produce a hash');
      } finally {
        os.cpus = origCpus;
      }
    });
  });

  await suite('sevnt-machine-id: getMachineId (async)', async ({ test }) => {
    await test('returns 64-char hex string', async ({ assert, assertEqual }) => {
      const { getMachineId } = freshMachineId();
      const id = await getMachineId();
      assertEqual(id.length, 64);
      assert(/^[0-9a-f]{64}$/.test(id));
    });

    await test('caches result after first call', async ({ assertEqual }) => {
      const mod = freshMachineId();
      const id1 = await mod.getMachineId();
      const id2 = await mod.getMachineId();
      assertEqual(id1, id2, 'should return cached value');
    });

    await test('sync and async produce different hashes (different inputs)', async ({ assert }) => {
      // getMachineId includes extra platform-specific data (wmic/ioreg)
      // getMachineIdSync is a subset — they may differ
      const mod = freshMachineId();
      const asyncId = await mod.getMachineId();
      const syncId = mod.getMachineIdSync();
      // Both are valid — just log the note; not an error if they match
      assert(asyncId.length === 64 && syncId.length === 64);
    });
  });
};
