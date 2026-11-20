// Runs INSIDE Electron with a throw-away profile (never touches the real app). Loads the app's real styles.css and checks
// what the browser actually computes for a per-word styled caption token (the exact inline style paintCue writes).
// Usage: electron tests/electron/cascade-probe.electron.js <result.json>
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const out = process.argv[process.argv.length - 1];
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sevnt-cascade-')));
app.whenReady().then(async () => {
  const css = 'file:///' + path.join(__dirname, '..', '..', 'src', 'styles.css').split(path.sep).join('/');
  const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><body>
  <div class="cap-stage" style="width:300px;height:500px;position:relative">
   <div class="cap-overlay style-white_clean" id="ov"><span id="capTx">
     <span class="pw-tok" id="base">biasa</span>
     <span class="pw-tok" id="font" style="font-family:&quot;Anton&quot; !important">font</span>
     <span class="pw-tok" id="ital" style="font-style:italic !important">miring</span>
     <span class="pw-tok" id="bold0" style="font-weight:400 !important">normal</span>
     <span class="pw-tok" id="color" style="color:#ff0000 !important">warna</span>
   </span></div></div>
  <div class="caption-overlay style-white_clean" id="ov2"><span id="captionText">
     <span class="pw-tok" id="d_font" style="font-family:&quot;Anton&quot; !important">font</span>
     <span class="pw-tok" id="d_ital" style="font-style:italic !important">miring</span></span></div></body>`;
  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  const page = path.join(os.tmpdir(), 'sevnt-cascade-' + process.pid + '.html');
  fs.writeFileSync(page, html);   // a file:// page can load the file:// stylesheet and fonts; a data: URL cannot
  await win.loadFile(page);
  await new Promise((r) => setTimeout(r, 1500));
  const res = await win.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;
    const g=(id)=>{const cs=getComputedStyle(document.getElementById(id));return {family:cs.fontFamily,style:cs.fontStyle,weight:cs.fontWeight,color:cs.color,synth:cs.fontSynthesis}};
    return {base:g('base'),font:g('font'),ital:g('ital'),bold0:g('bold0'),color:g('color'),d_font:g('d_font'),d_ital:g('d_ital'),
      anton:document.fonts.check('20px Anton'), fontsLoaded:[...document.fonts].filter(f=>f.status==='loaded').length, fontsAll:document.fonts.size}})()`);
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  app.exit(0);
});
