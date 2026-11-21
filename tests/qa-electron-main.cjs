'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

app.setName('SEVNT QA Harness');
app.setPath('userData', path.join(os.tmpdir(), 'sevnt-qa-harness-' + process.pid));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: true,
    backgroundColor: '#101114',
    webPreferences: {
      preload: path.join(__dirname, 'qa-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
