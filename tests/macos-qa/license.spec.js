const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test.setTimeout(120000);

test('SEVNT macOS license activation', async () => {
  const email = process.env.SEVNT_QA_EMAIL;
  const licenseKey = process.env.SEVNT_QA_LICENSE_KEY;
  const expectedArch = process.env.SEVNT_QA_EXPECTED_ARCH;

  expect(email, 'GitHub Secret email belum tersedia').toBeTruthy();
  expect(licenseKey, 'GitHub Secret license key belum tersedia').toBeTruthy();
  expect(expectedArch).toMatch(/^(arm64|x64)$/);

  expect(process.platform).toBe('darwin');
  expect(process.arch).toBe(expectedArch);

  const releaseDir = path.join(process.cwd(), 'release');
  expect(fs.existsSync(releaseDir)).toBeTruthy();

  const folders = fs.readdirSync(releaseDir);
  const macFolder =
    folders.find((name) => name === `mac-${process.arch}`) ||
    folders.find((name) => name === 'mac');

  expect(macFolder, 'Folder build macOS tidak ditemukan').toBeTruthy();

  const targetDir = path.join(releaseDir, macFolder);
  const appBundle = fs.readdirSync(targetDir).find((name) => name.endsWith('.app'));

  expect(appBundle, 'Bundle .app tidak ditemukan').toBeTruthy();

  const macOsDir = path.join(targetDir, appBundle, 'Contents', 'MacOS');
  const executable = fs.readdirSync(macOsDir).find((name) => !name.startsWith('.'));

  expect(executable, 'Executable aplikasi tidak ditemukan').toBeTruthy();

  const appPath = path.join(macOsDir, executable);
  let electronApp;

  try {
    electronApp = await electron.launch({
      executablePath: appPath,
      timeout: 45000,
    });

    let licenseWindow = null;
    const deadline = Date.now() + 60000;

    while (Date.now() < deadline) {
      for (const page of electronApp.windows()) {
        try {
          if (
            await page.locator('#email').count() &&
            await page.locator('#license').count() &&
            await page.locator('#activate-btn').count()
          ) {
            licenseWindow = page;
            break;
          }
        } catch (_) {}
      }

      if (licenseWindow) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(
      licenseWindow,
      'Jendela aktivasi lisensi tidak ditemukan'
    ).toBeTruthy();

    await licenseWindow.locator('#email').fill(email);
    await licenseWindow.locator('#license').fill(licenseKey);
    await licenseWindow.locator('#activate-btn').click();

    const message = licenseWindow.locator('#message');

    await message.waitFor({ state: 'visible', timeout: 30000 });
    await licenseWindow.waitForFunction(() => {
      const el = document.querySelector('#message');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 30000 });

    const result = await message.evaluate((el) => ({
      text: el.textContent.trim(),
      className: el.className,
    }));

    console.log('License activation response:', result.text);
    expect(result.className).not.toMatch(/error/i);
    expect(result.text).not.toMatch(
      /email tidak cocok|invalid|gagal|failed|expired|already activated/i
    );

    console.log(`LICENSE ACTIVATION PASSED: ${expectedArch}`);
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
  }
});