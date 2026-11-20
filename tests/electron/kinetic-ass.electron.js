// Runs the kinetic per-word style test inside Electron (font metrics need it).
// Usage: electron tests/electron/kinetic-ass.electron.js <result.txt>
'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const out = process.argv[process.argv.length - 1];
app.whenReady().then(() => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let code = 1;
  const realExit = process.exit;
  process.exit = (c) => {
    code = c;
    const st = String(new Error().stack).split(String.fromCharCode(10)).slice(1, 4).join(' <- ');
    lines.push('process.exit(' + c + ') called from: ' + st);
    throw new Error('__exit__');
  };
  try {
    require(path.join(__dirname, '..', 'test-kinetic-wordstyle.js'));
  } catch (e) {
    if (e.message !== '__exit__') lines.push('ERR ' + (e.stack || e));
  }
  process.exit = realExit;
  console.log = origLog;
  const nl = String.fromCharCode(10);
  fs.writeFileSync(out, (globalThis.__tl || lines).join(nl) + nl + 'EXIT ' + code + nl);
  app.exit(code);
});
