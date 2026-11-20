// Runs INSIDE Electron. Real ffmpeg check that Crop zoom/position now apply to Landscape and Square output (they used to be ignored).
// Source 1920x1080 = blue | red | blue thirds (red = x 640..1280). Usage: electron tests/electron/format-crop.electron.js <result.txt>
'use strict';
const { app } = require('electron');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
const out = process.argv[process.argv.length - 1];
app.whenReady().then(() => {
  const lines = []; let fails = 0;
  try {
    const pipe = require('../../src/pipeline-inverse-v1.js'); const ff = require('ffmpeg-static');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-fc-'));
    const src = path.join(tmp, 'src.png');
    execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:d=1', '-vf', 'drawbox=x=640:y=0:w=640:h=1080:color=red:t=fill', '-frames:v', '1', src]);
    const vfFor = pipe.__test.vfFor;
    const run = (label, fmt, W, args, want) => {
      const png = path.join(tmp, label.replace(/\W+/g, '_') + '.png');
      execFileSync(ff, ['-y', '-loglevel', 'error', '-i', src, '-vf', vfFor(fmt, '1080p', ...args), '-frames:v', '1', png]);
      const row = execFileSync(ff, ['-loglevel', 'error', '-i', png, '-vf', 'crop=iw:1:0:ih/2,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1e7 });
      let red = 0; for (let x = 0; x < W; x++) { if (row[x * 3] > 200 && row[x * 3 + 2] < 60) red++; }
      const okk = Math.abs(red - want) <= Math.max(10, W * 0.012);
      if (!okk) fails++;
      lines.push((okk ? 'PASS ' : 'FAIL ') + label + ': red ' + red + ' px of ' + W + ' (expected ' + want + ')');
    };
    run('landscape, no crop', 'landscape', 1920, [], 640);
    run('landscape, zoom 0.5 centred', 'landscape', 1920, [50, 50, null, 0.5], 1280);
    run('landscape, zoom 0.5 at far left', 'landscape', 1920, [0, 50, null, 0.5], 640);
    run('landscape, zoom 0.5 at far right', 'landscape', 1920, [100, 50, null, 0.5], 640);
    run('square, no crop', 'square', 1080, [], 640);
    run('square, zoom 0.5 centred', 'square', 1080, [50, 50, null, 0.5], 1080);
    run('square, zoom 0.7 at far left', 'square', 1080, [0, 50, null, 0.7], 166);   // window 756 px from x=0; red 640..756 = 116 px -> 116/756*1080
  } catch (e) { lines.push('ERROR ' + (e.stack || e)); fails++; }
  fs.writeFileSync(out, lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + 'FAILS ' + fails + String.fromCharCode(10));
  app.exit(fails ? 1 : 0);
});
