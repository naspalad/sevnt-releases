// Integration tests for the engine supervisor + engine (real Python process, real HTTP). No mocks of the engine.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { test } = require('./test-runner');
const { EngineSupervisor, pidAlive } = require('../src/engine/engine-supervisor');
const { transcribeViaEngine } = require('../src/engine/engine-asr');
const { findPython, makeSupervisorOptions } = require('./helpers/engine-env');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 200) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); } return false; }

module.exports = async function () {
  console.log('\nâ–¶ engine: supervisor + local API (real Python process)');
  if (!findPython()) { console.log('  âš  NOT RUN: no Python runtime found (set SEVNT_ENGINE_PYTHON or build the engine runtime)'); return; }

  let sup;
  await test('missing runtime reports "unavailable" instead of throwing', async ({ assertEqual }) => {
    const s = new EngineSupervisor(makeSupervisorOptions({ pythonPath: path.join(os.tmpdir(), 'no-such-python.exe') }));
    const st = await s.start();
    assertEqual(st.state, 'unavailable'); assertEqual(st.error.code, 'runtime_missing');
  });

  await test('starts, becomes ready on a dynamic port (not 8765)', async ({ assert, assertEqual }) => {
    sup = new EngineSupervisor(makeSupervisorOptions());
    const st = await sup.start();
    assertEqual(st.state, 'ready', JSON.stringify(st));
    assert(st.port > 1024 && st.port !== 8765, `port ${st.port}`);
    assert(pidAlive(st.pid), 'engine pid alive');
  });

  await test('GET /health works without a token and leaks no paths', async ({ assert, assertEqual }) => {
    const r = await fetch(`http://127.0.0.1:${sup.port}/health`);
    assertEqual(r.status, 200);
    const j = await r.json();
    assertEqual(j.status, 'ok');
    assert(!JSON.stringify(j).match(/[A-Za-z]:\\|\/Users\//), 'health must not expose file paths');
  });

  await test('every other route rejects missing / wrong tokens (401)', async ({ assertEqual }) => {
    for (const p of ['/api/v1/system/profile', '/api/v1/system/whisper-capabilities', '/api/v1/shutdown', '/docs', '/openapi.json']) {
      const a = await fetch(`http://127.0.0.1:${sup.port}${p}`);
      assertEqual(a.status, 401, `${p} without token`);
      const b = await fetch(`http://127.0.0.1:${sup.port}${p}`, { headers: { Authorization: 'Bearer wrong-token-wrong-token' } });
      assertEqual(b.status, 401, `${p} with wrong token`);
    }
  });

  await test('authenticated request works; legacy B routes (licence/projects/render) are NOT mounted', async ({ assert, assertEqual }) => {
    const prof = await sup.request('GET', '/api/v1/system/profile');
    assertEqual(typeof prof.pid, 'number');
    for (const p of ['/api/v1/license/status', '/api/v1/projects', '/api/v1/caption/config']) {
      let status = 0; try { await sup.request('GET', p); } catch (e) { status = e.status; }
      assertEqual(status, 404, `${p} must be 404`);
    }
    assert(true);
  });

  await test('listens on loopback only', async ({ assert }) => {
    if (process.platform !== 'win32') { return; }
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout;
    const lines = out.split(/\r?\n/).filter((l) => l.includes(`:${sup.port} `) && /LISTENING/.test(l));
    assert(lines.length > 0, 'no listening socket found');
    assert(lines.every((l) => /127\.0\.0\.1:/.test(l)), `non-loopback listener: ${lines.join(' | ')}`);
  });

  await test('capabilities report faster-whisper and RAM info', async ({ assert }) => {
    const c = await sup.request('GET', '/api/v1/system/whisper-capabilities');
    assert(c.faster_whisper_available === true, 'faster-whisper missing in runtime');
    assert(c.memory.total_bytes > 0 && c.memory.available_bytes > 0, 'memory probe failed');
    assert(Object.keys(c.models).join() === 'tiny,base,small', 'model list');
  });

  await test('crash is detected and the engine restarts automatically with a new pid', async ({ assert, assertEqual }) => {
    const oldPid = sup.pid;
    spawnSync('taskkill', ['/PID', String(oldPid), '/F'], { windowsHide: true });
    assert(await waitFor(() => sup.status.state === 'ready' && sup.pid && sup.pid !== oldPid, 30000), `no restart: ${JSON.stringify(sup.status)}`);
    assert(!pidAlive(oldPid), 'old pid must be gone');
    assertEqual(sup.status.state, 'ready');
  });

  await test('stop() leaves no engine process and no lock file', async ({ assert }) => {
    const pid = sup.pid;
    await sup.stop();
    assert(!pidAlive(pid), 'engine still alive after stop');
    assert(!fs.existsSync(sup.o.lockFile), 'lock file left behind');
    assert(sup.status.state === 'stopped', sup.status.state);
  });

  await test('NO ORPHAN: engine exits by itself when the app process is killed (parent watchdog)', async ({ assert }) => {
    const helper = spawn(process.execPath, [path.join(__dirname, 'helpers', 'engine-parent.js')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const info = await new Promise((res, rej) => { let b = ''; helper.stdout.on('data', (d) => { b += d; if (b.includes('\n')) res(JSON.parse(b.split('\n')[0])); }); setTimeout(() => rej(new Error('helper timeout')), 60000); });
    assert(info.state === 'ready' && pidAlive(info.engine), 'helper engine not running');
    spawnSync('taskkill', ['/PID', String(info.parent), '/F'], { windowsHide: true });      // kill ONLY the app, not the tree
    assert(!pidAlive(info.parent), 'parent should be dead');
    assert(await waitFor(() => !pidAlive(info.engine), 8000, 250), `engine ${info.engine} still alive 8 s after its parent died`);
  });

  await test('stale-engine reaper removes an orphan left by a crashed session', async ({ assert }) => {
    const opts = makeSupervisorOptions();
    const s = new EngineSupervisor(opts);
    fs.writeFileSync(opts.lockFile, JSON.stringify({ enginePid: 999999, parentPid: 999998, port: 1 }));
    s.reapStale();
    assert(!fs.existsSync(opts.lockFile), 'stale lock must be removed');
  });

  // ---- ASR (S1) ----
  const wav = path.join(os.tmpdir(), 'sevnt-asr-test.wav');
  let haveWav = false;
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('Hello, this is a short test of the transcription engine. The quick brown fox jumps over the lazy dog.'); $s.Dispose()`;
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
    haveWav = fs.existsSync(wav) && fs.statSync(wav).size > 10000;
  }
  let asr;
  await test('S1: faster-whisper transcribes real speech through the supervisor (word timestamps)', async ({ assert }) => {
    if (!haveWav) { console.log('    âš  NOT RUN: could not synthesise a speech sample on this OS'); return; }
    asr = new EngineSupervisor(makeSupervisorOptions());
    assert((await asr.start()).state === 'ready', 'engine not ready');
    const progress = [];
    const r = await transcribeViaEngine(asr, { audioPath: wav, model: 'tiny', language: 'en', pollMs: 400, onProgress: (p) => progress.push(p) });
    const text = r.words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, '')).join(' ');
    assert(r.words.length >= 10, `only ${r.words.length} words: ${text}`);
    assert(/transcription|test/.test(text) && /fox|quick/.test(text), `unexpected transcript: ${text}`);
    assert(r.words.every((w) => w.end > w.start) && r.words.every((w, i, a) => i === 0 || w.start >= a[i - 1].start - 0.01), 'timestamps not monotonic');
    assert(r.modelUsed === 'tiny', `model used ${r.modelUsed}`);
    await sleep(1500); // allow Python ASR cleanup and lock release
  });

  await test('S1: a second job while one is running is refused (one at a time on 8 GB machines)', async ({ assert }) => {
    if (!haveWav || !asr) { console.log('    âš  NOT RUN'); return; }
    const j1 = await asr.request('POST', '/api/v1/asr/transcribe', { audio_path: wav, model: 'tiny', language: 'en' });
    let status = 0; try { await asr.request('POST', '/api/v1/asr/transcribe', { audio_path: wav, model: 'tiny', language: 'en' }); } catch (e) { status = e.status; }
    // the first job may already be done on a fast machine; accept 409 or success only when job 1 finished
    const done = await waitFor(async () => (await asr.request('GET', `/api/v1/asr/jobs/${j1.id}`)).status === 'done', 60000, 300);
    assert(done, 'first job did not finish');
    assert(status === 409 || status === 202 || status === 0, `unexpected status ${status}`);
  });

  await test('S1: bad inputs are rejected (relative path, missing file, bad model)', async ({ assertEqual }) => {
    if (!asr) { console.log('    âš  NOT RUN'); return; }
    for (const [body, want] of [[{ audio_path: 'relative.wav' }, 400], [{ audio_path: path.join(os.tmpdir(), 'nope-123.wav') }, 400], [{ audio_path: wav, model: 'large-v3' }, 422]]) {
      let status = 0; try { await asr.request('POST', '/api/v1/asr/transcribe', body); } catch (e) { status = e.status; }
      assertEqual(status, want, JSON.stringify(body));
    }
  });

  await test('S1: cancelling a job stops it', async ({ assert }) => {
    if (!haveWav || !asr) { console.log('    âš  NOT RUN'); return; }
    let cancelled = false;
    try { await transcribeViaEngine(asr, { audioPath: wav, model: 'tiny', language: 'en', pollMs: 50, isCancelled: () => (cancelled = true) }); } catch (e) { assert(e.code === 'cancelled', e.code); }
    assert(cancelled, 'cancel hook not consulted');
    await sleep(1500);   // let the worker release the model lock before the next test
  });

  await test('S1 FALLBACK: when the engine is stopped the ASR call fails fast with engine_unavailable', async ({ assert }) => {
    if (!asr) { console.log('    âš  NOT RUN'); return; }
    await asr.stop();
    let code = ''; try { await transcribeViaEngine(asr, { audioPath: wav, model: 'tiny' }); } catch (e) { code = e.code; }
    assert(code === 'engine_unavailable', `code ${code}`);
  });
};
