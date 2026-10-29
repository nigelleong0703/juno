// electron-builder can't compile an Icon Composer .icon yet (electron-userland/electron-builder#9254):
// ship the Assets.car that scripts/make-icon.py built from build/AppIcon.icon.
const { copyFileSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  copyFileSync(join(__dirname, "../build/Assets.car"), join(app, "Contents/Resources/Assets.car"));
};
