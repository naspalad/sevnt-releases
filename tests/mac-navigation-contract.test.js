// Structural navigation contract for the SEVNT macOS QA pipeline.
// This deliberately does not bypass or simulate license activation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');

function hasPanel(panel) {
  return new RegExp(`name === ['"]${panel}['"]`).test(renderer);
}

test('SEVNT sidebar exposes all ten expected navigation controls', () => {
  const selectors = [
    ['Clips', /id="railClipsBtn"/],
    ['Clip', /class="rail-btn[^"]*"[^>]*data-panel="clip"|data-panel="clip"[^>]*class="rail-btn/],
    ['Editor', /id="openEditorBtn"/],
    ['Watermark', /data-panel="watermark"/],
    ['Crop', /data-panel="crop"/],
    ['History', /data-panel="history"/],
    ['Mobile Companion', /id="mobileBtn"[^>]*data-panel="mobile"|data-panel="mobile"[^>]*id="mobileBtn"/],
    ['Output', /id="openOutputBtn"/],
    ['Help & FAQ', /id="helpBtn"/],
    ['Settings', /data-panel="settings"/],
  ];

  for (const [label, pattern] of selectors) {
    assert.match(html, pattern, `Missing sidebar control: ${label}`);
  }
});

test('panel router has concrete render targets for Clip, Watermark and Crop', () => {
  for (const panel of ['clip', 'watermark', 'crop']) {
    assert.ok(hasPanel(panel), `renderPanel is missing ${panel}`);
  }
  assert.match(renderer, /function renderClipPanel\s*\(/);
  assert.match(renderer, /function renderWatermarkPanel\s*\(/);
  assert.match(renderer, /function renderCropPanel\s*\(/);
});

test('History, Mobile and Settings have dedicated navigation handlers', () => {
  assert.match(renderer, /function renderHistoryPanel\s*\(/);
  assert.match(renderer, /function renderMobilePanel\s*\(/);
  assert.match(renderer, /function openSettings\s*\(/);
  assert.match(renderer, /if \(p === 'settings'\)\s*\{[^}]*openSettings\(\)/s);
  assert.match(renderer, /if \(p === 'mobile'\)\s*\{[^}]*renderMobilePanel\(\)/s);
});

test('Editor and Help have dedicated open/close behavior', () => {
  assert.match(renderer, /getElementById\(['"]openEditorBtn['"]\)[\s\S]{0,1200}openCaptionEditor\(idx\)/);
  assert.match(html, /id="helpView"[^>]*hidden/);
  assert.match(html, /helpBtn\.addEventListener\(['"]click['"]/);
  assert.match(html, /function openHelp\s*\(/);
  assert.match(html, /function closeHelp\s*\(/);
});

test('Output control invokes the native output-folder bridge', () => {
  assert.match(renderer, /els\.openOutput\.addEventListener\(['"]click['"][\s\S]{0,200}window\.socl\.openOutput\(null\)/);
});
