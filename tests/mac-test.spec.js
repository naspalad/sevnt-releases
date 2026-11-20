const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Perpanjang timeout menjadi 120 detik agar verifikasi binary Python di arm64 tidak terpotong
test.setTimeout(120000);

test('Test buka SEVNT di macOS & cek tampilan', async () => {
  const releaseDir = path.join(__dirname, '../release');
  const subFolders = fs.readdirSync(releaseDir);
  const macFolder = subFolders.find((f) => f === `mac-${process.arch}` || f === 'mac');

  if (!macFolder) {
    throw new Error(`Folder build mac tidak ditemukan di ${releaseDir}. Isi: ${subFolders.join(', ')}`);
  }

  const targetDir = path.join(releaseDir, macFolder);
  const appBundle = fs.readdirSync(targetDir).find((file) => file.endsWith('.app'));
  const macOsDir = path.join(targetDir, appBundle, 'Contents/MacOS');
  const execFile = fs.readdirSync(macOsDir)[0];
  const appPath = path.join(macOsDir, execFile);

  console.log(`1. Menjalankan aplikasi (${process.arch}) dari:`, appPath);

  const electronApp = await electron.launch({
    executablePath: appPath,
    args: ['--no-sandbox', '--disable-gpu-sandbox'],
    timeout: 90000,
  });

  console.log('2. Proses Electron terhubung ke Playwright!');

  const childProcess = electronApp.process();
  childProcess.stdout.on('data', (data) => console.log(`[APP STDOUT]: ${data.toString().trim()}`));
  childProcess.stderr.on('data', (data) => console.error(`[APP STDERR]: ${data.toString().trim()}`));

  console.log('3. Menunggu jendela pertama terbuka...');
  const window = await electronApp.firstWindow({ timeout: 90000 });
  console.log('4. Jendela berhasil terbuka!');

  window.on('pageerror', (err) => console.error('[RENDERER ERROR]:', err));
  window.on('console', (msg) => console.log(`[RENDERER LOG]: ${msg.text()}`));

  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(5000);

  const screenshotPath = `hasil-test-macos-${process.arch}.png`;
  await window.screenshot({ path: screenshotPath });
  console.log('5. Screenshot tersimpan di:', screenshotPath);

  const title = await window.title();
  console.log('6. Judul jendela aplikasi:', title);
  expect(title.length).toBeGreaterThan(0);

  await electronApp.close();
});