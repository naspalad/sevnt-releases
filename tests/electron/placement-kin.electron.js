// Runs INSIDE Electron (stub bridge, throw-away profile): Clip Options > "Posisi & ukuran caption" with a Caption animasi preset on.
// Changes the size / Y through the real controls and reads the preset sentence in the mini frame and in the big preview.
// Usage: electron tests/electron/placement-kin.electron.js <report.json> <result.json>
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const [reportFile, outFile] = process.argv.slice(-2);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-pk-')));
const pre = path.join(os.tmpdir(), 'sevnt-pk-preload-' + process.pid + '.js');
const realCfg = require('./qa-settings').createQaSettings({ format: 'landscape', captionKinetic: 'cap_editorialswiss', subtitleFontSize: 64, subtitleY: 540 });
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
  const res = { steps: [] };
  try {
    const win = new BrowserWindow({ show: false, width: 1500, height: 950, webPreferences: { preload: pre, contextIsolation: false, nodeIntegration: false, sandbox: false } });
    await win.loadFile(path.join(__dirname, '..', '..', 'src', 'index.html'));
    await new Promise((r) => setTimeout(r, 4000));
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')); const base = rep.clips[0];
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await js(`(function(){ var c=${JSON.stringify(Object.assign({}, base, { subsBurned: false }))}; state.clips=[c]; state.activeClip=0; state.currentPreviewIdx=-1;
      var t=document.querySelector('.tour-root'); if(t) t.remove(); document.getElementById('clipsPage').classList.add('page-hidden'); document.getElementById('captionPage').classList.add('active');
      loadPreview(0,{autoplay:false}); renderPanel('clip'); applyStageAspect(state.cfg.format); return 1; })()`);
    await wait(2500);
    await js(`(function(){ var f=document.getElementById('f_cpFrame'); var card=f && f.closest('.ss-card'); if(card){ card.classList.add('open'); card.open=true; var h=card.querySelector('.ss-head,.ss-title,button,summary'); } document.querySelectorAll('.ss-card').forEach(function(c){ c.classList.add('open'); if('open' in c) c.open=true; }); var c0=state.clips[0].cueWords[0]; els.preview.currentTime=(c0.start||0)+0.4; try{ _lastPreviewCue=''; tickCaptionPreview(); }catch(e){} var n=document.getElementById('f_cpFrame'); while(n && n!==document.body){ if(n.hidden) n.hidden=false; if(getComputedStyle(n).display==='none') n.style.display='block'; if(n.classList && n.classList.contains('ss-body')) n.style.maxHeight='none'; n=n.parentElement; } paintCaptionPlacement(); return 1; })()`);
    await wait(1500);
    const snap = async (label) => {
      const o = await js(`(function(){ function words(sel){ return [...document.querySelectorAll(sel)].map(function(n){ var cs=getComputedStyle(n); return n.textContent+':'+Math.round(parseFloat(cs.fontSize)*10)/10+'px@'+Math.round(n.getBoundingClientRect().top); }).slice(0,4).join(' | '); }
        return { fs: state.cfg.subtitleFontSize, y: state.cfg.subtitleY, mini: words('#f_cpFrame .kin-el'), big: words('#previewStage .kin-el, #dashTitleLayer .kin-el'), plainSampleVisible: (document.getElementById('f_cpOv')||{style:{}}).style.visibility, hasFrame: !!document.getElementById('f_cpFrame'), frameSize: (function(){var f=document.getElementById('f_cpFrame'); return f? f.clientWidth+'x'+f.clientHeight : 'none'})() }; })()`);
      res.steps.push(Object.assign({ label }, o));
    };
    await snap('start (size 64, Y 540)');
    await js(`(function(){ var r=document.getElementById('f_cpFsRange'); r.value=110; r.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(1200); await snap('size -> 110');
    await js(`(function(){ var r=document.getElementById('f_cpFsRange'); r.value=40; r.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(1200); await snap('size -> 40');
    await js(`(function(){ var y=document.getElementById('f_cpY'); y.value=1200; y.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(1200); await snap('Y -> 1200');
  } catch (e) { res.error = String(e && e.stack || e).slice(0, 1500); }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
  app.exit(0);
});
