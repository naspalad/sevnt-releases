'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ffmpeg = process.env.SEVNT_QA_FFMPEG_BIN || require('ffmpeg-static');
const ffprobe = process.env.SEVNT_QA_FFPROBE_BIN || require('@ffprobe-installer/ffprobe').path;

const fixture = path.join(__dirname, 'fixtures', 'qa-source.mp4');
const output = path.resolve('test-results', 'qa-render-output.mp4');

function run(binary, args) {
  if (!binary || !fs.existsSync(binary)) {
    throw new Error(`Required FFmpeg tool is missing or not executable: ${binary || '(empty path)'}`);
  }
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(binary)} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

test('native FFmpeg renders a playable MP4 on this macOS architecture', async () => {
  expect(fs.existsSync(fixture)).toBe(true);
  expect(fs.statSync(fixture).size).toBeGreaterThan(10000);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  run(ffmpeg, [
    '-y', '-i', fixture,
    '-vf', 'scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart',
    output,
  ]);

  expect(fs.existsSync(output)).toBe(true);
  expect(fs.statSync(output).size).toBeGreaterThan(10000);

  const probe = JSON.parse(run(ffprobe, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', output,
  ]));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  expect(video).toBeTruthy();
  expect(video.codec_name).toBe('h264');
  expect(Number(probe.format.duration)).toBeGreaterThan(3);
});
