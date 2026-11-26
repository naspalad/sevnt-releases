// Runs INSIDE Electron (stub bridge, throw-away profile): the REAL dashboard preview with a Landscape clip that has a crop.
// Shows what the dashboard plays in several states and saves a screenshot of the preview card for each.
// Usage: electron tests/electron/dash-crop.electron.js <report.json> <outdir> <result.json>
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const [reportFile, outDir, outFile] = process.argv.slice(-3);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-dc-')));
const pre = path.join(os.tmpdir(), 'sevnt-dc-preload-' + process.pid + '.js');
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
  const res = { scenarios: [] };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const win = new BrowserWindow({ show: false, width: 1500, height: 950, webPreferences: { preload: pre, contextIsolation: false, nodeIntegration: false, sandbox: false } });
    await win.loadFile(path.join(__dirname, '..', '..', 'src', 'index.html'));
    await new Promise((r) => setTimeout(r, 4000));
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const base = rep.clips[0];
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG()); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const scenario = async (name, patch, after) => {
      const clip = Object.assign({}, base, patch);
      await js(`(function(){ var c=${JSON.stringify(clip)}; state.clips=[c]; state.activeClip=0; state.currentPreviewIdx=-1; dashCleanClip=null; try{ if(typeof dashLive!=='undefined'&&dashLive) dashLive.refresh(); }catch(e){} ${after || ''} loadPreview(0,{autoplay:false}); try{ var t=document.querySelector('.tour-root'); if(t) t.remove(); document.getElementById('clipsPage').classList.add('page-hidden'); document.getElementById('captionPage').classList.add('active'); applyStageAspect(state.cfg.format); }catch(e){} return 1; })()`);
      await wait(3500);
      const info = await js(`(function(){ var p=els.preview; var st=document.getElementById('previewStage'); return { src:(p.currentSrc||'').split('/').slice(-2).join('/'), vw:p.videoWidth, vh:p.videoHeight, liveWanted: !!(typeof dashLive!=='undefined' && dashLive && dashLive.wanted), liveActive: !!(typeof dashLive!=='undefined' && dashLive && dashLive.active), liveVisible: (document.querySelector('#previewStage .live-frame-video')||{style:{}}).style.visibility, objectFit: p.style.objectFit, stage: st && Math.round(st.clientWidth)+'x'+Math.round(st.clientHeight), previewHidden: p.hidden, studioOpen: (function(){try{return isCaptionStudioOpen()}catch(e){return 'err'}})(), dashLiveExists: (typeof dashLive!=='undefined' && !!dashLive), plan: (function(){try{var c=state.clips[0];var f=formatForAspect(c.cropAspect,state.cfg.format);var r=FORMAT_AR[f]||'9/16';var q=r.split('/').map(Number);return JSON.stringify(window.LiveFraming.plan(c,{format:f,ratio:q[0]/q[1]},{mainRatio:p.videoWidth/p.videoHeight,kind:'dashboard'})).slice(0,160)+' fmt='+f}catch(e){return 'plan err '+e.message}})() }; })()`);
      await shot(name);
      res.scenarios.push(Object.assign({ name }, info));
    };
    const sess = path.dirname(path.dirname(base.file));
    const edit3 = path.join(sess, 'edited', '01-Pas Tidurnya Ya Enggak Bawa Ke Kasurnya-edit-3.mp4');
    const crop = { cropAspect: '16:9', cropScale: 0.6, cropX: 0, cropY: 50, manualFrame: true };
    await scenario('A_baked_file_burned', Object.assign({ file: edit3, subsBurned: true }, crop));
    await scenario('B_baked_file_forceClean', Object.assign({ file: edit3, subsBurned: true }, crop), 'dashCleanClip = state.clips[0]; dashCleanFromPanel = false;');
    await scenario('C_clean_raw_with_crop_nonlinear', Object.assign({ file: base.rawFile || base.file, subsBurned: false, timeline: { manualCuts: [[1, 2]], splits: [2] } }, crop));
    await scenario('D_clean_raw_with_crop', Object.assign({ file: base.rawFile || base.file, subsBurned: false }, crop));
  } catch (e) { res.error = String(e && e.stack || e).slice(0, 1500); }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
  app.exit(0);
});
