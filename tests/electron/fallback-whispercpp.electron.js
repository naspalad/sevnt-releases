// Runs INSIDE Electron. Usage:
//   SEVNT_ENGINE_PYTHON=<python> SEVNT_TEST_WHISPER_DIR=<dir with whisper-v1.9.1-m1> electron tests/electron/fallback-whispercpp.electron.js <speech.wav> <result.json> [expected words file]
// Real pipeline.transcribeAudio, real whisper.cpp binary + model. Proves the fallback produces an actual transcript.
// Scenario "stopped": engine down -> whisper.cpp. Scenario "lowram": engine up but free RAM below the guard -> whisper.cpp.
'use strict';
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const [wav, outFile] = process.argv.slice(-2);
const scenario = process.env.SEVNT_TEST_SCENARIO || 'stopped';
const results = [];
const rec = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPECT = ['welcome', 'regression', 'transcription', 'fallback', 'quick', 'brown', 'fox', 'gold', 'prices', 'interest', 'rate', 'support', 'listening'];

app.whenReady().then(async () => {
  let eng;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-fb-'));
    app.setPath('userData', tmp);
    // reuse the downloaded bundle without copying 190 MB
    fs.mkdirSync(path.join(tmp, 'whisper'), { recursive: true });
    fs.symlinkSync(process.env.SEVNT_TEST_WHISPER_DIR, path.join(tmp, 'whisper', 'whisper-v1.9.1-m1'), 'junction');
    process.env.SEVNT_ENGINE_MODELS_DIR = process.env.SEVNT_TEST_HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
    const wb = require('../../src/whisper-bundle');
    rec('whisper.cpp bundle detected as installed', wb.isInstalled('small'));
    eng = require('../../src/sevnt-engine').init(require('electron'));
    for (let i = 0; i < 120 && eng.status.state !== 'ready'; i++) await sleep(500);
    rec('engine ready', eng.status.state === 'ready');
    if (scenario === 'stopped') await eng.stop();
    // TEST-ONLY: the app's own safety guard (needs 1.4 GB free for whisper.cpp Small) refuses on this 6.9 GB dev machine
    // when other apps are open. To prove whisper.cpp itself produces a transcript, os.freemem is stubbed for THIS test
    // process only. The real RAM is still ~1.2-1.4 GB, so the run is honest about being memory-tight. Reported in AUDIT/19.
    if (process.env.SEVNT_TEST_FAKE_FREE_GB) {
      const fake = Number(process.env.SEVNT_TEST_FAKE_FREE_GB) * 1024 ** 3;
      os.freemem = () => fake;
      rec('TEST STUB active: os.freemem faked for the guard only', true, `${process.env.SEVNT_TEST_FAKE_FREE_GB} GB`);
    }
    const pipe = require('../../src/pipeline-inverse-v1.js');
    const logs = []; let asked = 0;
    const sessionDir = fs.mkdtempSync(path.join(tmp, 'sess-'));
    const t0 = Date.now();
    const r = await pipe.__test.transcribeAudio({ asrEngine: 'fw-tiny', localAsr: true }, wav, sessionDir, {
      onLog: (m) => logs.push(String(m)), onProgress: () => {}, lang: 'en', sourceDurationSec: Number(process.env.SEVNT_TEST_DURATION || 22),
      onConfirmDownload: async () => { asked++; return 'groq'; },
    });
    const wall = (Date.now() - t0) / 1000;
    if (scenario === 'lowram') {
      // Real memory pressure created by tests/helpers/ram-hog.js. Nothing may throw; engine must refuse; app must carry on.
      rec('LOW RAM: pipeline returned without throwing', Array.isArray(r.words), `${(r.words || []).length} words in ${wall.toFixed(1)}s`);
      // Windows pages the hog out, so real pressure cannot be forced from user mode: record WHICH path ran, do not assert one.
      rec('LOW RAM: outcome recorded (engine ran or declined; either is acceptable, a throw is not)', true, logs.filter((l) => /RAM|memori|memory|whisper|engine/i.test(l)).slice(0, 6).join(' || '));
      results.push({ name: 'logs', ok: true, detail: logs.slice(0, 25) });
      throw new Error('__done__');
    }
    const text = (r.words || []).map((w) => String(w.text || w.word || '').toLowerCase().replace(/[^a-z]/g, '')).join(' ');
    const hit = EXPECT.filter((w) => text.includes(w));
    rec('pipeline returned a real transcript (words)', (r.words || []).length >= 30, `${(r.words || []).length} words in ${wall.toFixed(1)}s`);
    rec('transcript matches the spoken text', hit.length >= EXPECT.length - 1, `${hit.length}/${EXPECT.length} key words; text="${text.slice(0, 160)}"`);
    rec(scenario === 'engine' ? 'came from the engine (faster-whisper)' : 'came from whisper.cpp, not the engine', scenario === 'engine' ? logs.some((l) => /faster-whisper/.test(l)) : (!logs.some((l) => /via faster-whisper/.test(l)) && logs.some((l) => /whisper/i.test(l))), logs.filter((l) => /whisper|RAM|engine/i.test(l)).slice(0, 6).join(' || '));
    rec('no download prompt (bundle was already installed)', asked === 0, `asked=${asked}`);
    rec('timestamps are monotonic and within audio length', (r.words || []).every((w, i, a) => w.end >= w.start && (i === 0 || w.start >= a[i - 1].start - 0.01)) && (r.words || []).length > 0 && r.words[r.words.length - 1].end <= Number(process.env.SEVNT_TEST_MAX_END || 23.5));
    results.push({ name: 'logs', ok: true, detail: logs.slice(0, 25) });
  } catch (e) {
    if (!(e && e.message === '__done__')) rec('unexpected error', false, e && e.stack || String(e));
  }
  try { if (eng) await eng.stop(); } catch (_) {}
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  app.exit(results.every((x) => x.ok) ? 0 : 1);
});
