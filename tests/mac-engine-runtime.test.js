'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EngineSupervisor, STATES } = require('../src/engine/engine-supervisor');

const root = path.join(__dirname, '..');
const runtimeRoot = path.join(root, 'build', 'engine-runtime', `darwin-${process.arch}`);
const pythonPath = path.join(runtimeRoot, 'bin', 'python3');

test('bundled Python engine starts, enforces its bearer token, serves capabilities, and shuts down', { timeout: 360000 }, async (t) => {
  assert.ok(fs.existsSync(pythonPath), `Python runtime missing: ${pythonPath}`);
  assert.ok(fs.existsSync(path.join(root, 'engine', 'sevnt_engine', 'server.py')), 'Engine server source missing');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-macos-engine-qa-'));
  const supervisor = new EngineSupervisor({
    pythonPath,
    engineDir: path.join(root, 'engine'),
    dataDir: path.join(temp, 'data'),
    modelsDir: path.join(temp, 'models'),
    lockFile: path.join(temp, 'engine.lock'),
    healthTimeoutMs: 60000,
    maxRestarts: 0,
    log: (message) => t.diagnostic(message),
  });

  try {
    const started = await supervisor.start();
    assert.equal(started.state, STATES.READY, JSON.stringify(started.error || started));
    assert.ok(started.port > 0, 'Engine did not publish a loopback port');

    const base = `http://127.0.0.1:${started.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.engine, 'sevnt-local-engine');

    const denied = await fetch(`${base}/api/v1/system/profile`);
    assert.equal(denied.status, 401, 'Protected endpoint accepted a request without a token');

    const headers = { Authorization: `Bearer ${supervisor.token}` };
    const profileResponse = await fetch(`${base}/api/v1/system/profile`, { headers });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.platform, 'darwin');
    const expectedMachine = process.env.SEVNT_QA_EXPECTED_ARCH === 'x64' ? 'x86_64' : 'arm64';
    assert.equal(profile.machine, expectedMachine, 'Python runtime architecture does not match the CI target');
    assert.match(profile.python, /^3\\.11\\./, 'Engine is not running the expected Python 3.11 runtime');

    const capsResponse = await fetch(`${base}/api/v1/system/whisper-capabilities`, { headers });
    assert.equal(capsResponse.status, 200);
    const caps = await capsResponse.json();
    assert.equal(typeof caps.faster_whisper_available, 'boolean');
    assert.ok(caps.models && caps.models.tiny && caps.models.base && caps.models.small);
    assert.equal(caps.device, 'cpu');
    assert.equal(caps.compute_type, 'int8');

    const badAsr = await fetch(`${base}/api/v1/asr/transcribe`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_path: path.join(temp, 'missing-audio.wav'), model: 'tiny', allow_download: false }),
    });
    assert.equal(badAsr.status, 400);
    assert.equal((await badAsr.json()).error, 'bad_path');

    // macOS built-in speech synthesis provides a deterministic real-speech fixture.
    const speechPath = path.join(temp, 'qa-speech.wav');
    const speech = require('node:child_process').spawnSync('say', [
      '-o', speechPath, '--file-format=WAVE', '--data-format=LEI16@16000',
      'Hello, this is a short test of the SEVNT transcription engine. The quick brown fox jumps over the lazy dog.',
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(speech.status, 0, `macOS speech synthesis failed: ${speech.stderr || speech.error || speech.status}`);
    assert.ok(fs.existsSync(speechPath) && fs.statSync(speechPath).size > 10000, 'Speech fixture was not generated');

    const { transcribeViaEngine } = require('../src/engine/engine-asr');
    const transcription = await transcribeViaEngine(supervisor, {
      audioPath: speechPath, model: 'tiny', language: 'en', pollMs: 500,
      timeoutMs: 240000, allowDownload: true,
    });
    const transcriptText = transcription.words.map((word) => word.text.toLowerCase().replace(/[^a-z]/g, '')).join(' ');
    assert.ok(transcription.words.length >= 10, `Too few recognized words: ${transcriptText}`);
    assert.match(transcriptText, /transcription|test/, `Expected speech not found: ${transcriptText}`);
    assert.match(transcriptText, /fox|quick/, `Expected speech not found: ${transcriptText}`);
    assert.ok(transcription.words.every((word) => word.end > word.start), 'Word timestamps are invalid');
    assert.equal(transcription.modelUsed, 'tiny');

    await supervisor.stop();
    assert.equal(supervisor.status.state, STATES.STOPPED);
  } finally {
    await supervisor.stop().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
