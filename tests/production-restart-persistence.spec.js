'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const {
  PROFILE, launchProductionApp, findProductionRenderer, closeProductionApp, cleanupProductionProfile,
} = require('./helpers/production-electron.cjs');

test.describe('SEVNT production restart persistence — isolated QA userData', () => {
  test.setTimeout(180000);

  test('settings written through real IPC survive a full Electron process restart', async () => {
    const marker = 'restart-' + process.pid + '-' + Date.now();
    let app;

    try {
      app = await launchProductionApp();
      let page = await findProductionRenderer(app);
      const before = await page.evaluate(() => window.socl.getSettings());
      expect(before).toBeTruthy();

      const write = await page.evaluate(async ({ before, marker }) => {
        const next = { ...(before || {}), __sevntQaRestartProbe: marker };
        const saved = await window.socl.setSettings(next);
        const readBack = await window.socl.getSettings();
        return { saved, readBack };
      }, { before, marker });

      expect(write.readBack && write.readBack.__sevntQaRestartProbe).toBe(marker);
      await closeProductionApp(app);
      app = null;

      app = await launchProductionApp();
      page = await findProductionRenderer(app);
      const afterRestart = await page.evaluate(() => window.socl.getSettings());
      expect(afterRestart && afterRestart.__sevntQaRestartProbe).toBe(marker);
    } finally {
      await closeProductionApp(app);
      cleanupProductionProfile();
    }

    expect(fs.existsSync(PROFILE)).toBe(false);
  });
});
