'use strict';

const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.describe('SEVNT menu interaction regression (isolated QA bridge)', () => {
  test.setTimeout(90000);
  let app, page;

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [path.join(__dirname, 'qa-electron-main.cjs')],
      timeout: 30000,
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#clipsPage')).toBeVisible({ timeout: 30000 });
    await page.evaluate(() => window.qaBridge.resetCalls());
  });

  test.afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  const calls = async () => page.evaluate(() => window.qaBridge.getCalls());

  test('Clips/source menu exposes import, transcript and pipeline actions', async () => {
    await expect(page.locator('#urlInput')).toBeVisible();
    await expect(page.locator('#pickVideo')).toBeAttached();
    await expect(page.locator('#im_attach')).toBeAttached();
    await expect(page.locator('#runPipeline')).toBeVisible();

    await page.locator('#pickVideo').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'pickVideo')).toBe(true);

    await page.locator('#im_attach').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'pickSubtitle')).toBe(true);
  });

  test('Clip Settings controls accept changes and expose the configuration groups', async () => {
    await page.locator('.rail-btn[data-panel="clip"]').click();
    await expect(page.locator('#panelTitle')).toContainText(/clip/i);
    await expect(page.locator('#f_fastQ')).toBeAttached();
    await expect(page.locator('#f_burnQ')).toBeAttached();
    await expect(page.locator('#f_subtitleLang')).toBeAttached();

    await page.locator('#f_fastQ').check({ force: true });
    await page.locator('#f_burnQ').check({ force: true });
    await page.locator('#f_subtitleLang').selectOption('id');
    await expect(page.locator('#f_fastQ')).toBeChecked();
    await expect(page.locator('#f_burnQ')).toBeChecked();
    await expect(page.locator('#f_subtitleLang')).toHaveValue('id');
  });

  test('Watermark controls update anchor, geometry and text rows', async () => {
    await page.locator('.rail-btn[data-panel="watermark"]').click();
    await expect(page.locator('#wmAnchorGrid')).toBeVisible();
    await expect(page.locator('#wm_file')).toBeAttached();
    await expect(page.locator('#wm_x')).toBeAttached();
    await expect(page.locator('#wm_y')).toBeAttached();
    await expect(page.locator('#wm_size')).toBeAttached();
    await expect(page.locator('#wm_op')).toBeAttached();

    await page.locator('.wm-anchor-cell[data-anchor="tl"]').click();
    await page.locator('#wm_x').evaluate(el => {
      el.value = '12';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#wm_line_add').click();
    await expect(page.locator('#wmLines .wm-line')).toHaveCount(1);
    await page.locator('#wmLines .wm-line-text').fill('SEVNT QA');

    await expect.poll(async () => (await calls()).some(x => x.name === 'setSettings')).toBe(true);
  });

  test('Crop panel exposes both editing modes and correctly gates them without a selected clip', async () => {
    await page.locator('.rail-btn[data-panel="crop"]').click();
    await expect(page.locator('#openCropStudioBtn')).toBeAttached();
    await expect(page.locator('#openGamingSplitStudioBtn')).toBeAttached();
    // A real clip is required to enable these actions. This isolated dashboard
    // test has no imported/rendered clip, so do not misreport crop execution.
    await expect(page.locator('#openCropStudioBtn')).toBeDisabled();
    await expect(page.locator('#openGamingSplitStudioBtn')).toBeDisabled();
  });

  test('History controls load, search and request a new session', async () => {
    await page.locator('.rail-btn[data-panel="history"]').click();
    await expect(page.locator('#historyPage')).toBeVisible();
    await expect(page.locator('#hpSearch')).toBeVisible();
    await page.locator('#hpSearch').fill('qa-search');
    await page.locator('#hpRefresh').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'listHistory')).toBe(true);
    await page.locator('#hpNew').click();
    await expect(page.locator('#clipsPage')).toBeVisible();
  });

  test('Settings save and provider test controls invoke their QA bridge methods', async () => {
    await page.locator('.rail-btn[data-panel="settings"]').click();
    await expect(page.locator('#settingsView')).toBeVisible();
    await expect(page.locator('#sv_save')).toBeVisible();
    await page.locator('#sv_save').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'setSettings')).toBe(true);

    await expect(page.locator('#sv_geminiTest')).toBeAttached();
    if (await page.locator('#sv_geminiTest').isEnabled()) {
      await page.locator('#sv_geminiTest').click();
      await expect.poll(async () => (await calls()).some(x => x.name === 'testProvider')).toBe(true);
    }
    await expect(page.locator('#sv_secLicense')).toBeVisible();
    // License activation is intentionally not attempted by this suite.
  });

  test('Help, theme and Output controls remain reachable', async () => {
    await page.locator('#helpBtn').click();
    await expect(page.locator('#helpView')).toBeVisible();
    await page.locator('#railClipsBtn').click();
    await page.locator('#themeToggle').click();
    await page.locator('#openOutputBtn').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'openOutput')).toBe(true);
  });
});
