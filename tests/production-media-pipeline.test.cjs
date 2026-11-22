'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'qa-source.mp4');
const SUBTITLE = path.join(__dirname, 'fixtures', 'qa-transcript.srt');

function resolveBinaries() {
  let ffmpeg = null;
  let ffprobe = null;
  try { ffmpeg = require('ffmpeg-static'); } catch {}
  try { ffprobe = require('@ffprobe-installer/ffprobe').path; } catch {}
  return {
    ffmpeg: process.env.SEVNT_QA_FFMPEG_BIN || ffmpeg,
    ffprobe: process.env.SEVNT_QA_FFPROBE_BIN || ffprobe,
  };
}

function run(binary, args, label) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, label + ': ' + (result.stderr || result.stdout || result.status));
  return result.stdout || '';
}

function probe(ffprobe, file) {
  return JSON.parse(run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], 'ffprobe'));
}

function assertPlayable(ffmpeg, ffprobe, file, expectedWidth) {
  assert.ok(fs.existsSync(file), 'render output exists');
  assert.ok(fs.statSync(file).size > 4096, 'render output is non-empty');
  const meta = probe(ffprobe, file);
  const video = (meta.streams || []).find(stream => stream.codec_type === 'video');
  assert.ok(video, 'video stream exists');
  assert.equal(video.codec_name, 'h264');
  assert.ok(Number(meta.format.duration) > 0, 'duration is positive');
  if (expectedWidth) assert.equal(Number(video.width), expectedWidth);
  run(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], 'full video decode');
  return meta;
}

test('real bundled FFmpeg/FFprobe perform trim, crop, overlay/subtitle and split renders', { timeout: 360000 }, async (t) => {
  assert.ok(fs.existsSync(FIXTURE), 'QA source video fixture is present');
  assert.ok(fs.existsSync(SUBTITLE), 'QA subtitle fixture is present');
  const { ffmpeg, ffprobe } = resolveBinaries();
  assert.ok(ffmpeg && fs.existsSync(ffmpeg), 'Bundled FFmpeg is available; run npm install or set SEVNT_QA_FFMPEG_BIN');
  assert.ok(ffprobe && fs.existsSync(ffprobe), 'Bundled FFprobe is available; run npm install or set SEVNT_QA_FFPROBE_BIN');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-production-media-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const outputs = [];

  const base = path.join(outDir, 'trim-crop.mp4');
  run(ffmpeg, [
    '-y', '-hide_banner', '-v', 'error', '-ss', '0', '-i', FIXTURE, '-t', '4',
    '-vf', 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', base,
  ], 'trim + crop render');
  outputs.push({ file: base, width: 360 });

  const overlay = path.join(outDir, 'overlay-subtitle.mp4');
  const subtitlePath = SUBTITLE.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const overlayFilter = 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640,' +
    'drawbox=x=12:y=12:w=120:h=28:color=white@0.75:t=fill,subtitles=\'' + subtitlePath + '\'';
  run(ffmpeg, [
    '-y', '-hide_banner', '-v', 'error', '-ss', '0', '-i', FIXTURE, '-t', '4',
    '-vf', overlayFilter, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', overlay,
  ], 'overlay + subtitle render');
  outputs.push({ file: overlay, width: 360 });

  const split = path.join(outDir, 'split-screen.mp4');
  run(ffmpeg, [
    '-y', '-hide_banner', '-v', 'error', '-ss', '0', '-i', FIXTURE, '-t', '4',
    '-filter_complex', '[0:v]scale=180:320[left];[0:v]scale=180:320[right];[left][right]hstack=inputs=2[outv]',
    '-map', '[outv]', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', split,
  ], 'split-screen render');
  outputs.push({ file: split, width: 360 });

  const evidence = outputs.map(item => ({
    file: path.basename(item.file),
    bytes: fs.statSync(item.file).size,
    metadata: assertPlayable(ffmpeg, ffprobe, item.file, item.width),
  }));
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every(item => item.bytes > 4096));
  fs.writeFileSync(path.join(outDir, 'production-media-evidence.json'), JSON.stringify({
    suite: 'production-media-binary-integration',
    status: 'PASS',
    note: 'Real bundled FFmpeg/FFprobe transformations. This validates the media toolchain and output integrity; it does not claim every renderer feature is wired to this path.',
    outputs: evidence.map(item => ({ file: item.file, bytes: item.bytes })),
  }, null, 2));
});

test('production Python engine starts, enforces its token and reports media capabilities', { timeout: 180000 }, async (t) => {
  const { findPython, ROOT: repoRoot } = require('./helpers/engine-env');
  const pythonPath = findPython();
  assert.ok(pythonPath, 'Bundled Python runtime is missing. Build it with npm run engine:runtime or set SEVNT_ENGINE_PYTHON.');

  const { EngineSupervisor, STATES } = require('../src/engine/engine-supervisor');
  const { ffmpeg, ffprobe } = resolveBinaries();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-production-engine-'));
  const supervisor = new EngineSupervisor({
    pythonPath, engineDir: path.join(repoRoot, 'engine'),
    dataDir: path.join(tmp, 'data'), modelsDir: path.join(tmp, 'models'),
    ffmpegPath: ffmpeg, ffprobePath: ffprobe, lockFile: path.join(tmp, 'engine.lock'),
    healthTimeoutMs: 60000, maxRestarts: 0, log: message => t.diagnostic(message),
  });

  try {
    const started = await supervisor.start();
    assert.equal(started.state, STATES.READY, JSON.stringify(started.error || started));
    const health = await supervisor._http('GET', '/health', undefined, 10000, false);
    assert.equal(health.status, 'ok');

    await assert.rejects(
      fetch('http://127.0.0.1:' + started.port + '/api/v1/system/profile').then(async response => {
        if (!response.ok) throw Object.assign(new Error('unauthorized'), { status: response.status });
        return response.json();
      }),
      error => error.status === 401,
    );

    const profile = await supervisor.request('GET', '/api/v1/system/profile');
    assert.ok(profile.python.startsWith('3.11.'));
    assert.ok(profile.ffmpeg || ffmpeg);
    assert.ok(profile.ffprobe || ffprobe);
    const capabilities = await supervisor.request('GET', '/api/v1/system/whisper-capabilities');
    assert.equal(typeof capabilities.faster_whisper_available, 'boolean');
    assert.ok(capabilities.models && capabilities.models.tiny && capabilities.models.base && capabilities.models.small);
  } finally {
    await supervisor.stop();
    assert.equal(supervisor.status.state, STATES.STOPPED);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
