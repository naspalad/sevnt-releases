'use strict';
// SEVNT Phase 5B — Automated tests for IPC wiring, slot limit, and security

const { suite, test } = require('./test-runner');

function freshIpcModule() {
  // Clear module caches for fresh state
  [
    '../src/sevnt-mobile-ipc',
    '../src/mobile/pairing-manager',
  ].forEach(m => {
    try { delete require.cache[require.resolve(m)]; } catch {}
  });

  const handlers = {};
  const mockIpcMain = {
    handle: (ch, fn) => { handlers[ch] = fn; },
    once:   ()       => {},
  };

  // Minimal PairingManager mock
  class MockPairingManager {
    constructor() { this._running = false; }
    async startPairing() {
      this._running = true;
      return { pairingUrl: 'http://192.168.1.1:7474/api/pair?t=tok', mode: 'lan', lanUrl: 'http://192.168.1.1:7474' };
    }
    async stopPairing() { this._running = false; }
    get isActive() { return this._running; }
    get tunnelUrl() { return null; }
    get _gateway() {
      return { createPairingUrl: () => ({ pairingUrl: 'http://test/api/pair?t=xyz', token: 'xyz' }) };
    }
  }

  // Override require resolution for this module
  const originalLoad = require.extensions['.js'];
  const mod = new module.constructor();
  mod.filename = require.resolve('../src/sevnt-mobile-ipc');
  mod.paths = module.paths;

  // Monkey-patch via vm-less approach: replace in module cache with instrumented version
  // We use a fresh require by temporarily hooking Module._resolveFilename
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const origLoad2 = Module._load;

  Module._load = function(id, parent, isMain) {
    if (id === 'electron') return { ipcMain: mockIpcMain, BrowserWindow: {} };
    if (id.endsWith('/pairing-manager') || id === './mobile/pairing-manager') {
      return { PairingManager: MockPairingManager };
    }
    if (id === 'qrcode') {
      // Mock qrcode for tests
      return { toString: (url, opts, cb) => cb(null, '<svg>mock-qr</svg>') };
    }
    if (id.endsWith('/license-status') || id.endsWith('license/license-status')) {
      // Mock license as valid for IPC lifecycle tests
      return { getLicenseStatus: async () => ({ valid: true, licenseHash: 'test-hash' }) };
    }
    return origLoad2.call(this, id, parent, isMain);
  };

  delete require.cache[require.resolve('../src/sevnt-mobile-ipc')];
  const ipcModule = require('../src/sevnt-mobile-ipc');
  ipcModule.registerMobileIpc();

  Module._load = origLoad2;

  return { ipcModule, handlers };
}

module.exports = async function() {
  await suite('mobile-ipc-5b: exports', async ({ test }) => {
    await test('registerMobileIpc, setMainWindow, stopGateway exported', ({ assert }) => {
      const { ipcModule } = freshIpcModule();
      assert(typeof ipcModule.registerMobileIpc === 'function', 'registerMobileIpc must be function');
      assert(typeof ipcModule.setMainWindow === 'function', 'setMainWindow must be function');
      assert(typeof ipcModule.stopGateway === 'function', 'stopGateway must be function (BUG-5B-001 fix)');
    });
  });

  await suite('mobile-ipc-5b: IPC handler registration', async ({ test }) => {
    await test('all 8 mobile: channels registered', ({ assert }) => {
      const { handlers } = freshIpcModule();
      const required = ['mobile:start','mobile:stop','mobile:status','mobile:getPairingUrl','mobile:generateQr','mobile:approve','mobile:reject','mobile:syncProjects'];
      const missing = required.filter(ch => typeof handlers[ch] !== 'function');
      assert(missing.length === 0, `Missing handlers: ${missing.join(', ')}`);
    });
  });

  await suite('mobile-ipc-5b: gateway lifecycle', async ({ test }) => {
    await test('mobile:start succeeds when no device connected', async ({ assert }) => {
      const { handlers } = freshIpcModule();
      const result = await handlers['mobile:start']({});
      assert(result.ok === true, 'start should succeed: ' + JSON.stringify(result));
      assert(typeof result.pairingUrl === 'string', 'pairingUrl should be string');
      await handlers['mobile:stop']({});
    });

    await test('mobile:stop returns ok', async ({ assert }) => {
      const { handlers } = freshIpcModule();
      await handlers['mobile:start']({});
      const result = await handlers['mobile:stop']({});
      assert(result.ok === true, 'stop should return ok');
    });

    await test('mobile:status returns correct shape', ({ assert }) => {
      const { handlers } = freshIpcModule();
      const status = handlers['mobile:status']({});
      assert(typeof status.running === 'boolean', 'running must be boolean');
      assert('connectedDevice' in status, 'must have connectedDevice');
    });
  });

  await suite('mobile-ipc-5b: 1-device slot limit (BUG-5B-003)', async ({ test }) => {
    await test('second start rejected when device connected', async ({ assert, assertEqual }) => {
      const { handlers, ipcModule } = freshIpcModule();
      // Simulate connected device via test helper
      ipcModule._testSetConnected({ connectedAt: Date.now() });
      // Start should fail with companion_slot_occupied
      const second = await handlers['mobile:start']({});
      assert(second.ok === false, 'start must fail when device connected');
      assertEqual(second.error, 'companion_slot_occupied');
      // Cleanup
      await handlers['mobile:stop']({});
    });

    await test('start succeeds after stop clears slot', async ({ assert }) => {
      const { handlers, ipcModule } = freshIpcModule();
      ipcModule._testSetConnected({ connectedAt: Date.now() });
      await handlers['mobile:stop']({});
      const result = await handlers['mobile:start']({});
      assert(result.ok === true, 'start after stop should succeed');
      await handlers['mobile:stop']({});
    });
  });

  await suite('mobile-ipc-5b: approval/rejection', async ({ test }) => {
    await test('approve with no pending does not throw', async ({ assert }) => {
      const { handlers } = freshIpcModule();
      const r = await handlers['mobile:approve']({});
      assert(r.ok === true);
    });

    await test('reject with no pending does not throw', async ({ assert }) => {
      const { handlers } = freshIpcModule();
      const r = await handlers['mobile:reject']({});
      assert(r.ok === true);
    });
  });

  await suite('mobile-ipc-5b: project sync', async ({ test }) => {
    await test('syncProjects stores list', async ({ assert }) => {
      const { handlers } = freshIpcModule();
      const projects = [{ id: 'job-1', name: 'Video 1', clips: 2, status: 'done' }];
      const r = await handlers['mobile:syncProjects']({}, projects);
      assert(r.ok === true, 'syncProjects should return ok');
    });

    await test('syncProjects ignores non-array input', async ({ assert }) => {
      const { handlers } = freshIpcModule();
      const r = await handlers['mobile:syncProjects']({}, 'invalid');
      assert(r.ok === true, 'should not throw on non-array');
    });
  });

  await suite('mobile-ipc-5b: stopGateway safe call', async ({ test }) => {
    await test('stopGateway does not throw before any start', async ({ assert }) => {
      const { ipcModule } = freshIpcModule();
      let threw = false;
      try { await ipcModule.stopGateway(); } catch { threw = true; }
      assert(!threw, 'stopGateway should not throw when no manager');
    });
  });
};
