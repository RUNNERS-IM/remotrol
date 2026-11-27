// electron-builder afterPack hook: removes the permission texts Electron's own Info.plist carries that Remotrol never
// uses, before the app is signed. Without a text macOS refuses the request, so these features stay off for good.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const UNUSED = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSAudioCaptureUsageDescription",
];

exports.default = async function dropUsageTexts(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const plists = [join(app, "Contents", "Info.plist")];
  // Why the helpers too: Electron's helper apps (GPU, Renderer, Plugin) carry the same texts in their own Info.plist.
  const frameworks = join(app, "Contents", "Frameworks");
  for (const name of require("node:fs").readdirSync(frameworks)) {
    if (name.endsWith(".app")) plists.push(join(frameworks, name, "Contents", "Info.plist"));
  }
  for (const plist of plists) {
    for (const key of UNUSED) {
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
      } catch {
        // The key was not there.
      }
    }
  }
};
