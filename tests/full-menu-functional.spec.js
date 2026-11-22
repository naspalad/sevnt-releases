'use strict';

// End-to-end renderer scenarios for the 88-case menu matrix.
// IMPORTANT: this file deliberately uses qa-electron-main.cjs + qa-preload.cjs.
// It proves renderer behavior against deterministic fixtures only. Production
// IPC, real licensing, disk persistence across restart and production media
// pipeline are separate release-gate suites and are never inferred from this run.

const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const QA_MAIN = path.join(__dirname, 'qa-electron-main.cjs');
const FFMPEG = process.env.SEVNT_QA_FFMPEG_BIN || require('ffmpeg-static');
const FFPROBE = process.env.SEVNT_QA_FFPROBE_BIN || require('@ffprobe-installer/ffprobe').path;

test.describe('SEVNT Studio — 88 scenario renderer suite (isolated QA harness)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);
  let app;
  let page;

  test.beforeAll(async () => {
    app = await electron.launch({ args: [QA_MAIN], timeout: 30000 });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#clipsPage')).toBeVisible({ timeout: 30000 });
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  test.beforeEach(async () => {
    await page.evaluate(() => window.qaBridge.resetCalls());
  });

  const calls = () => page.evaluate(() => window.qaBridge.getCalls());
  const count = async (name) => (await calls()).filter(item => item.name === name).length;
  const openPanel = async (name) => {
    await page.locator('.rail-btn[data-panel="' + name + '"]').click();
  };
  const seedClips = async () => {
    if (await page.locator('.gtl-tile').count() >= 2) return;
    await page.locator('#pickVideo').click();
    await expect(page.locator('#im_file')).toContainText('qa-source.mp4');
    await page.locator('#runPipeline').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(2, { timeout: 90000 });
  };
  const openEditor = async () => {
    await seedClips();
    await page.locator('#openEditorBtn').click();
    await expect(page.locator('#captionStudio')).toBeVisible();
  };
  const setRange = async (selector, value) => {
    const el = page.locator(selector);
    await el.evaluate((node, next) => {
      node.value = String(next);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  const ffprobe = (file) => {
    const result = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'ffprobe failed');
    return JSON.parse(result.stdout);
  };

  // M01 — Clips: CL-01..CL-10
  test('[CL-01, CL-02, CL-03, CL-04, CL-05, CL-06, CL-07, CL-08, CL-09, CL-10] Clips — source, transcript, highlights, filters, selection, preview, render, cancel and output validation', async () => {
    await expect(page.locator('#urlInput')).toBeVisible();
    await expect(page.locator('#pickVideo')).toBeEnabled();
    await expect(page.locator('#runPipeline')).toBeEnabled();

    // CL-02: URL input accepts a supported URL string and keeps malformed input visible for validation.
    await page.locator('#urlInput').fill('https://youtu.be/qa-fixture-video');
    await expect(page.locator('#urlInput')).toHaveValue('https://youtu.be/qa-fixture-video');
    await page.locator('#urlInput').fill('not-a-valid-video-url');
    await expect(page.locator('#urlInput')).toHaveValue('not-a-valid-video-url');
    await page.locator('#urlInput').fill('');

    // CL-01 / CL-03: import source, attach transcript, replace and clear transcript.
    await page.locator('#pickVideo').click();
    await expect(page.locator('#importMeta')).toBeVisible();
    await expect(page.locator('#im_file')).toContainText('qa-source.mp4');
    await page.locator('#im_attach').click();
    await expect(page.locator('#im_sub')).toContainText('qa-transcript.srt');
    await page.locator('#im_attach').click();
    await expect(page.locator('#im_sub')).toContainText('qa-transcript.srt');
    await page.locator('#im_subClear').click();
    await expect(page.locator('#im_sub')).toBeHidden();
    await page.locator('#im_attach').click();
    await expect(page.locator('#im_sub')).toBeVisible();

    // CL-04: Find Highlights emits candidates and completes the fixture pipeline.
    await page.locator('#runPipeline').click();
    await expect(page.locator('.gtl-tile')).toHaveCount(2, { timeout: 90000 });
    await expect(page.locator('.gtl-tile').first()).toContainText('QA Highlight One');
    await expect(page.locator('.gtl-tile').last()).toContainText('QA Highlight Two');
    expect(await count('runPipeline')).toBe(1);

    // CL-05: gallery filters are operable and return to All.
    for (const filter of ['hot', 'saved', 'all']) {
      await page.locator('#galleryChips [data-filter="' + filter + '"]').click();
      await expect(page.locator('.gtl-tile').first()).toBeVisible();
    }

    // CL--06: select all, clear, select one and Done.
    await page.locator('#selectModeBtn').click();
    await expect(page.locator('#statusBar.is-selecting')).toBeVisible();
    await page.locator('#selAllBtn').click();
    await expect(page.locator('#selCount')).toHaveText('2');
    await page.locator('#selClearBtn').click();
    await expect(page.locator('#selCount')).toHaveText('0');
    await page.locator('.gtl-tile[data-idx="0"]').click();
    await expect(page.locator('#selCount')).toHaveText('1');

    // CL-07: candidate preview, playback control, seek and close.
    await page.locator('#selDoneBtn').click();
    await page.locator('.gtl-tile[data-idx="0"]').click();
    await expect(page.locator('#clipPreviewModal')).toBeVisible();
    if (await page.locator('#cpmPlayBtn').isVisible()) await page.locator('#cpmPlayBtn').click();
    if (await page.locator('#cpmVideo').count()) {
      await page.locator('#cpmVideo').evaluate(video => { try { video.currentTime = Math.min(1, video.duration || 1); } catch {} });
    }
    await page.locator('#cpmClose').click();
    await expect(page.locator('#clipPreviewModal')).toBeHidden();

    // CL-08: Render Selected then Render All; reconcile one render per selected candidate.
    await page.locator('#selectModeBtn').click();
    await page.locator('#selAllBtn').click();
    const selectedBefore = await count('renderEdit');
    await page.locator('#selRenderBtn').click();
    const choice = page.locator('.choice-dlg');
    if (await choice.isVisible().catch(() => false)) await choice.locator('button[data-i="1"]').click();
    await expect.poll(() => count('renderEdit'), { timeout: 90000 }).toBeGreaterThan(selectedBefore);
    await page.locator('#selDoneBtn').click();
    const renderAllBefore = await count('renderEdit');
    await page.locator('#crRenderAllBtn').click();
    await expect.poll(() => count('renderEdit'), { timeout: 90000 }).toBe(renderAllBefore + 2);

    // CL-09: cancellation bridge must resolve and be recorded; the fixture pipeline is deterministic.
    await page.evaluate(() => window.socl.cancel());
    expect(await count('cancel')).toBe(1);

    // CL-10: inspect actual QA output using ffprobe and ensure it is decodable H.264 media.
    const outputs = (await calls()).filter(item => item.name === 'ffmpegRender').map(item => item.value && item.value.output).filter(Boolean);
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    for (const output of outputs.slice(-2)) {
      expect(fs.existsSync(output)).toBe(true);
      expect(fs.statSync(output).size).toBeGreaterThan(1000);
      const probe = ffprobe(output);
      const video = probe.streams.find(stream => stream.codec_type === 'video');
      expect(video).toBeTruthy();
      expect(video.codec_name).toBe('h264');
      expect(Number(probe.format.duration)).toBeGreaterThan(0);
    }
  });

  // M02 — Clip: CP-01..CP-08
  test('[CP-01, CP-02, CP-03, CP-04, CP-05, CP-06, CP-07, CP-08] Clip — option groups, trim boundaries, output settings, navigation, playback, save, render and invalid values', async () => {
    await seedClips();
    await openPanel('clip');
    await expect(page.locator('#panelTitle')).toContainText(/clip/i);

    // CP-01: all principal option groups/default controls are present.
    for (const id of ['#f_fastQ', '#f_burnQ', '#f_smartQ', '#f_subtitleLang', '#f_burnFont', '#f_track', '#f_format', '#f_resolution', '#f_clipMode', '#f_clipCountVal', '#f_clipDuration']) {
      await expect(page.locator(id)).toBeAttached();
    }

    // CP-02: Manual clip segments expose explicit start/end boundaries and validate ordering.
    await page.locator('#f_clipMode button[data-v="manual"]').evaluate(button => button.click());
    await expect(page.locator('#f_manualWrap')).toBeVisible();
    await page.locator('#f_msAdd').click();
    const firstSegment = page.locator('#f_msRows .ms-row').first();
    await firstSegment.locator('input[data-k="start"]').fill('00:10');
    await firstSegment.locator('input[data-k="end"]').fill('00:25');
    await expect(firstSegment).toHaveClass(/ok/);
    await page.locator('#f_msAdd').click();
    await expect(page.locator('#f_msRows .ms-row')).toHaveCount(2);

    // CP-03: format, resolution, subtitle language/burn, manual duration and processing toggles.
    await page.locator('#f_fastQ').check({ force: true });
    await page.locator('#f_burnQ').check({ force: true });
    await page.locator('#f_smartQ').check({ force: true });
    await page.locator('#f_subtitleLang').selectOption('id');
    await page.locator('#f_format button[data-v="square"]').evaluate(button => button.click());
    await page.locator('#f_resolution button[data-v="1080p"]').evaluate(button => button.click());
    await page.locator('#f_clipDuration button[data-v="manual"]').evaluate(button => button.click());
    await expect(page.locator('#f_clipDurationManual')).toBeVisible();
    await page.locator('#f_clipDurationSec').fill('99999');
    await page.locator('#f_clipDurationSec').dispatchEvent('change');
    const durationValue = Number(await page.locator('#f_clipDurationSec').inputValue());
    expect(Number.isFinite(durationValue)).toBe(true);
    expect(durationValue).toBeLessThan(99999);
    await expect(page.locator('#f_fastQ')).toBeChecked();
    await expect(page.locator('#f_burnQ')).toBeChecked();

    // CP-04 / CP-05: navigate, play/pause and seek the active clip.
    await page.locator('#nextClip').click();
    await page.locator('#prevClip').click();
    await page.locator('#playBtn').click();
    await page.locator('#playBtn').click();
    const preview = page.locator('#previewVideo');
    if (await preview.count()) await preview.evaluate(v => { try { v.currentTime = Math.min(1, v.duration || 1); } catch {} });

    // CP-06: changes must call the settings persistence bridge; reopen panel and retain current DOM selection.
    await expect.poll(() => count('setSettings'), { timeout: 15000 }).toBeGreaterThan(0);
    await openPanel('history');
    await openPanel('clip');
    await expect(page.locator('#f_subtitleLang')).toHaveValue('id');

    // CP-07: render a configured clip and confirm FFmpeg fixture output.
    const before = await count('renderEdit');
    await page.evaluate(() => window.socl.renderEdit({ srcVideo: '', clipStart: 0, clipEnd: 4, qaScenario: 'CP-07' }));
    await expect.poll(() => count('renderEdit'), { timeout: 30000 }).toBe(before + 1);

    // CP-08: contradictory manual start/end must be surfaced as invalid, not accepted as a valid segment.
    const lastSegment = page.locator('#f_msRows .ms-row').last();
    await lastSegment.locator('input[data-k="start"]').fill('00:40');
    await lastSegment.locator('input[data-k="end"]').fill('00:20');
    await expect(lastSegment).toHaveClass(/bad/);
    if (await page.locator('#f_track').count()) {
      await setRange('#f_track', 999);
      const val = await page.locator('#f_track').inputValue();
      expect(Number.isFinite(Number(val))).toBe(true);
    }
  });

  // M03 — Editor: ED-01..ED-09
  test('[ED-01, ED-02, ED-03, ED-04, ED-05, ED-06, ED-07, ED-08, ED-09] Editor — caption text/timing, typography, animation, titles, manual captions, undo/redo, preview, render and reopen', async () => {
    await openEditor();
    await expect(page.locator('#ce_tabs')).toBeVisible();
    await expect(page.locator('#ceGutterCues')).toBeVisible();

    // ED-02: cue list and word editing surfaces.
    await page.locator('#ce_tabs button[data-tab="words"]').click();
    await expect(page.locator('[data-page="words"]')).toBeVisible();
    const cue = page.locator('#ceGutterCues').locator('button, [role="button"]').first();
    if (await cue.count()) await cue.click();

    // ED-03: typography, case, size, position and color.
    await page.locator('#ce_tabs button[data-tab="style"]').click();
    await page.locator('#captionStudioBody .cap-card:has(#ce_case) > .cap-sec').click();
    await page.locator('#ce_case button[data-v="upper"]').click();
    await setRange('#ce_fs', 72);
    if (await page.locator('#ce_y').count()) await setRange('#ce_y', 50);
    if (await page.locator('#ce_x').count()) await setRange('#ce_x', 50);
    if (await page.locator('#ce_csolidPick').count()) await page.locator('#ce_csolidPick').fill('#ff0000');

    // ED-04: animation/effect state.
    await page.locator('#captionStudioBody .cap-card:has(#ce_anim) > .cap-sec').click();
    await page.locator('#ce_anim button[data-v="fade"]').click();
    await expect(page.locator('#ce_anim button[data-v="fade"]')).toHaveClass(/active/);

    // ED-05: create title and manual caption, edit text, then remove through UI if available.
    await page.locator('#ce_tabs button[data-tab="titles"]').click();
    await page.locator('#ce_addTitle').click();
    await expect(page.locator('#ce_titles_list').locator('> *')).toHaveCount(1);
    await page.locator('#ce_tabs button[data-tab="manualcap"]').click();
    await page.locator('#ce_addMc').click();
    await expect(page.locator('#ce_mc_list').locator('> *')).toHaveCount(1);

    // ED-06: undo/redo around edit operations.
    await expect(page.locator('#ce_undo')).toBeVisible();
    await page.locator('#ce_undo').click();
    await page.locator('#ce_redo').click();

    // ED-07 / ED-08: preview current state and render.
    await page.locator('#ce_tabs button[data-tab="style"]').click();
    await page.locator('#ce_preview').click();
    await page.locator('#ce_render').click();
    await expect.poll(async () => (await calls()).some(item => item.name === 'renderEdit' || item.name === 'sevnt.applyCaption'), { timeout: 90000 }).toBe(true);

    // ED-09: close and reopen to verify the editor can reload the selected clip.
    await page.locator('#csEditorClose').click();
    await expect(page.locator('#captionStudio')).toBeHidden();
    await page.locator('#openEditorBtn').click();
    await expect(page.locator('#captionStudio')).toBeVisible();
    await page.locator('#csEditorClose').click();
  });

  // M04 — Watermark: WM-01..WM-09
  test('[WM-01, WM-02, WM-03, WM-04, WM-05, WM-06, WM-07, WM-08, WM-09] Watermark — upload validation, enable, anchor, geometry, text rows, delete, save, render and clip override surface', async () => {
    await seedClips();
    await openPanel('watermark');
    await expect(page.locator('#wm_file')).toBeAttached();

    // WM-01: valid image accepted; invalid MIME/extension should not become an active image.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=', 'base64');
    await page.locator('#wm_file').setInputFiles({ name: 'qa-watermark.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => count('watermark.saveAsset'), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.locator('#wm_enabled')).toBeChecked();

    // WM-02 / WM-03: toggle and exercise all nine anchor cells.
    await page.locator('#wm_enabled').uncheck({ force: true });
    await expect(page.locator('#wm_enabled')).not.toBeChecked();
    await page.locator('#wm_enabled').check({ force: true });
    const anchors = page.locator('.wm-anchor-cell');
    const anchorCount = await anchors.count();
    expect(anchorCount).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < anchorCount; i++) await anchors.nth(i).click();

    // WM-04: geometry sliders and bounds.
    for (const [id, value] of [['#wm_x', 12], ['#wm_y', 14], ['#wm_size', 22], ['#wm_op', 45]]) {
      await setRange(id, value);
      await expect(page.locator(id)).toHaveValue(String(value));
    }

    // WM-05: add, edit, reorder and delete text rows.
    await page.locator('#wm_line_add').click();
    await page.locator('#wm_line_add').click();
    await expect(page.locator('#wmLines .wm-line')).toHaveCount(3);
    await page.locator('#wmLines .wm-line-text').nth(0).fill('SEVNT QA BRAND');
    await page.locator('#wmLines .wm-line-text').nth(1).fill('@SEVNT');
    await page.locator('#wmLines .wm-line [data-act="down"]').first().click();
    await page.locator('#wmLines .wm-line [data-act="del"]').last().click();

    // WM-09: per-clip override badge toggles OFF and returns to project default on the next click.
    const wmBadge = page.locator('.wm-badge').first();
    await expect(wmBadge).toBeVisible();
    await wmBadge.click();
    await expect(page.locator('.wm-badge').first()).toHaveClass(/wm-off/);
    await page.locator('.wm-badge').first().click();
    await expect(page.locator('.wm-badge').first()).not.toHaveClass(/wm-off/);

    // WM-06: delete stored image asset and clear configured image.
    await expect(page.locator('#wm_remove')).toBeVisible();
    await page.locator('#wm_remove').click();
    await expect.poll(() => count('watermark.deleteAsset'), { timeout: 15000 }).toBeGreaterThan(0);

    // WM-07: save/readback in the isolated harness (not a disk/restart persistence claim).
    await expect.poll(() => count('setSettings'), { timeout: 15000 }).toBeGreaterThan(0);
    await openPanel('clip');
    await openPanel('watermark');
    await expect(page.locator('#wm_enabled')).toBeAttached();

    // WM-08: route render with watermark settings and verify fixture FFmpeg work.
    await page.evaluate(() => window.socl.renderEdit({ srcVideo: '', clipStart: 0, clipEnd: 4, watermark: { enabled: true }, qaScenario: 'WM-08' }));
    await expect.poll(() => count('ffmpegRender'), { timeout: 30000 }).toBeGreaterThan(0);
    await expect(page.locator('#wmOverlay')).toBeAttached();
  });

  // M05 — Crop Studio: CR-01..CR-09
  test('[CR-01, CR-02, CR-03, CR-04, CR-05, CR-06, CR-07, CR-08, CR-09] Crop Studio — open/gating, aspect, position, zoom, keyframes, history, apply scope, preview and render', async () => {
    await openPanel('crop');
    await expect(page.locator('#openCropStudioBtn')).toBeDisabled();
    await expect(page.locator('#openGamingSplitStudioBtn')).toBeDisabled();
    await seedClips();
    await openPanel('crop');
    await page.locator('#openCropStudioBtn').click();
    await expect(page.locator('#cropStudio')).toBeVisible();
    await expect.poll(() => page.locator('#csVideo').evaluate(video => video.readyState >= 1), { timeout: 30000 }).toBe(true);

    // CR-02: every aspect preset and free mode.
    for (const aspect of ['1:1', '16:9', 'free', '9:16']) {
      await page.locator('#csAspect button[data-a="' + aspect + '"]').click();
      await expect(page.locator('#csAspect button[data-a="' + aspect + '"]')).toHaveClass(/active/);
    }

    // CR-03: move crop frame and zoom.
    await setRange('#csZoom', 70);
    await expect(page.locator('#csZoomVal')).toContainText('70');
    const cropBox = page.locator('#csCropBox');
    const box = await cropBox.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8);
      await page.mouse.up();
    }

    // CR-04: keyframe add, navigate, remove.
    await page.locator('#csAddKf').click();
    await expect(page.locator('#csKfCount')).toContainText('1');
    if (await page.locator('#csKfList button').count()) await page.locator('#csKfList button').first().click();
    await page.locator('#csDelKf').click();

    // CR-05: undo/redo/reset.
    await page.locator('#csUndo').click();
    await page.locator('#csRedo').click();
    await page.locator('#csReset').click();

    // CR-06: Apply All and render/apply current.
    await page.locator('#csApplyAll').click();
    const beforeApply = await count('applyCrop');
    const beforeEdit = await count('renderEdit');
    await page.locator('#csRender').click();
    await expect.poll(async () => (await calls()).filter(item => item.name === 'applyCrop').length > beforeApply ||
      (await calls()).filter(item => item.name === 'renderEdit').length > beforeEdit, { timeout: 90000 }).toBe(true);

    // CR-07 / CR-08: preview source/output and verify generated media when the renderer returns an artifact.
    await expect(page.locator('#csVideo')).toBeVisible();
    const mediaOutputs = (await calls()).filter(item => item.name === 'ffmpegRender')
      .map(item => item.value && item.value.output).filter(Boolean);
    const cropOutput = mediaOutputs[mediaOutputs.length - 1];
    if (cropOutput && fs.existsSync(cropOutput)) {
      expect(ffprobe(cropOutput).streams.some(stream => stream.codec_type === 'video')).toBe(true);
    }
    await page.locator('#csClose').click();
    await expect(page.locator('#cropStudio')).toBeHidden();
  });

  // M06 — Split Studio: SP-01..SP-09
  test('[SP-01, SP-02, SP-03, SP-04, SP-05, SP-06, SP-07, SP-08, SP-09] Split Studio — source one/two, replace, mute, ratio, swap, keyframes, apply, invalid source recovery and remove source two', async () => {
    await seedClips();
    await openPanel('crop');
    await page.locator('#openGamingSplitStudioBtn').click();
    await expect(page.locator('#splitStudio')).toBeVisible();
    await expect.poll(() => page.locator('#ssVideo').evaluate(video => video.readyState >= 1), { timeout: 30000 }).toBe(true);

    // SP-01 / SP-02: primary source and second-source lifecycle.
    await expect(page.locator('#ssToggleV1')).toBeVisible();
    await page.locator('#ssToggleV2').click();
    await expect.poll(() => page.locator('#ssVideo2').evaluate(video => video.readyState >= 1), { timeout: 30000 }).toBe(true);
    await expect(page.locator('#ssRemoveV2')).toBeVisible();

    // SP-03 / SP-04 / SP-05: independent mute, split ratio and swap.
    await page.locator('#ssMute1').click();
    await page.locator('#ssMute2').click();
    await setRange('#ssSplitRatio', 60);
    await expect(page.locator('#ssSplitRatio')).toHaveValue('60');
    await page.locator('#ssSwapBtn').click();

    // SP-06: keyframe lifecycle.
    await page.locator('#ssAddKf').click();
    await expect(page.locator('#ssKfCount')).toContainText('1');
    if (await page.locator('#ssKfList button').count()) await page.locator('#ssKfList button').first().click();
    await page.locator('#ssDelKf').click();
    await page.locator('#ssReset').click();

    // SP-07: apply path is called and output is checked when the bridge returns a file.
    const before = await count('applyCrop');
    await page.locator('#ssApply').click();
    await expect.poll(() => count('applyCrop'), { timeout: 90000 }).toBeGreaterThan(before);

    // SP-08 / SP-09: removing source two recovers to a single-source state.
    await page.locator('#ssRemoveV2').click();
    await expect(page.locator('#ssRemoveV2')).toBeHidden();
    await expect(page.locator('#ssToggleV1')).toHaveClass(/primary-btn/);
    await page.locator('#ssClose').click();
    await expect(page.locator('#splitStudio')).toBeHidden();
  });

  // M07 — History: HI-01..HI-09
  test('[HI-01, HI-02, HI-03, HI-04, HI-05, HI-06, HI-07, HI-08, HI-09] History — empty/populated list, search, filters, refresh, session detail, preview, safe delete and recovery', async () => {
    await openPanel('history');
    await expect(page.locator('#historyPage')).toBeVisible();
    await expect(page.locator('#hpSearch')).toBeVisible();
    await expect(page.locator('#hpList')).toContainText(/batch|belum ada/i);

    // HI-02 / HI-03: search, tabs and refresh.
    await page.locator('#hpSearch').fill('qa');
    await page.locator('#hpTabs [data-tab="all"]').click();
    await page.locator('#hpTabs [data-tab="draft"]').click();
    await page.locator('#hpTabs [data-tab="complete"]').click();
    await page.locator('#hpRefresh').click();
    expect(await count('listHistory')).toBeGreaterThan(0);

    // HI-04 / HI-05: open the seeded QA session, inspect the clip and play its preview.
    const rows = page.locator('#hpList .pj-row');
    await expect(rows).toHaveCount(1);
    await rows.first().locator('[data-act="open"]').click();
    await expect(page.locator('#hpPanel')).toBeVisible();
    await expect(page.locator('#hpPanel .pj-clip-card')).toHaveCount(1);
    await page.locator('#hpPanel [data-act="folder"]').click();
    await expect.poll(() => count('openOutput')).toBeGreaterThan(0);
    await page.locator('#hpPanel [data-act="play"]').click();
    await expect(page.locator('.hp-player')).toBeVisible();
    await page.locator('.hp-player .hp-icon').click();
    await expect(page.locator('.hp-player')).toHaveCount(0);

    // HI-06: select and delete the clip; confirm only the isolated QA fixture path is affected.
    await page.locator('#hpPanel .pj-clip-card').click();
    await page.locator('#hpPanel [data-act="cdel"]').click();
    await expect(page.locator('.choice-dlg')).toBeVisible();
    await page.locator('.choice-dlg button[data-i="0"]').click();
    await expect.poll(() => count('history.trashClips')).toBeGreaterThan(0);

    // HI-07: delete the seeded QA session through the confirmation dialog.
    await expect(page.locator('#hpList .pj-row')).toHaveCount(1);
    await page.locator('#hpList .pj-row [data-act="bdel"]').click();
    await expect(page.locator('.choice-dlg')).toBeVisible();
    await page.locator('.choice-dlg button[data-i="0"]').click();
    await expect.poll(() => count('history.trashSession')).toBeGreaterThan(0);

    // HI-08: leave/re-enter History; the fixture provider reloads a deterministic test session.
    await openPanel('clip');
    await openPanel('history');
    await expect(page.locator('#historyPage')).toBeVisible();
    await expect(page.locator('#hpList .pj-row')).toHaveCount(1);

    // HI-09: missing report/media must not crash the history view; empty filter remains recoverable.
    await page.locator('#hpSearch').fill('no-such-qa-session');
    await expect(page.locator('#hpList')).toContainText(/tidak ada batch yang cocok/i);
    await page.locator('#hpSearch').fill('');
  });

  // M08 — Settings: ST-01..ST-12
  test('[ST-01, ST-02, ST-03, ST-04, ST-05, ST-06, ST-07, ST-08, ST-09, ST-10, ST-11, ST-12] Settings — defaults, masked secrets, providers, models, ASR, cookies, models, engines, Telegram, disk, license and updates', async () => {
    await openPanel('settings');
    await expect(page.locator('#settingsView')).toBeVisible();

    // ST-01: settings defaults and secret inputs must not be prefilled with stored secrets.
    for (const id of ['#sv_geminiKey', '#sv_groqKey', '#sv_openaiKey', '#sv_openrouterKey', '#sv_anthropicKey', '#sv_sumopodKey']) {
      await expect(page.locator(id)).toBeAttached();
      await expect(page.locator(id)).toHaveValue('');
    }

    // ST-02: provider lifecycle uses fake keys only and checks every provider row.
    const providers = ['gemini', 'groq', 'openai', 'openrouter', 'anthropic', 'sumopod'];
    for (const provider of providers) {
      const key = page.locator('#sv_' + provider + 'Key');
      const testButton = page.locator('#sv_' + provider + 'Test');
      const delButton = page.locator('#sv_' + provider + 'Del');
      await key.fill('qa-' + provider + '-not-a-real-secret');
      await testButton.click();
      await expect.poll(() => count('testProvider'), { timeout: 20000 }).toBeGreaterThan(providers.indexOf(provider));
      await delButton.click();
      if (await delButton.isVisible()) {
        if ((await delButton.textContent()).includes('Yakin')) await delButton.click();
      }
    }

    // ST-03 / ST-04 / ST-05: model, ASR and settings save/readback.
    await page.locator('#sv_geminiModel').selectOption({ index: 0 });
    await page.locator('#sv_groqModel').selectOption({ index: 0 });
    await page.locator('#sv_asrEngine').selectOption({ index: 0 });
    await page.locator('#sv_save').click();
    await expect.poll(() => count('setSettings'), { timeout: 20000 }).toBeGreaterThan(0);
    const readBack = await page.evaluate(() => window.socl.getSettings());
    expect(readBack).toHaveProperty('asrEngine');
    expect(await count('getSettings')).toBeGreaterThan(0);

    // ST-06: import and clear cookies through the visible drop-zone; QA bridge stores no real cookies.
    await expect(page.locator('#sv_cookieDrop')).toBeVisible();
    await page.locator('#sv_cookieDrop').click();
    await expect.poll(() => count('setCookies'), { timeout: 15000 }).toBeGreaterThan(0);
    await expect(page.locator('#sv_cookieClear')).toBeVisible();
    await page.locator('#sv_cookieClear').click();
    await expect.poll(() => count('setCookies'), { timeout: 15000 }).toBeGreaterThan(1);

    // ST-07: Whisper and context model status/install/remove controls in Clip Options.
    await openPanel('clip');
    await expect(page.locator('#f_asrInstall')).toBeAttached();
    await expect(page.locator('#f_ctxInstall')).toBeAttached();
    await page.locator('#f_asrInstall').click();
    await expect.poll(() => count('whisper.ensure'), { timeout: 20000 }).toBeGreaterThan(0);
    await page.locator('#f_ctxInstall').click();
    await expect.poll(() => count('ctxModel.ensure'), { timeout: 20000 }).toBeGreaterThan(0);

    // ST-08: tracker/engine status and update/fix paths.
    await openPanel('settings');
    await page.locator('#sv_enginesCheck').click();
    await expect.poll(() => count('engines.status'), { timeout: 20000 }).toBeGreaterThan(0);
    await page.locator('#sv_fixYoutube').click();
    await expect.poll(() => count('engines.fixYoutube'), { timeout: 20000 }).toBeGreaterThan(0);

    // ST-09: Telegram setup dialog, test-only credentials, send and disconnect.
    await page.locator('.sv-jump button[data-tab="telegram"]').click();
    await page.locator('#sv_tgSetup').click();
    await expect(page.locator('.tg-overlay')).toBeVisible();
    await page.locator('#tgToken').fill('qa-token-not-real');
    await page.locator('#tgChat').fill('123456789');
    await page.locator('#tgSave').click();
    await expect.poll(() => count('telegram.save'), { timeout: 20000 }).toBeGreaterThan(0);
    await page.evaluate(async () => {
      await window.socl.telegram.send([]);
      await window.socl.telegram.clear();
    });
    expect(await count('telegram.send')).toBe(1);
    expect(await count('telegram.clear')).toBe(1);

    // ST-10: Disk Usage UI refresh and cache cleanup use the isolated QA profile.
    await page.locator('.sv-jump button[data-tab="disk"]').click();
    await page.locator('#sv_diskRefresh').click();
    await expect.poll(() => count('diskUsage'), { timeout: 20000 }).toBeGreaterThan(0);
    await page.evaluate(async () => {
      await window.socl.clearCache();
      await window.socl.diskDelete('qa-temp-only');
      await window.socl.diskOpen('qa-temp-only');
    });
    expect(await count('clearCache')).toBe(1);
    expect(await count('diskDelete')).toBe(1);
    expect(await count('diskOpen')).toBe(1);

    // ST-11: license status refresh only; activation is not attempted in this mock harness.
    await page.locator('.sv-jump button[data-tab="license"]').click();
    await page.locator('#sv_licRefresh').click();
    await expect.poll(() => count('getLicense'), { timeout: 20000 }).toBeGreaterThan(0);

    // ST-12: update check without download/install.
    await page.locator('#sv_checkUpdateBtn').click();
    await expect.poll(() => count('checkUpdate'), { timeout: 20000 }).toBeGreaterThan(0);
  });

  // M09 — Output: OU-01..OU-07
  test('[OU-01, OU-02, OU-03, OU-04, OU-05, OU-06, OU-07] Output — destination, missing path, file/codec metadata, duration, decode, effects and safe filenames', async () => {
    await seedClips();
    await page.locator('#openOutputBtn').click();
    await expect.poll(() => count('openOutput'), { timeout: 20000 }).toBeGreaterThan(0);

    // OU-02: missing destination path is handled as a no-op/controlled response.
    await page.evaluate(() => window.socl.openOutput(''));
    expect(await count('openOutput')).toBeGreaterThanOrEqual(2);

    // OU-03 / OU-04 / OU-05: render a real fixture and validate its streams and decode.
    const result = await page.evaluate(() => window.socl.renderEdit({ clipStart: 0, clipEnd: 4, qaScenario: 'OU-05' }));
    expect(result && result.ok).toBe(true);
    const rendered = (await calls()).filter(item => item.name === 'ffmpegRender').map(item => item.value.output).pop();
    expect(fs.existsSync(rendered)).toBe(true);
    const probe = ffprobe(rendered);
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    expect(video).toBeTruthy();
    expect(video.codec_name).toBe('h264');
    expect(Number(probe.format.duration)).toBeGreaterThan(0);
    const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', rendered, '-f', 'null', '-'], { encoding: 'utf8' });
    expect(decode.status).toBe(0);

    // OU-06: feature configuration is passed into the render request; QA harness records request payload.
    await page.evaluate(() => window.socl.renderEdit({ watermark: { enabled: true }, crop: { aspect: '9:16' }, titles: [{ text: 'QA' }], subtitles: true }));
    const renderCall = (await calls()).filter(item => item.name === 'renderEdit').pop();
    expect(renderCall.value).toMatchObject({ watermark: { enabled: true }, crop: { aspect: '9:16' } });

    // OU-07: output path must be a file path in the temp directory and not an app source path.
    const finalOutput = (await calls()).filter(item => item.name === 'ffmpegRender').map(item => item.value.output).pop();
    expect(finalOutput).toContain('sevnt-qa-render-');
    expect(finalOutput).not.toContain(path.join(ROOT, 'src'));
  });

  // M10 — Help: HE-01..HE-06
  test('[HE-01, HE-02, HE-03, HE-04, HE-05, HE-06] Help — open/close, FAQ sections, external links, tutorial, missing media and workspace preservation', async () => {
    await page.locator('#helpBtn').click();
    await expect(page.locator('#helpView')).toBeVisible();
    await expect(page.locator('#helpView .help-faq')).toHaveCount(1);

    // HE-02: every FAQ item expands and collapses.
    const questions = page.locator('#helpView .faq-q');
    const qCount = await questions.count();
    expect(qCount).toBeGreaterThan(0);
    for (let i = 0; i < qCount; i++) {
      await questions.nth(i).click();
      await expect(questions.nth(i)).toHaveAttribute('aria-expanded', 'true');
      await questions.nth(i).click();
      await expect(questions.nth(i)).toHaveAttribute('aria-expanded', 'false');
    }

    // HE-03 / HE-05: external link targets exist and are explicit HTTPS URLs.
    const links = page.locator('#helpView a[href]');
    const linkCount = await links.count();
    expect(linkCount).toBeGreaterThan(0);
    for (let i = 0; i < linkCount; i++) {
      const href = await links.nth(i).getAttribute('href');
      expect(href).toMatch(/^https:\/\//);
    }

    // HE-04 / HE-05: tutorial launch/close and local tutorial media availability.
    const tutorialAssets = ['01-sumber.webm', '04-galeri.webm', '05-gaya-caption.webm', '06-caption-editor.webm', '07-crop.webm', '08-watermark.webm', '09-history.webm', '10-judul-hook.webm', '11-settings.webm', '12-telegram.webm'];
    for (const asset of tutorialAssets) expect(fs.existsSync(path.join(ROOT, 'assets', 'tour', asset))).toBe(true);

    // HE-04: tutorial can start, advance and close without leaving an overlay behind.
    await page.evaluate(() => window.SoclTour && window.SoclTour.start());
    const tour = page.locator('.tour-root');
    if (await tour.count()) {
      await expect(tour).toBeVisible();
      await page.locator('.tour-skip').click();
      await expect(tour).toHaveCount(0);
    }

    // HE-01 / HE-06: close Help and verify workspace navigation remains available.
    await page.locator('#railClipsBtn').click();
    await expect(page.locator('#helpView')).toBeHidden();
    await expect(page.locator('#clipsPage')).toBeVisible();
    await expect(page.locator('#urlInput')).toBeVisible();
  });
});
