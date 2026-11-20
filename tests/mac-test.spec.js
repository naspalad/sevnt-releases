const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test.setTimeout(60000);

test('Test buka SEVNT di macOS & cek tampilan', async () => {
  const releaseDir = path.join(__dirname, '../release');
  const subFolders = fs.readdirSync(releaseDir);
  const macFolder = subFolders.find((f) => f === `mac-${process.arch}` || f === 'mac');
  const targetDir = path.join(releaseDir, macFolder);
  const appBundle = fs.readdirSync(targetDir).find((file) => file.endsWith('.app'));
  const macOsDir = path.join(targetDir, appBundle, 'Contents/MacOS');
  const execFile = fs.readdirSync(macOsDir)[0];
  const appPath = path.join(macOsDir, execFile);

  console.log(`1. Menjalankan aplikasi (${process.arch}) dari:`, appPath);

  // Jalankan TANPA custom args agar process.argv bersih seperti klik user asli
  const electronApp = await electron.launch({
    executablePath: appPath,
    timeout: 30000,
  });

  const childProcess = electronApp.process();
  childProcess.stdout.on('data', (data) => console.log(`[STDOUT]: ${data.toString().trim()}`));
  childProcess.stderr.on('data', (data) => console.error(`[STDERR]: ${data.toString().trim()}`));
  childProcess.on('exit', (code, signal) => {
    console.error(`!!! APLIKASI KELUAR! Exit Code: ${code}, Signal: ${signal} !!!`);
  });

  // Pasang penyadap pada app.quit & process.exit untuk mencetak baris kode pemanggilnya!
  const debugInfo = await electronApp.evaluate(async ({ app, BrowserWindow }) => {
    const origQuit = app.quit.bind(app);
    app.quit = (...args) => {
      console.error('>>> TERDETEKSI app.quit() DIPANGGIL DARI:\n', new Error().stack);
      return origQuit(...args);
    };

    const origExit = app.exit.bind(app);
    app.exit = (...args) => {
      console.error('>>> TERDETEKSI app.exit() DIPANGGIL DARI:\n', new Error().stack);
      return origExit(...args);
    };

    return {
      argv: process.argv,
      windowCount: BrowserWindow.getAllWindows().length,
      isReady: app.isReady()
    };
  });

  console.log('2. Status & Argumen Startup:', JSON.stringify(debugInfo, null, 2));

  console.log('3. Menunggu jendela pertama terbuka...');
  const window = await electronApp.firstWindow({ timeout: 30000 });
  console.log('4. Jendela berhasil terbuka!');

  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(4000);

  const screenshotPath = `hasil-test-macos-${process.arch}.png`;
  await window.screenshot({ path: screenshotPath });
  console.log('5. Screenshot tersimpan di:', screenshotPath);

  const title = await window.title();
  console.log('6. Judul jendela aplikasi:', title);
  expect(title.length).toBeGreaterThan(0);

  await electronApp.close();
});