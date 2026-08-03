// During `npm install`, the electron package's own postinstall runs BEFORE this
// project's postinstall, so it extracts the Electron binary with the still
// -unpatched extract-zip — which hangs / fails on Node >=24 (see
// scripts/patch-extract-zip.mjs) and leaves node_modules/electron without its
// dist/path.txt completion marker ("Electron failed to install correctly").
// This runs after the extract-zip patch is applied and re-invokes Electron's
// installer, which now extracts correctly. It is a no-op when Electron is fine.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "node_modules", "electron");
const installer = path.join(electronDir, "install.js");

if (!fs.existsSync(installer)) {
  console.log("repair-electron: electron not installed, nothing to do.");
  process.exit(0);
}
if (fs.existsSync(path.join(electronDir, "path.txt"))) {
  console.log("repair-electron: electron already installed.");
  process.exit(0);
}

console.log("repair-electron: re-running electron installer with patched extract-zip…");
const result = spawnSync(process.execPath, [installer], { cwd: electronDir, stdio: "inherit" });
if (result.status !== 0 || !fs.existsSync(path.join(electronDir, "path.txt"))) {
  console.error("repair-electron: failed to install electron. Delete node_modules/electron and rerun `npm install`.");
  process.exit(0); // don't fail the whole install; packaging (dist:win) does not need node_modules/electron
}
console.log("repair-electron: electron installed.");
