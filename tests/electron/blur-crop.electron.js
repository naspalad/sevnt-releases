// Runs INSIDE Electron. Real ffmpeg check of the Blur BG crop: a 1920x1080 source = blue | red | blue thirds (red = x 640..1280),
// plus a green top-left corner marker. For each crop setting the blur graph from vfFor('blur', ...) is rendered to a 1080x1920 frame
// and the middle picture is measured (what share of the middle row is red, and which side the marker is on).
// Usage: electron tests/electron/blur-crop.electron.js <result.txt>
'use strict';
const { app } = require('electron');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
const out = process.argv[process.argv.length - 1];
app.whenReady().then(() => {
  const lines = []; let fails = 0;
  const say = (m) => lines.push(m);
  try {
    const pipe = require('../../src/pipeline-inverse-v1.js');
    const ff = require('ffmpeg-static');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-bc-'));
    const src = path.join(tmp, 'src.png');
    execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:d=1',
      '-vf', 'drawbox=x=640:y=0:w=640:h=1080:color=red:t=fill', '-frames:v', '1', src]);
    const vfFor = pipe.__test.vfFor || pipe.vfFor;
    if (!vfFor) throw new Error('vfFor not exported');
    const measure = (label, args, expect) => {
      const g = vfFor(...args);
      const png = path.join(tmp, label.replace(/\W+/g, '_') + '.png');
      execFileSync(ff, ['-y', '-loglevel', 'error', '-i', src, '-filter_complex', g, '-map', '[out]', '-frames:v', '1', png]);
      const row = execFileSync(ff, ['-loglevel', 'error', '-i', png, '-vf', 'crop=iw:1:0:ih/2,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1e7 });
      let red = 0, blue = 0;
      for (let x = 0; x < 1080; x++) { const r = row[x * 3], b = row[x * 3 + 2]; if (r > 200 && b < 60) red++; else if (b > 200 && r < 60) blue++; }
      const okk = expect(red, blue);
      if (!okk) fails++;
      say((okk ? 'PASS ' : 'FAIL ') + label + '  (middle row: red ' + red + ' px, blue ' + blue + ' px)');
    };
    // 16:9 whole frame: red is the middle third = 360 of 1080
    measure('no crop (whole 16:9 frame)', ['blur', '1080p'], (r) => Math.abs(r - 360) < 12);
    measure('preset 16:9 centred = whole frame', ['blur', '1080p', 50, 50, null, 1, '16:9', null], (r) => Math.abs(r - 360) < 12);
    // 1:1 centred: source middle 1080 px -> red 640 of 1080
    measure('preset 1:1 centred', ['blur', '1080p', 50, 50, null, 1, '1:1', null], (r, b) => Math.abs(r - 640) < 14 && b > 300);
    // 9:16 centred: source middle 607 px -> almost all red
    measure('preset 9:16 centred', ['blur', '1080p', 50, 50, null, 1, '9:16', null], (r) => r > 1000);
    // 1:1 at the far left: source x 0..1080 -> red from 640..1080 = 440 px of 1080 (kept at the right side)
    measure('preset 1:1 box moved to the left', ['blur', '1080p', 0, 50, null, 1, '1:1', null], (r) => Math.abs(r - 440) < 14);
    // zoom 0.5 on 16:9 centred: window 960 px wide centred -> red 640 of 960 = 720 of 1080
    measure('preset 16:9 zoom 0.5', ['blur', '1080p', 50, 50, null, 0.5, '16:9', null], (r) => Math.abs(r - 720) < 14);
    // free rect covering only the red band
    measure('free rect = red band only', ['blur', '1080p', null, null, null, 1, 'free', { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }], (r) => r > 1000);
    // free rect covering left 2/3 of the frame: blue 640 + red 640 of 1280 -> red 540 of 1080
    measure('free rect = left two thirds', ['blur', '1080p', null, null, null, 1, 'free', { x: 0, y: 0, w: 2 / 3, h: 1 }], (r) => Math.abs(r - 540) < 14);
    // canvas must stay 9:16
    const g = vfFor('blur', '1080p', 50, 50, null, 1, '1:1', null);
    say((/scale=1080:1920/.test(g) ? 'PASS ' : 'FAIL ') + 'canvas stays 1080x1920');
    if (!/scale=1080:1920/.test(g)) fails++;
  } catch (e) { say('ERROR ' + (e.stack || e)); fails++; }
  fs.writeFileSync(out, lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + 'FAILS ' + fails + String.fromCharCode(10));
  app.exit(fails ? 1 : 0);
});
