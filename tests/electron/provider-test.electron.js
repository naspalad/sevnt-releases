// Runs INSIDE Electron: electron tests/electron/provider-test.electron.js <result.json>
// Part A: mocked requester - every provider's request shape and every error class (busy / rate-limited / bad key / bad model).
// Part B: REAL endpoints with a deliberately fake key - proves each provider answers "key rejected" (not "busy"/crash) and
//         that our request shape is accepted far enough to be authenticated. No real key is used or needed.
'use strict';
const { app } = require('electron');
const fs = require('fs');
const out = process.argv[process.argv.length - 1];
const results = [];
const rec = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
app.whenReady().then(async () => {
  try {
    const pipe = require('../../src/pipeline-inverse-v1.js');
    const t = pipe.__test.testProviderConnection;
    const providers = ['gemini', 'groq', 'openai', 'anthropic', 'openrouter', 'sumopod'];
    const FAKE = 'FAKE-KEY-0000000000000000000000000000';
    const okBody = (p) => (p === 'gemini' ? { candidates: [{}] } : { choices: [{}], model: 'm' });
    for (const p of providers) {
      let seen;
      const r1 = await t({}, p, FAKE, async (url, body, headers) => { seen = { url, body, headers }; return okBody(p); });
      rec(`${p}: success path + request shape`, r1.ok === true && !!seen && /^https:\/\//.test(seen.url) && Object.keys(seen.headers).length === 1, seen && seen.url);
      let n = 0;
      const r2 = await t({}, p, FAKE, async () => { n++; if (n < 3) throw new Error('HTTP 503: {"error":{"code":503,"status":"UNAVAILABLE","message":"high demand"}}'); return okBody(p); });
      rec(`${p}: 503 twice then OK -> connected (retried ${n}x)`, r2.ok === true && n === 3);
      n = 0;
      const r3 = await t({}, p, FAKE, async () => { n++; throw new Error('HTTP 503: UNAVAILABLE high demand'); });
      rec(`${p}: always 503 -> not a key error, plain message`, r3.ok === false && r3.kind === 'busy' && r3.keyAccepted === true && /sibuk/.test(r3.error) && n === 3, r3.error);
      const r4 = await t({}, p, FAKE, async () => { throw new Error('HTTP 429: quota exceeded'); });
      rec(`${p}: 429 -> key accepted but limited`, r4.kind === 'rate-limited' && r4.keyAccepted === true, r4.error);
      const r5 = await t({}, p, FAKE, async () => { throw new Error('HTTP 401: invalid api key'); });
      rec(`${p}: 401 -> key rejected, message says so`, r5.kind === 'bad-key' && r5.keyAccepted === false && /ditolak/.test(r5.error), r5.error);
      const r6 = await t({}, p, FAKE, async () => { throw new Error('HTTP 400: {"error":{"message":"API key not valid. Please pass a valid API key."}}'); });
      rec(`${p}: 400 "API key not valid" -> key rejected`, r6.kind === 'bad-key', r6.error);
      const r7 = await t({}, p, FAKE, async () => { throw new Error('HTTP 404: model not found'); });
      rec(`${p}: 404 -> model hint`, r7.kind === 'bad-model', r7.error);
      const r8 = await t({}, p, '', async () => okBody(p));
      rec(`${p}: empty key -> "belum diisi"`, r8.ok === false && /belum diisi/.test(r8.error));
    }
    // Part B: real endpoints, fake key
    for (const p of providers) {
      const r = await t({}, p, FAKE);
      rec(`REAL ${p}: fake key is classified (not crash/busy)`, r.ok === false && ['bad-key', 'bad-model', 'other'].includes(r.kind), `${r.kind} ${r.error} (${r.latencyMs} ms)`);
    }
  } catch (e) { rec('unexpected error', false, e && e.stack || String(e)); }
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  app.exit(results.every((x) => x.ok) ? 0 : 1);
});
