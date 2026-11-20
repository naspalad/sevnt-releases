// Runs INSIDE Electron with a throw-away profile and a STUB bridge (window.socl): loads the REAL index.html + renderer.js,
// opens the Caption Editor on a real clip from a session report, selects a word and drives font / italic / bold / colour
// through the real controls, then reads what the browser computes for that word in the live caption overlay.
// Usage: electron tests/electron/editor-wordstyle.electron.js <report.json> <result.json> [captionKinetic]
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const [reportFile, outFile, kin] = process.argv.slice(-3);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-ws-')));
const pre = path.join(os.tmpdir(), 'sevnt-ws-preload-' + process.pid + '.js');
const realCfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'SEVNT_Dev', 'settings.json'), 'utf8'));
realCfg.captionKinetic = (kin && kin !== 'none') ? kin : '';
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
window.__stub = true;
`);
app.whenReady().then(async () => {
  const res = { steps: [] };
  try {
    const win = new BrowserWindow({ show: false, width: 1500, height: 950, webPreferences: { preload: pre, contextIsolation: false, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) (res.console = res.console || []).push(String(msg).slice(0, 300)); });
    await win.loadFile(path.join(__dirname, '..', '..', 'src', 'index.html'));
    await new Promise((r) => setTimeout(r, 4000));
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const clip = rep.clips[0];
    const js = (code) => win.webContents.executeJavaScript(code, true);
    res.boot = await js('typeof state + "|" + typeof openCaptionEditor + "|" + (state && state.cfg ? "cfg" : "nocfg") + "|" + (state && state.cfg && state.cfg.captionKinetic)');
    await js(`(function(){ var c = ${JSON.stringify(clip)}; state.clips = [c]; state.activeClip = 0; return 1; })()`);
    await js('openCaptionEditor(0)');
    await new Promise((r) => setTimeout(r, 2500));
    res.hasEditor = await js('!!document.querySelector(".cap-editor") && document.querySelectorAll("#pw_words .pw-word").length');
    // pick the 3rd word of the first cue so it is not the first token
    await js('document.querySelectorAll("#pw_words .pw-word")[2].click()');
    await new Promise((r) => setTimeout(r, 800));
    const snap = async (label) => {
      const o = await js(`(function(){
        var tx = document.getElementById('capTx'); var ov = document.getElementById('capOv');
        var toks = tx ? [...tx.querySelectorAll('.pw-tok')] : [];
        var sel = document.querySelector('#pw_words .pw-word.sel');
        var ci = sel && +sel.dataset.ci, wi = sel && +sel.dataset.wi;
        var cue = clipCue(ci);
        function clipCue(i){ try { return state.clips[0].cueWords[i]; } catch(e){ return null; } }
        var tok = cue && cue.tokens && cue.tokens[wi];
        return { selWord: sel && sel.textContent, tokenStyleInData: tok && tok.style || null,
          kin: [...document.querySelectorAll('#capStage .kin-el')].map(function(n){var cs=getComputedStyle(n);return {t:n.textContent,fam:cs.fontFamily.slice(0,30),style:cs.fontStyle,w:cs.fontWeight,c:cs.color,px:cs.fontSize}}),
          ovVisible: ov && getComputedStyle(ov).visibility, ovText: tx && tx.textContent.slice(0,60), tokCount: toks.length,
          liveTokens: toks.map(function(t){var cs=getComputedStyle(t);return {t:t.textContent,fam:cs.fontFamily.slice(0,40),style:cs.fontStyle,w:cs.fontWeight,c:cs.color, inline:t.getAttribute('style').slice(0,120)}}),
          disabled: {font: document.getElementById('pw_font').disabled, ital: document.getElementById('pw_ital').disabled, bold: document.getElementById('pw_bold').disabled} };})()`);
      res.steps.push({ label, ...o });
    };
    await snap('after select');
    // italic
    await js('document.getElementById("pw_ital").click()');
    await new Promise((r) => setTimeout(r, 900));
    await snap('after italic click');
    // font
    await js('(function(){var s=document.getElementById("pw_font"); var o=[...s.options].find(function(x){return x.value==="Anton"}); s.value=o?o.value:s.options[2].value; s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await new Promise((r) => setTimeout(r, 1500));
    await snap('after font=Anton');
    // bold via the "Normal" proxy button of the right panel and the real bold button
    await js('document.getElementById("pw_bold").click()');
    await new Promise((r) => setTimeout(r, 900));
    await snap('after bold click');
    // colour for contrast
    await js('(function(){var c=document.getElementById("pw_color"); c.value="#ff0000"; c.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await new Promise((r) => setTimeout(r, 900));
    await snap('after colour red');
  } catch (e) { res.error = String(e && e.stack || e); }
  fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
  app.exit(0);
});
