'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wm = require('../src/watermark');

test('watermark defaults are disabled and use a valid output anchor', () => {
  const value = wm.sanitize(null);
  assert.equal(value.enabled, false);
  assert.equal(value.anchor, 'br');
  assert.equal(value.opacity, 0.55);
  assert.equal(wm.ANCHORS.includes(value.anchor), true);
});

test('watermark geometry and opacity are clamped to supported ranges', () => {
  const value = wm.sanitize({
    enabled: true, anchor: 'not-an-anchor',
    xPct: 999, yPct: -20, sizePct: 1, opacity: 4,
  });
  assert.equal(value.enabled, true);
  assert.equal(value.anchor, 'br');
  assert.equal(value.xPct, 40);
  assert.equal(value.yPct, 0);
  assert.equal(value.sizePct, 3);
  assert.equal(value.opacity, 1);
});

test('all nine watermark anchors are accepted', () => {
  for (const anchor of wm.ANCHORS) {
    assert.equal(wm.sanitize({ anchor }).anchor, anchor);
  }
  assert.deepEqual(wm.ANCHORS, ['tl','tc','tr','ml','mc','mr','bl','bc','br']);
});

test('text watermark sanitization removes empty lines and bounds style values', () => {
  const value = wm.sanitize({
    enabled: true,
    text: {
      content: '  SEVNT  \\n\\n  @SEVENTY  ',
      font: 'not-a-bundled-font',
      color: 'red',
      sizePct: 99,
      opacity: -1,
    },
  });
  assert.equal(value.text.content, 'SEVNT\\n@SEVENTY');
  assert.equal(value.text.font, wm.DEFAULT_TEXT.font);
  assert.equal(value.text.color, '#ffffff');
  assert.equal(value.text.sizePct, 20);
  assert.equal(value.text.opacity, 0);
});

test('per-clip disable override wins over the project watermark', () => {
  const project = { enabled: true, anchor: 'tr', opacity: 0.8 };
  const resolved = wm.resolveWatermark(project, { enabled: false });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.anchor, 'tr');
  assert.equal(resolved.opacity, 0.8);
});

test('per-clip settings override project geometry without mutating project defaults', () => {
  const project = { enabled: true, anchor: 'tr', sizePct: 20 };
  const resolved = wm.resolveWatermark(project, { anchor: 'bl', sizePct: 35 });
  assert.equal(resolved.anchor, 'bl');
  assert.equal(resolved.sizePct, 35);
  assert.equal(project.anchor, 'tr');
  assert.equal(project.sizePct, 20);
});
