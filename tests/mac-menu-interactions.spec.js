'use strict';

const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

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

    await page.locator('#wm_file').setInputFiles({
      name: 'qa-watermark.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64'),
    });
    await expect.poll(async () => (await calls()).some(x => x.name === 'watermark.saveAsset'), { timeout: 15000 }).toBe(true);
    await expect(page.locator('#wm_enabled')).toBeChecked();
    await page.locator('#wm_enabled').uncheck({ force: true });
    await expect(page.locator('#wm_enabled')).not.toBeChecked();
    await page.locator('#wm_enabled').check({ force: true });
    await page.locator('.wm-anchor-cell[data-anchor="tl"]').click();

    for (const [id, value] of [['#wm_x', '12'], ['#wm_y', '14'], ['#wm_size', '22'], ['#wm_op', '45']]) {
      await page.locator(id).evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    }
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

  test('Settings exercise all provider key lifecycles, models, ASR, save and license controls', async () => {
    await page.locator('.rail-btn[data-panel="settings"]').click();
    await expect(page.locator('#settingsView')).toBeVisible();
    const providers = ['gemini', 'groq', 'openai', 'openrouter', 'anthropic', 'sumopod'];

    for (const provider of providers) {
      const key = page.locator('#sv_' + provider + 'Key');
      const testButton = page.locator('#sv_' + provider + 'Test');
      const delButton = page.locator('#sv_' + provider + 'Del');
      await key.fill('qa-' + provider + '-not-a-real-secret');
      await expect(testButton).toBeEnabled();
      await testButton.click();
      await expect.poll(async () => (await calls()).filter(x => x.name === 'testProvider').length, { timeout: 15000 }).toBeGreaterThan(providers.indexOf(provider));
      await expect(delButton).toBeVisible();
      await delButton.click();
      await expect(delButton).toHaveText('Yakin?');
      await delButton.click();
      await expect(delButton).toBeHidden();
    }

    await page.locator('#sv_geminiModel').selectOption({ index: 0 });
    await page.locator('#sv_groqModel').selectOption({ index: 0 });
    await page.locator('#sv_asrEngine').selectOption({ index: 0 });
    await page.locator('#sv_save').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'setSettings')).toBe(true);

    await page.locator('.sv-jump button[data-tab="license"]').click();
    await expect(page.locator('#sv_secLicense')).toBeVisible();
    await page.locator('#sv_licRefresh').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'getLicense')).toBe(true);
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
    // QA pipeline pre-renders both deterministic fixtures, so Saved must show both.
    await expect(page.locator('.gtl-tile')).toHaveCount(2);
    await page.locator('#galleryChips [data-filter="all"]').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(2);

    const beforeSelect = await page.evaluate(() => window.__sevntQaInspect?.());
    expect(beforeSelect, 'QA renderer state before Select All').toMatchObject({ clipCount: 2, filter: 'all' });
    // Select Mode toolbar is restored as a floating action bar above the gallery.
    await page.locator('#selectModeBtn').click();
    await expect(page.locator('#statusBar.is-selecting')).toBeVisible();
    await expect(page.locator('#sbarSelectAct')).toBeVisible();
    await expect(page.locator('#selRenderBtn')).toBeDisabled();

    await page.locator('#selAllBtn').click();
    await expect(page.locator('#selCount')).toHaveText('2');
    await expect(page.locator('.gtl-tile.gtl-picked')).toHaveCount(2);
    await expect(page.locator('#selRenderBtn')).toBeEnabled();

    await page.locator('#selClearBtn').click();
    await expect(page.locator('#selCount')).toHaveText('0');
    await expect(page.locator('.gtl-tile.gtl-picked')).toHaveCount(0);
    await expect(page.locator('#selRenderBtn')).toBeDisabled();

    await page.locator('.gtl-tile[data-idx="0"]').click();
    await expect(page.locator('#selCount')).toHaveText('1');
    await expect(page.locator('.gtl-tile.gtl-picked')).toHaveCount(1);
    await expect(page.locator('#selRenderBtn')).toBeEnabled();

    const selectedRenderBefore = (await calls()).filter(x => x.name === 'renderEdit').length;
    await page.locator('#selRenderBtn').click();
    // Subtitle-off projects ask for an explicit choice before rendering.
    const subtitleChoice = page.locator('.choice-dlg');
    if (await subtitleChoice.isVisible().catch(() => false)) {
      await subtitleChoice.locator('button[data-i="1"]').click();
    }
    await expect.poll(async () => (await calls()).filter(x => x.name === 'renderEdit').length, { timeout: 60000 })
      .toBeGreaterThan(selectedRenderBefore);
    await page.locator('#selDoneBtn').click();
    await expect(page.locator('#sbarSelectAct')).toBeHidden();
    await expect(page.locator('#statusBar.is-selecting')).toBeHidden();

    // Select the second clip tile directly. The preview chevron selector is
    // not part of the current dashboard DOM; tile selection is the supported
    // interaction for changing the active clip in this gallery.
    await page.locator('.gtl-tile[data-idx="1"]').click();
    await expect(page.locator('.gtl-tile.gtl-active')).toHaveAttribute('data-idx', '1');

    // Gallery tile selection also opens the phone-style preview modal.
    // Close it through the real UI before interacting with the batch toolbar.
    await expect(page.locator('#clipPreviewModal')).toBeVisible();
    await page.locator('#cpmClose').click();
    await expect(page.locator('#clipPreviewModal')).toBeHidden();

    // Count only calls caused by Render All; earlier selected-clip rendering is expected.
    const batchRenderEditBefore = (await calls()).filter(x => x.name === 'renderEdit').length;
    const batchFfmpegBefore = (await calls()).filter(x => x.name === 'ffmpegRender').length;
    await expect(page.locator('#crRenderAllBtn')).toBeVisible();
    await page.locator('#crRenderAllBtn').click();
    await expect.poll(async () => (await calls()).filter(x => x.name === 'renderEdit').length - batchRenderEditBefore, { timeout: 60000 }).toBe(2);

    // The deterministic QA fixture contains exactly two candidates. Each
    // renderEdit call runs renderFixture once, so the correct contract is
    // two FFmpeg invocations and two output files (not four).
    await expect.poll(async () => (await calls()).filter(x => x.name === 'ffmpegRender').length - batchFfmpegBefore, { timeout: 60000 }).toBe(2);
    const rendered = (await calls()).filter(x => x.name === 'ffmpegRender').slice(batchFfmpegBefore);
    const outputs = rendered.map(x => x.value && x.value.output).filter(Boolean);
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(fs.existsSync(output)).toBe(true);
      expect(fs.statSync(output).size).toBeGreaterThan(1000);
    }
  });


  test('Editor edits caption style, titles and manual captions and renders the changes', async () => {
    await seedQaClips();
    await page.locator('#openEditorBtn').click();
    await expect(page.locator('#captionStudio')).toBeVisible();
    await expect(page.locator('#captionStudioBody')).not.toBeEmpty();
    await page.locator('#ce_tabs button[data-tab="style"]').click();
    // Typography is the second accordion card and is collapsed by default.
    await page.locator('#captionStudioBody .cap-card:has(#ce_case) > .cap-sec').click();
    await expect(page.locator('#ce_case')).toBeVisible();

    await page.locator('#ce_case button[data-v="upper"]').click();
    await expect(page.locator('#ce_case button[data-v="upper"]')).toHaveClass(/active/);
    await page.locator('#ce_fs').evaluate(el => {
      el.value = '72';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Effects & Output is a separate collapsed accordion card.
    await page.locator('#captionStudioBody .cap-card:has(#ce_anim) > .cap-sec').click();
    await expect(page.locator('#ce_anim button[data-v="fade"]')).toBeVisible();
    await page.locator('#ce_anim button[data-v="fade"]').click();
    await expect(page.locator('#ce_anim button[data-v="fade"]')).toHaveClass(/active/);

    await page.locator('#ce_tabs button[data-tab="titles"]').click();
    await page.locator('#ce_addTitle').click();
    await expect(page.locator('#ce_titles_list').locator('> *')).toHaveCount(1);

    await page.locator('#ce_tabs button[data-tab="manualcap"]').click();
    await page.locator('#ce_addMc').click();
    await expect(page.locator('#ce_mc_list').locator('> *')).toHaveCount(1);

    await page.locator('#ce_render').click();
    await expect.poll(async () => (await calls()).some(x => x.name === 'sevnt.applyCaption' || x.name === 'renderEdit'), { timeout: 60000 }).toBe(true);
    await page.locator('#csEditorClose').click();
    await expect(page.locator('#captionStudio')).toBeHidden();
  });

  test('Crop Studio changes aspect, zoom, keyframes and applies crop to the clip', async () => {
    await seedQaClips();
    await page.locator('.rail-btn[data-panel="crop"]').click();
    await page.locator('#openCropStudioBtn').click();
    await expect(page.locator('#cropStudio')).toBeVisible();
    await expect.poll(() => page.locator('#csVideo').evaluate(v => v.readyState >= 1), { timeout: 30000 }).toBe(true);

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
    await expect(page.locator('#csUndo')).toBeEnabled();
    await page.locator('#csUndo').click();
    await page.locator('#csRedo').click();
    await expect(page.locator('#csKfCount')).toContainText('1');
    await page.locator('#csReset').click();
    await page.locator('#csApplyAll').click();
    const beforeRenderEdit = (await calls()).filter(x => x.name === 'renderEdit').length;
    const beforeApplyCrop = (await calls()).filter(x => x.name === 'applyCrop').length;
    await page.locator('#csRender').click();
    // With fixture cueWords and burnSubtitles enabled, production correctly
    // routes crop + subtitle rendering through renderEdit. The no-subtitle
    // branch is covered separately by the applyCrop contract test.
    await expect.poll(async () => {
      const current = await calls();
      return current.filter(x => x.name === 'renderEdit').length > beforeRenderEdit ||
        current.filter(x => x.name === 'applyCrop').length > beforeApplyCrop;
    }, { timeout: 60000 }).toBe(true);
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
    await page.locator('#ssRemoveV2').click();
    await expect(page.locator('#ssRemoveV2')).toBeHidden();
    await expect(page.locator('#ssToggleV1')).toHaveClass(/primary-btn/);
  });

});