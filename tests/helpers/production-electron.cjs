'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-production-qa-'));

function qaEnv() {
  return {
    ...process.env,
    SEVNT_QA_MODE: '1',
    SEVNT_QA_USER_DATA: PROFILE,
    SEVNT_ENGINE_DISABLED: '1',
    SEVNT_QA_ARTIFACT_DIR: path.join(PROFILE, 'artifacts'),
  };
}

async function launchProductionApp() {
  fs.mkdirSync(path.join(PROFILE, 'artifacts'), { recursive: true });
  return electron.launch({ args: [ROOT], env: qaEnv(), timeout: 60000 });
}

async function findProductionRenderer(app, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      try {
        const ready = await page.evaluate(() =>
          !!(window.socl && typeof window.socl.getSettings === 'function' &&
             typeof window.socl.renderEdit === 'function')
        );
        if (ready) {
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          return page;
        }
      } catch (error) { lastError = error; }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Production renderer with src/preload.js did not become ready. ' +
    (lastError ? lastError.message : 'No window exposed window.socl.'));
}

async function closeProductionApp(app) {
  if (app) await app.close().catch(() => {});
}

function cleanupProductionProfile() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

module.exports = { ROOT, PROFILE, launchProductionApp, findProductionRenderer, closeProductionApp, cleanupProductionProfile };
