const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test('Test buka SEVNT di macOS & cek tampilan', async () => {
  const releaseDir = path.join(__dirname, '../release');
  
  // Cari sub-folder hasil build mac (biasanya 'mac-arm64' atau 'mac')
  const subFolders = fs.readdirSync(releaseDir);
  const macFolder = subFolders.find((f) => f === `mac-${process.arch}` || f === 'mac');

  if (!macFolder) {
    throw new Error(`Folder build mac tidak ditemukan di ${releaseDir}. Isi: ${subFolders.join(', ')}`);
  }

  const targetDir = path.join(releaseDir, macFolder);
  const appBundle = fs.readdirSync(targetDir).find((file) => file.endsWith('.app'));

  if (!appBundle) {
    throw new Error(`File .app tidak ditemukan di ${targetDir}. Isi: ${fs.readdirSync(targetDir).join(', ')}`);
  }

  const macOsDir = path.join(targetDir, appBundle, 'Contents/MacOS');
  const execFile = fs.readdirSync(macOsDir)[0];
  const appPath = path.join(macOsDir, execFile);

  console.log(`Menjalankan aplikasi (${process.arch}) dari:`, appPath);

  const electronApp = await electron.launch({
    executablePath: appPath,
  });

  electronApp.on('window', (page) => {
    page.on('pageerror', (err) => {
      console.error('RENDERER ERROR:', err);
    });
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(4000); // Tunggu UI & backend FastAPI/Python siap

  await window.screenshot({ path: `hasil-test-macos-${process.arch}.png` });

  const title = await window.title();
  expect(title.length).toBeGreaterThan(0);

  await electronApp.close();
});