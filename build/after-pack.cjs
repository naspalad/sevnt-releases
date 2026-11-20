'use strict';
// electron-builder afterPack: stamp the Windows exe with the product identity (icon, name, version, company).
// electron-builder's own step (winCodeSign) cannot run without the symlink privilege, so rcedit is called directly.
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const mod = await import('rcedit'); const rcedit = typeof mod.default === 'function' ? mod.default : (mod.rcedit || mod.default?.rcedit || mod.default?.default);
  const productName = context.packager.appInfo.productName;
  const exe = path.join(context.appOutDir, `${productName}.exe`);
  if (!fs.existsSync(exe)) throw new Error(`afterPack: ${exe} not found`);
  const version = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, 'assets', 'brand', 'icon.ico'),
    'version-string': {
      ProductName: productName,
      FileDescription: productName,
      CompanyName: 'Seventy',
      LegalCopyright: 'Copyright © Seventy',
      OriginalFilename: `${productName}.exe`,
      InternalName: productName,
    },
    'file-version': `${version}.0`,
    'product-version': `${version}.0`,
  });
  console.log(`  • afterPack: identity stamped on ${path.basename(exe)} (${version})`);
};
