// Runs INSIDE Electron (the pipeline module only loads there). Usage:
//   SEVNT_ENGINE_PYTHON=<python> electron tests/electron/asr-tier.electron.js <speech.wav> <result.json>
// Real engine, real pipeline.transcribeAudio, real audio. whisper.cpp is NOT executed (its bundle is not installed here);
// the fallback is proven by reaching the whisper.cpp tier's decision point.
'use strict';
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const [wav, outFile] = process.argv.slice(-2);
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-asr-tier-'));
    app.setPath('userData', tmp);
    process.env.SEVNT_ENGINE_MODELS_DIR = process.env.SEVNT_TEST_HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
    const eng = require('../../src/sevnt-engine').init(require('electron'));
    for (let i = 0; i < 120 && eng.status.state !== 'ready'; i++) await sleep(500);
    rec('engine reaches ready inside Electron (auto-start)', eng.status.state === 'ready', JSON.stringify(eng.status));
    const pipe = require('../../src/pipeline-inverse-v1.js');
    const run = async (cfg, label) => {
      const logs = []; let asked = 0;
      const sessionDir = fs.mkdtempSync(path.join(tmp, 'sess-'));
      const r = await pipe.__test.transcribeAudio(cfg, wav, sessionDir, {
        onLog: (m) => logs.push(String(m)), onProgress: () => {}, lang: 'en', sourceDurationSec: 10,
        onConfirmDownload: async () => { asked++; return 'groq'; },
      });
      return { r, logs, asked, label };
    };
    // 1) engine tier succeeds
    let t = await run({ asrEngine: 'fw-tiny', localAsr: 'ask' }, 'engine');
    rec('S1 via pipeline: words returned by faster-whisper', t.r.words.length >= 10 && t.logs.some((l) => /via faster-whisper/.test(l)), `${t.r.words.length} words; logs=${t.logs.filter((l) => /faster-whisper/.test(l)).join(' | ')}`);
    rec('S1 via pipeline: whisper.cpp tier NOT used when engine succeeds', t.asked === 0);
    // 2) default setting does not touch the engine
    t = await run({ localAsr: 'ask' }, 'default');
    rec('default (whisper.cpp) never calls the engine', !t.logs.some((l) => /faster-whisper/.test(l)) && t.asked === 1, `asked=${t.asked}`);
    // 3) engine stopped -> fallback reaches whisper.cpp tier
    await eng.stop();
    t = await run({ asrEngine: 'fw-tiny', localAsr: 'ask' }, 'fallback');
    rec('FALLBACK: engine stopped -> message + whisper.cpp tier reached', t.logs.some((l) => /memakai whisper\.cpp|beralih ke whisper\.cpp/.test(l)) && t.asked === 1, `asked=${t.asked}; ${t.logs.filter((l) => /faster-whisper/.test(l)).join(' | ')}`);
    rec('FALLBACK: pipeline returns cleanly (no throw) with empty transcript when nothing else is available', Array.isArray(t.r.words) && t.r.words.length === 0);
    // 4) localAsr=false disables engine tier as well
    await eng.start();
    t = await run({ asrEngine: 'fw-tiny', localAsr: false }, 'off');
    rec('localAsr=false (user opted out) also skips the engine', !t.logs.some((l) => /via faster-whisper/.test(l)));
    await eng.stop();
  } catch (e) {
    rec('unexpected error', false, e && e.stack || String(e));
  }
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  app.exit(results.every((x) => x.ok) ? 0 : 1);
});
