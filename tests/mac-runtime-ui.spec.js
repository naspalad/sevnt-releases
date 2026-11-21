const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.describe('SEVNT macOS isolated dashboard runtime', () => {
  test.setTimeout(90000);
  let app, page;

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [path.join(__dirname, 'qa-electron-main.cjs')],
      timeout: 30000,
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#panelBody')).toBeVisible({ timeout: 30000 });
  });

  test.afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  test('main renderer loads without uncaught page errors', async () => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForTimeout(1200);
    expect(await page.title()).not.toBe('');
    expect(await page.locator('#railClipsBtn').count()).toBe(1);
    expect(errors).toEqual([]);
  });

  test('Clip, Watermark and Crop open their real panels', async () => {
    await page.locator('.rail-btn[data-panel="clip"]').click();
    await expect(page.locator('#panelTitle')).toContainText(/clip/i);

    await page.locator('.rail-btn[data-panel="watermark"]').click();
    await expect(page.locator('#panelTitle')).toHaveText('Watermark');
    await expect(page.locator('#wm_enabled')).toBeAttached();

    await page.locator('.rail-btn[data-panel="crop"]').click();
    await expect(page.locator('#panelTitle')).toHaveText('Crop Studio');
    await expect(page.locator('#openCropStudioBtn')).toBeAttached();
  });

  test('History, Mobile, Help and Settings open their dedicated views', async () => {
    await page.locator('.rail-btn[data-panel="history"]').click();
    await expect(page.locator('#historyPage')).toBeVisible();

    await page.locator('#mobileBtn').click();
    await expect(page.locator('#mobileStartBtn')).toBeVisible();

    await page.locator('#helpBtn').click();
    await expect(page.locator('#helpView')).toBeVisible();

    await page.locator('.rail-btn[data-panel="settings"]').click();
    await expect(page.locator('#settingsView')).toBeVisible();
  });

  test('Editor without a rendered clip shows a safe prompt; Output calls native bridge', async () => {
    await page.locator('#openEditorBtn').click();
    await expect(page.locator('.toast')).toContainText(/Pilih klip/i);

    await page.evaluate(() => window.qaBridge.resetCalls());
    await page.locator('#openOutputBtn').click();
    await expect.poll(async () => page.evaluate(() => window.qaBridge.getCalls().some(x => x.name === 'openOutput'))).toBe(true);
  });

  test('Clips button returns to the source/results home', async () => {
    await page.locator('#helpBtn').click();
    await expect(page.locator('#helpView')).toBeVisible();
    await page.locator('#railClipsBtn').click();
    await expect(page.locator('#helpView')).toBeHidden();
    await expect(page.locator('#clipsPage')).not.toHaveClass(/page-hidden/);
  });
});
