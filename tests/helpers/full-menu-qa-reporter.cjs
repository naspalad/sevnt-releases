'use strict';

// Full-menu coverage reporter. A scenario is counted only when a Playwright
// test explicitly declares its case ID in the test title, e.g. [CL-01,CL-03].
// Missing IDs are reported as NOT_IMPLEMENTED; skipped tests never count PASS.
const fs = require('node:fs');
const path = require('node:path');

class FullMenuQaReporter {
  onBegin(config) {
    this.startedAt = new Date().toISOString();
    this.plan = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'full-menu-qa-plan.json'), 'utf8'));
    this.results = new Map();
    this.unmappedTests = [];
    this.outputDir = path.resolve(process.env.SEVNT_QA_OUTPUT_DIR || 'test-results/full-menu-qa');
  }

  onTestEnd(test, result) {
    const title = test.titlePath().join(' ');
    const matches = [...title.matchAll(/\\[((?:[A-Z]{2}-\\d{2})(?:\\s*,\\s*[A-Z]{2}-\\d{2})*)\\]/g)];
    const ids = [...new Set(matches.flatMap(match => match[1].split(',').map(value => value.trim())))];
    if (!ids.length) {
      this.unmappedTests.push({ title, status: result.status });
      return;
    }

    const status = result.status === 'passed' ? 'PASS'
      : result.status === 'skipped' ? 'SKIPPED'
      : result.status === 'timedOut' ? 'TIMEOUT'
      : result.status === 'interrupted' ? 'INTERRUPTED'
      : 'FAIL';

    for (const caseId of ids) {
      if (!this.results.has(caseId)) this.results.set(caseId, []);
      this.results.get(caseId).push({
        title,
        status,
        durationMs: result.duration,
        retry: result.retry,
        errors: (result.errors || []).map(error => error.message || String(error)),
        attachments: (result.attachments || []).map(item => ({
          name: item.name,
          contentType: item.contentType,
          path: item.path || null,
        })),
      });
    }
  }

  async onEnd(result) {
    const planned = this.plan.menus.flatMap(menu => menu.cases.map(([caseId, description]) => ({
      caseId, menu: menu.name, description,
    })));
    const known = new Set(planned.map(item => item.caseId));
    const unknown = [...this.results.keys()].filter(id => !known.has(id));
    const cases = planned.map(item => {
      const attempts = this.results.get(item.caseId) || [];
      const status = !attempts.length ? 'NOT_IMPLEMENTED'
        : attempts.some(attempt => attempt.status !== 'PASS') ? attempts.find(attempt => attempt.status !== 'PASS').status
        : 'PASS';
      return { ...item, status, attempts };
    });

    const report = {
      schemaVersion: 1,
      title: 'SEVNT Studio Full Menu QA Execution Report',
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      branch: this.plan.branch,
      sourcePlanStatus: this.plan.status,
      playwrightStatus: result.status,
      summary: {
        planned: cases.length,
        pass: cases.filter(item => item.status === 'PASS').length,
        fail: cases.filter(item => item.status === 'FAIL' || item.status === 'TIMEOUT' || item.status === 'INTERRUPTED').length,
        skipped: cases.filter(item => item.status === 'SKIPPED').length,
        notImplemented: cases.filter(item => item.status === 'NOT_IMPLEMENTED').length,
        unknownCaseIds: unknown.length,
        unmappedTests: this.unmappedTests.length,
      },
      unknownCaseIds: unknown,
      unmappedTests: this.unmappedTests,
      cases,
    };

    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.writeFileSync(path.join(this.outputDir, 'full-menu-qa-report.json'), JSON.stringify(report, null, 2) + '\n');
    const summary = [
      '# SEVNT Studio Full Menu QA Report',
      '',
      `- Planned scenarios: ${report.summary.planned}`,
      `- PASS: ${report.summary.pass}`,
      `- FAIL/TIMEOUT/INTERRUPTED: ${report.summary.fail}`,
      `- SKIPPED: ${report.summary.skipped}`,
      `- NOT IMPLEMENTED: ${report.summary.notImplemented}`,
      `- Unknown case IDs: ${report.summary.unknownCaseIds}`,
      `- Unmapped Playwright tests: ${report.summary.unmappedTests}`,
      '',
      '| Case | Menu | Status | Scenario |',
      '|---|---|---|---|',
      ...cases.map(item => `| ${item.caseId} | ${item.menu} | ${item.status} | ${item.description.replace(/\\|/g, '\\|')} |`),
      '',
      'A missing case is NOT_IMPLEMENTED, never PASS. Mock-preload runs are UI/fixture evidence only and do not prove production IPC or production media integration.',
    ].join('\n');
    fs.writeFileSync(path.join(this.outputDir, 'full-menu-qa-report.md'), summary + '\n');

    console.log(`\\n[SEVNT QA] ${report.summary.pass}/${report.summary.planned} scenarios PASS; ${report.summary.notImplemented} NOT_IMPLEMENTED; ${report.summary.fail} failed.`);
    if (report.summary.notImplemented || report.summary.fail || report.summary.skipped || unknown.length) {
      return { status: 'failed' };
    }
    return { status: result.status };
  }
}

module.exports = FullMenuQaReporter;
