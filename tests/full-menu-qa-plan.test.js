'use strict';

// Validates the completeness and integrity of the designed QA inventory.
// This does NOT execute application UI, production IPC, FFmpeg or Python tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const planPath = path.join(__dirname, 'full-menu-qa-plan.json');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const expectedMenus = [
  'Clips', 'Clip', 'Editor', 'Watermark', 'Crop Studio',
  'Split Studio', 'History', 'Settings', 'Output', 'Help',
];

test('Full Menu QA plan: exactly ten required menus are present', () => {
  assert.equal(plan.status, 'DESIGNED_NOT_EXECUTED');
  assert.equal(plan.menus.length, 10);
  assert.deepEqual(plan.menus.map(menu => menu.name), expectedMenus);
});

test('Full Menu QA plan: every case has a unique ID and actionable description', () => {
  const cases = plan.menus.flatMap(menu => menu.cases.map(([id, description]) => ({
    id, menu: menu.name, description,
  })));
  const ids = cases.map(item => item.id);

  assert.equal(cases.length, 88, 'Coverage count changed; review the plan and update this guard intentionally');
  assert.equal(new Set(ids).size, ids.length, 'Case IDs must be unique across all menus');

  for (const item of cases) {
    assert.match(item.id, /^[A-Z]{2}-\d{2}$/);
    assert.ok(item.description.trim().length >= 20, item.id + ' needs an actionable description');
  }
});

test('Full Menu QA plan: each menu has multiple cases and all required evidence fields', () => {
  const expectedPrefixes = ['CL', 'CP', 'ED', 'WM', 'CR', 'SP', 'HI', 'ST', 'OU', 'HE'];
  for (const [index, menu] of plan.menus.entries()) {
    assert.ok(menu.cases.length >= 5, menu.name + ' has insufficient planned coverage');
    for (const [id] of menu.cases) assert.ok(id.startsWith(expectedPrefixes[index] + '-'), id + ' does not belong to ' + menu.name);
  }

  for (const field of [
    'caseId', 'menu', 'environment', 'testLayer', 'action', 'expected',
    'actual', 'status', 'failureClass', 'screenshotOrTrace', 'logs',
    'outputArtifact', 'commitSha',
  ]) {
    assert.ok(plan.evidenceContract.includes(field), 'Missing evidence field: ' + field);
  }
});

test('Full Menu QA plan: production proof and no-silent-skip policies are mandatory', () => {
  assert.equal(plan.policy.noSilentSkips, true);
  assert.equal(plan.policy.distinguishMockFromProduction, true);
  assert.equal(plan.policy.productionEvidenceRequiredForRelease, true);
  assert.ok(plan.testLayers.some(layer => layer.id === 'ipc' && layer.countsAsProductionPass));
  assert.ok(plan.testLayers.some(layer => layer.id === 'media' && layer.countsAsProductionPass));
  assert.ok(plan.testLayers.some(layer => layer.id === 'persistence' && layer.countsAsProductionPass));
  assert.ok(plan.releaseGates.length >= 5);
});
