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

  async function seedQaClips() {
    await page.locator('#pickVideo').click();
    await page.locator('#runPipeline').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(2, { timeout: 60000 });
  }

  test('Clips imports the prepared video and attaches/clears a transcript', async () => {
    await expect(page.locator('#urlInput')).toBeVisible();
    await expect(page.locator('#pickVideo')).toBeAttached();
    await expect(page.locator('#im_attach')).toBeAttached();
    await expect(page.locator('#runPipeline')).toBeVisible();

    await page.locator('#pickVideo').click();
    await expect(page.locator('#importMeta')).toBeVisible();
    await expect(page.locator('#im_file')).toContainText('qa-source.mp4');
    await expect.poll(async () => (await calls()).some(x => x.name === 'pickVideo')).toBe(true);

    await expect(page.locator('#im_attach')).toBeVisible();
    await page.locator('#im_attach').click();
    await expect(page.locator('#im_sub')).toBeVisible();
    await expect(page.locator('#im_sub')).toContainText('qa-transcript.srt');
    await expect.poll(async () => (await calls()).some(x => x.name === 'pickSubtitle')).toBe(true);

    await page.locator('#im_subClear').click();
    await expect(page.locator('#im_sub')).toBeHidden();
    await expect(page.locator('#im_subClear')).toBeHidden();

    // The isolated QA bridge still mocks runPipeline; highlight detection and
    // real render coverage are deliberately not asserted by this import test.
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
    await expect(page.locator('#wmLines .wm-line')).toHaveCount(2);
    await page.locator('#wmLines .wm-line-text').first().fill('SEVNT QA');

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
    await page.locator('.sv-jump button[data-tab="license"]').click();
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

  test('Clips runs deterministic highlights, filters, selection, preview and real FFmpeg batch render', async () => {
    await page.locator('#pickVideo').click();
    await expect(page.locator('#im_file')).toContainText('qa-source.mp4');
    await page.locator('#runPipeline').click();

    await expect(page.locator('.gtl-tile')).toHaveCount(2, { timeout: 60000 });
    await expect(page.locator('.gtl-tile').first()).toContainText('QA Highlight One');
    await expect(page.locator('.gtl-tile').last()).toContainText('QA Highlight Two');

    await page.locator('#galleryChips [data-filter="hot"]').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(2);
    await page.locator('#galleryChips [data-filter="saved"]').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(0);
    await page.locator('#galleryChips [data-filter="all"]').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(2);

    await page.locator('#selectModeBtn').click();
    await page.locator('#selAllBtn').click();
    await expect(page.locator('#selCount')).toContainText('2');
    await expect(page.locator('#selRenderBtn')).toBeEnabled();
    await page.locator('#selClearBtn').click();
    await expect(page.locator('#selCount')).toContainText('0');
    await page.locator('#selDoneBtn').click();

    await page.locator('.gtl-tile').first().click();
    await page.locator('#nextArrow').click();
    await expect(page.locator('.gtl-tile.gtl-active')).toHaveAttribute('data-idx', '1');

    await expect(page.locator('#gb_renderAll')).toBeVisible();
    await page.locator('#gb_renderAll').click();
    await expect.poll(async () => (await calls()).filter(x => x.name === 'renderEdit').length).toBe(2, { timeout: 60000 });
    await expect.poll(async () => (await calls()).filter(x => x.name === 'ffmpegRender').length).toBeGreaterThanOrEqual(4, { timeout: 60000 });
  });


  test('Editor opens for a rendered clip and exposes editable caption controls', async () => {
    await seedQaClips();
    await page.locator('#openEditorBtn').click();
    await expect(page.locator('#captionStudio')).toBeVisible();
    await expect(page.locator('#captionStudioBody')).not.toBeEmpty();
    await expect(page.locator('#captionStudioBody input, #captionStudioBody textarea, #captionStudioBody button').first()).toBeAttached();
    await page.locator('#csEditorClose').click();
    await expect(page.locator('#captionStudio')).toBeHidden();
  });

  test('Crop Studio changes aspect, zoom, keyframes and applies crop to the clip', async () => {
    await seedQaClips();
    await page.locator('.rail-btn[data-panel="crop"]').click();
    await page.locator('#openCropStudioBtn').click();
    await expect(page.locator('#cropStudio')).toBeVisible();
    await expect.poll(() => page.locator('#csVideo').evaluate(v => v.readyState >= 1)).toBe(true, { timeout: 30000 });

    for (const aspect of ['1:1', '16:9', 'free', '9:16']) {
      await page.locator('#csAspect button[data-a="' + aspect + '"]').click();
      await expect(page.locator('#csAspect button[data-a="' + aspect + '"]')).toHaveClass(/active/);
    }
    await page.locator('#csZoom').evaluate(el => {
      el.value = '70';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#csZoomVal')).toContainText('70%');
    await page.locator('#csAddKf').click();
    await expect(page.locator('#csKfCount')).toContainText('1');
    await page.locator('#csApplyAll').click();
    await page.locator('#csRender').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'applyCrop'), { timeout: 60000 }).toBe(true);
  });

  test('Split Studio handles two sources, mute, swap, ratio, keyframes and apply', async () => {
    await seedQaClips();
    await page.locator('.rail-btn[data-panel="crop"]').click();
    await page.locator('#openGamingSplitStudioBtn').click();
    await expect(page.locator('#splitStudio')).toBeVisible();
    await page.locator('#ssToggleV2').click();
    await expect.poll(() => page.locator('#ssVideo2').evaluate(v => v.readyState >= 1), { timeout: 30000 }).toBe(true);
    await expect(page.locator('#ssRemoveV2')).toBeVisible();
    await page.locator('#ssMute1').click();
    await page.locator('#ssMute2').click();
    await page.locator('#ssSplitRatio').evaluate(el => {
      el.value = '60';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#ssSplitRatio')).toHaveValue('60');
    await page.locator('#ssSwapBtn').click();
    await page.locator('#ssAddKf').click();
    await expect(page.locator('#ssKfCount')).toContainText('1');
    await page.locator('#ssApply').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'applyCrop'), { timeout: 60000 }).toBe(true);
  });

});