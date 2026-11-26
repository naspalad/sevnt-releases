// Runs INSIDE Electron (stub bridge, throw-away profile, window placed off-screen). Plays the REAL dashboard preview of a baked 1080p
// clip and measures dropped frames, frame cadence and CPU per process, for several variants, to find what makes playback heavy.
// Usage: electron tests/electron/play-perf.electron.js <report.json> <result.json>
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const [reportFile, outFile] = process.argv.slice(-2);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-pp-')));
const pre = path.join(os.tmpdir(), 'sevnt-pp-preload-' + process.pid + '.js');
const realCfg = require('./qa-settings').createQaSettings({ format: 'landscape' });
fs.writeFileSync(pre, `
const CFG = ${JSON.stringify(realCfg)};
const mk = (name) => new Proxy(function () {}, {
  get(_t, k) { if (k === 'then' || typeof k === 'symbol') return undefined; return mk(name + '.' + String(k)); },
  apply(_t, _this, args) {
    if (/getSettings$/.test(name)) return Promise.resolve(CFG);
    if (/setSettings$/.test(name)) return Promise.resolve(Object.assign(CFG, args[0] || {}));
    if (/\.on[A-Z]/.test(name)) return () => {};
    return Promise.resolve({ ok: true });
  },
});
window.socl = mk('socl');
`);
app.whenReady().then(async () => {
  const res = { variants: [], gpu: null };
  try {
    const win = new BrowserWindow({ show: true, x: -3000, y: 0, width: 1500, height: 950, webPreferences: { preload: pre, contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, '..', '..', 'src', 'index.html'));
    await new Promise((r) => setTimeout(r, 4000));
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')); const base = rep.clips[0];
    const sess = path.dirname(path.dirname(base.file));
    const edit3 = path.join(sess, 'edited', '01-Pas Tidurnya Ya Enggak Bawa Ke Kasurnya-edit-3.mp4');
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    res.gpu = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : null;
    const run = async (name, setup, patch) => {
      await js(`(function(){ var c=${JSON.stringify(Object.assign({}, base, { file: edit3, subsBurned: true, cropAspect: '16:9', cropScale: 0.6, cropX: 0, cropY: 50 }, patch || {}))}; state.clips=[c]; state.activeClip=0; state.currentPreviewIdx=-1; dashCleanClip=null;
        var t=document.querySelector('.tour-root'); if(t) t.remove(); document.getElementById('clipsPage').classList.add('page-hidden'); document.getElementById('captionPage').classList.add('active'); ${setup || ''}
        loadPreview(0,{autoplay:false}); applyStageAspect(state.cfg.format); return 1; })()`);
      await wait(2500);
      await js(`window.__frames=[]; (function loop(t){ window.__frames.push(t); if(window.__frames.length<2000) window.__raf=requestAnimationFrame(loop); })(performance.now()); els.preview.currentTime=0; els.preview.muted=true; els.preview.play();`);
      app.getAppMetrics(); await wait(500);
      const m0 = app.getAppMetrics(); await wait(6000); const m1 = app.getAppMetrics();
      const q = await js(`(function(){ var v=els.preview.getVideoPlaybackQuality(); var f=window.__frames; var d=[]; for(var i=1;i<f.length;i++) d.push(f[i]-f[i-1]); d.sort(function(a,b){return a-b}); cancelAnimationFrame(window.__raf); els.preview.pause(); return { total:v.totalVideoFrames, dropped:v.droppedVideoFrames, rafMedianMs: d.length? +d[Math.floor(d.length/2)].toFixed(1):0, rafP95Ms: d.length? +d[Math.floor(d.length*0.95)].toFixed(1):0, rafCount:f.length }; })()`);
      const cpu = m1.map((p) => ({ type: p.type, cpu: +p.cpu.percentCPUUsage.toFixed(1) })).filter((p) => p.cpu > 0.5);
      res.variants.push(Object.assign({ name, cpu }, q));
    };
    const live = { file: base.rawFile || base.file, subsBurned: false, timeline: null };
    await run('F live layer + preset (as the app is)', '', live);
    await run('F2 same, Glow switch OFF', 'state.cfg.subtitleGlow=false;', live);
    await run('F3 same, no CSS blur filter on kinetic words', 'var s1=document.createElement("style"); s1.id="__k"; s1.textContent=".kin-el{filter:none!important}"; document.head.appendChild(s1);', live);
    await run('F4 same, no text-shadow on kinetic words', 'var o=document.getElementById("__k"); if(o) o.remove(); var s2=document.createElement("style"); s2.id="__k"; s2.textContent=".kin-el{text-shadow:none!important}"; document.head.appendChild(s2);', live);
    await run('F5 same, kinetic layer hidden (cost of everything else)', 'var o=document.getElementById("__k"); if(o) o.remove(); var s3=document.createElement("style"); s3.id="__k"; s3.textContent="#dashTitleLayer,.kin-blend-layer{display:none!important}"; document.head.appendChild(s3);', live);
  } catch (e) { res.error = String(e && e.stack || e).slice(0, 1500); }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
  app.exit(0);
});
