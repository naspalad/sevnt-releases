// Runs INSIDE Electron. Real renderClipEdit() (the path used when subtitles are ON) on a COPY of a real clip in a temp folder,
// Landscape format, with and without a zoomed crop. Measures how much the picture changes between the two outputs.
// Usage: electron tests/electron/render-edit-crop.electron.js <report.json> <result.json>
'use strict';
const { app } = require('electron');
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const [reportFile, outFile] = process.argv.slice(-2);
app.whenReady().then(async () => {
  const res = { cases: [] };
  try {
    const pipe = require('../../src/pipeline-inverse-v1.js');
    const ff = require('ffmpeg-static'); const fp = require('@ffprobe-installer/ffprobe').path;
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')); const c = rep.clips[0];
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'SEVNT_Dev', 'settings.json'), 'utf8'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-re-'));
    const dir = path.join(tmp, 'sess', 'raw'); fs.mkdirSync(dir, { recursive: true });
    const srcFile = path.join(dir, 'clip.mp4'); fs.copyFileSync(c.rawFile || c.file, srcFile);
    const dur = 5;
    const style = { subtitleStyle: cfg.subtitleStyle, subtitleFont: '', subtitleTracking: 3, subtitleOffsetMs: 0, subtitleFontSize: cfg.subtitleFontSize, subtitleY: cfg.subtitleY, subtitleX: cfg.subtitleX || 540, subtitleAnim: 'none', subtitleGlow: true, subtitleBoxColor: '', subtitleCase: 'none' };
    const words = (c.cueWords || []).filter((q) => q.end <= dur + 1).slice(0, 6);
    for (const [label, crop] of [['nocrop', {}], ['zoom06-left', { cropAspect: '16:9', cropScale: 0.6, cropX: 0, cropY: 50 }]]) {
      const r = await pipe.renderClipEdit(Object.assign({ srcFile, srcVideo: c.srcVideo, clipStart: c.start, clipEnd: c.start + dur, clipFormat: 'landscape', clipResolution: '720p', cueWords: words, style, titles: [], manualCaptions: [], trackPlan: null, binPaths: { ffmpeg: ff, ffprobe: fp }, cfg }, crop));
      const png = path.join(tmp, label + '.png');
      execFileSync(ff, ['-y', '-loglevel', 'error', '-ss', '2', '-i', r.file, '-frames:v', '1', png]);
      res.cases.push({ label, file: r.file, png });
    }
    // how different are the two frames (mean absolute difference, 0..255)
    const diff = execFileSync(ff, ['-hide_banner', '-i', res.cases[0].png, '-i', res.cases[1].png, '-filter_complex', '[0][1]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    res.diffOut = String(diff).slice(0, 300);
    res.dims = res.cases.map((x) => execFileSync(fp, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', x.file]).toString().trim());
  } catch (e) { res.error = String(e && e.stack || e).slice(0, 1500); }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
  app.exit(0);
});
