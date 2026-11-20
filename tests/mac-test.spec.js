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

  const electronApp = await electron.launch({
    executablePath: appPath,
    // Tambahkan --disable-gpu & software rendering agar tidak gagal inisialisasi GPU di VM macOS
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-logging'
    ],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      NODE_ENV: 'production'
    },
    timeout: 30000,
  });

  // Tangkap langsung jika aplikasi tiba-tiba menutup (quit) beserta exit code-nya!
  const childProcess = electronApp.process();
  childProcess.stdout.on('data', (data) => console.log(`[STDOUT]: ${data.toString().trim()}`));
  childProcess.stderr.on('data', (data) => console.error(`[STDERR]: ${data.toString().trim()}`));
  childProcess.on('exit', (code, signal) => {
    console.error(`!!! APLIKASI BERHENTI LEBIH AWAL! Exit Code: ${code}, Signal: ${signal} !!!`);
  });

  // Evaluasi status internal Electron main process
  const appInfo = await electronApp.evaluate(async ({ app }) => {
    return {
      isReady: app.isReady(),
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
    };
  });
  console.log('2. Info Electron Main Process:', appInfo);

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