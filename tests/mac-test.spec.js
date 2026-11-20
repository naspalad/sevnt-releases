
const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test.setTimeout(90000);

test('Test buka SEVNT di macOS & cek tampilan', async () => {
  const releaseDir = path.join(__dirname, '../release');

  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Folder release tidak ditemukan: ${releaseDir}`);
  }

  const arch = process.arch;
  const subFolders = fs.readdirSync(releaseDir);

  const macFolder = subFolders.find(
    (folder) => folder === `mac-${arch}`
  ) || subFolders.find((folder) => folder === 'mac');

  if (!macFolder) {
    throw new Error(`Folder macOS untuk arsitektur ${arch} tidak ditemukan.`);
  }

  const targetDir = path.join(releaseDir, macFolder);

  const appBundle = fs.readdirSync(targetDir).find(
    (file) => file.endsWith('.app')
  );

  if (!appBundle) {
    throw new Error(`File .app tidak ditemukan di ${targetDir}`);
  }

  const macOsDir = path.join(targetDir, appBundle, 'Contents/MacOS');

  if (!fs.existsSync(macOsDir)) {
    throw new Error(`Folder executable tidak ditemukan: ${macOsDir}`);
  }

  const execFile = fs.readdirSync(macOsDir).find(
    (file) => !file.startsWith('.')
  );

  if (!execFile) {
    throw new Error('Executable macOS tidak ditemukan.');
  }

  const appPath = path.join(macOsDir, execFile);

  console.log('====================================');
  console.log('SEVNT MACOS STARTUP DIAGNOSTIC');
  console.log('Architecture:', arch);
  console.log('Executable:', appPath);
  console.log('====================================');

  let electronApp;
  let childProcess;
  let exitInfo = null;
  let stdoutLog = '';
  let stderrLog = '';

  try {
    electronApp = await electron.launch({
      executablePath: appPath,
      timeout: 30000,
    });

    childProcess = electronApp.process();

    // Listener dipasang segera setelah proses tersedia.
    childProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      stdoutLog += output;
      console.log(`[STDOUT] ${output.trim()}`);
    });

    childProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      stderrLog += output;
      console.error(`[STDERR] ${output.trim()}`);
    });

    childProcess.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      console.error(
        `!!! SEVNT EXIT: code=${code}, signal=${signal} !!!`
      );
    });

    console.log('1. Electron berhasil diluncurkan.');

    const debugInfo = await electronApp.evaluate(
      async ({ app, BrowserWindow }) => {
        return {
          argv: process.argv,
          platform: process.platform,
          architecture: process.arch,
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          isReady: app.isReady(),
          windowCount: BrowserWindow.getAllWindows().length,
          appName: app.getName(),
          appPath: app.getAppPath(),
        };
      }
    );

    console.log(
      '2. Informasi startup:',
      JSON.stringify(debugInfo, null, 2)
    );

    console.log('3. Menunggu jendela pertama...');

    const window = await electronApp.firstWindow({
      timeout: 30000,
    });

    console.log('4. Jendela pertama berhasil dibuka.');

    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(4000);

    const screenshotPath = path.join(
      process.cwd(),
      `hasil-test-macos-${arch}.png`
    );

    await window.screenshot({ path: screenshotPath });

    console.log('5. Screenshot:', screenshotPath);

    const title = await window.title();

    console.log('6. Judul aplikasi:', title);

    expect(title.length).toBeGreaterThan(0);

    console.log('7. SEVNT STARTUP TEST BERHASIL.');

  } catch (error) {
    console.error('====================================');
    console.error('SEVNT STARTUP TEST GAGAL');
    console.error(error.stack || error.message);
    console.error('====================================');

    console.error('STDOUT LOG:', stdoutLog);
    console.error('STDERR LOG:', stderrLog);
    console.error('EXIT INFO:', exitInfo);

    throw error;

  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch (closeError) {
        console.error(
          'Gagal menutup Electron:',
          closeError.message
        );
      }
    }
  }
});
