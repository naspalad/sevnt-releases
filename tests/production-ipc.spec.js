'use strict';

const { test, expect } = require('@playwright/test');
const {
  launchProductionApp, findProductionRenderer, closeProductionApp, cleanupProductionProfile,
} = require('./helpers/production-electron.cjs');

test.describe('SEVNT production IPC — real Electron main + real preload', () => {
  test.setTimeout(120000);
  let app;
  let page;

  test.beforeAll(async () => {
    app = await launchProductionApp();
    page = await findProductionRenderer(app);
  });

  test.afterAll(async () => {
    await closeProductionApp(app);
    cleanupProductionProfile();
  });

  test('loads production bridge and invokes safe read-only IPC handlers', async () => {
    const result = await page.evaluate(async () => {
      const api = window.socl;
      const required = [
        'getSettings', 'setSettings', 'appInfo', 'getLicense',
        'listHistory', 'history', 'whisper', 'ctxModel',
        'engines', 'telegram', 'mobile', 'diskUsage',
      ];
      const missing = required.filter(name => !(name in api));
      const calls = {};
      const invoke = async (name, fn) => {
        try { calls[name] = { ok: true, value: await fn() }; }
        catch (error) { calls[name] = { ok: false, error: String(error && error.message || error) }; }
      };

      await invoke('getSettings', () => api.getSettings());
      await invoke('appInfo', () => api.appInfo());
      await invoke('listHistory', () => api.listHistory());
      await invoke('history.inspect', () => api.history.inspect([]));
      await invoke('history.stat', () => api.history.stat([]));
      await invoke('whisper.status', () => api.whisper.status('tiny'));
      await invoke('ctxModel.status', () => api.ctxModel.status());
      await invoke('engines.status', () => api.engines.status());
      await invoke('telegram.status', () => api.telegram.status());
      await invoke('mobile.status', () => api.mobile.status());
      return { missing, calls };
    });

    expect(result.missing, 'required production preload APIs').toEqual([]);
    for (const [name, outcome] of Object.entries(result.calls)) {
      expect(outcome.ok, name + ' must reach a registered production IPC handler: ' + outcome.error).toBe(true);
    }
    expect(result.calls.appInfo.value).toBeTruthy();
    expect(result.calls.getSettings.value).toBeTruthy();
    expect(result.calls['history.inspect'].value).toBeTruthy();
  });
});
