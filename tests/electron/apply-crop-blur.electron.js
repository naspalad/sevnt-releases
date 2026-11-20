// Runs INSIDE Electron. Real applyClipCrop() on a real clip with format blur + crop; extracts a frame and measures the middle picture.
// Usage: electron tests/electron/apply-crop-blur.electron.js <report.json> <outdir> <result.json>
'use strict';
const { app } = require('electron');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const [reportFile, outDir, outFile] = process.argv.slice(-3);
app.whenReady().then(async () => {
  const res = { cases: [] };
  try {
    const pipe = require('../../src/pipeline-inverse-v1.js');
    const ff = require('ffmpeg-static'); const fp = require('@ffprobe-installer/ffprobe').path;
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')); const c = rep.clips[0];
    fs.mkdirSync(outDir, { recursive: true });
    const dur = Math.min(6, c.end - c.start);
    for (const [label, extra] of [['none', {}], ['1x1', { cropAspect: '1:1', cropScale: 1, cropX: 50, cropY: 50 }], ['9x16', { cropAspect: '9:16', cropScale: 1, cropX: 50, cropY: 50 }], ['16x9z', { cropAspect: '16:9', cropScale: 0.6, cropX: 20, cropY: 50 }]]) {
      const t0 = Date.now();
      const r = await pipe.applyClipCrop(Object.assign({ srcFile: c.rawFile || c.file, srcVideo: c.srcVideo, clipStart: c.start, clipEnd: c.start + dur, clipFormat: 'blur', clipResolution: '720p', binPaths: { ffmpeg: ff, ffprobe: fp } }, extra));
      const png = path.join(outDir, 'crop-' + label + '.png');
      execFileSync(ff, ['-y', '-loglevel', 'error', '-ss', '1', '-i', r.file, '-frames:v', '1', png]);
      const dims = execFileSync(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.file]).toString().trim();
      res.cases.push({ label, file: r.file, dims, seconds: (Date.now() - t0) / 1000, png });
    }
  } catch (e) { res.error = String(e && e.stack || e); }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
  app.exit(0);
});
