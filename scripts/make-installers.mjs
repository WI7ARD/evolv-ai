// Builds the installers from a package that already exists.
//
//   node scripts/make-installers.mjs            # host platform
//   node scripts/make-installers.mjs --platform=win32
//   node scripts/make-installers.mjs --platform=linux
//
// Windows gets an NSIS .exe; Linux gets an AppImage. Both are built from the
// directory scripts/pack-win.mjs produced, rather than from a second packaging
// pipeline. That matters: pack-win.mjs exists because forge's make cannot run
// in this toolchain, and it does real work — swapping in the Electron-ABI
// better_sqlite3.node, unpacking the voice assets out of the asar, writing
// release-integrity.json. Re-packaging with electron-builder to get installers
// would silently lose all of it, and the failure would show up as a shipped app
// whose database or voice does not start.
//
// So: package once, wrap twice. Run `npm run dist:win` or `npm run dist:linux`
// first; this refuses rather than guessing if the package is not there.
//
// Both wrappers cross-build from Linux, which is why CI can produce the pair on
// one runner. NSIS is a Linux package (`nsis`), and an AppImage is a squashfs
// image with a runtime concatenated in front of it.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrySync } from "./lib/retry.mjs";
import { buildBlockMap } from "../lib/block-delta.mjs";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = require(path.join(root, "package.json"));
const outDir = process.env.EVOLV_OUT_DIR ? path.resolve(process.env.EVOLV_OUT_DIR) : path.join(root, "out");

const platformArgument = process.argv.find((argument) => argument.startsWith("--platform="));
const platform = platformArgument?.split("=")[1] || (process.platform === "win32" ? "win32" : "linux");
if (!["win32", "linux"].includes(platform)) {
  throw new Error("Supported installer platforms are win32 and linux.");
}

// The AppImage runtime is fetched rather than vendored: it is a 200KB ELF that
// upstream publishes, and carrying a binary blob in the repository to save one
// download is a worse trade. `continuous` is upstream's only channel for it.
const APPIMAGE_RUNTIME_URL = "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64";

const packageDir = path.join(outDir, platform === "win32" ? "Evolv-win32-x64" : "Evolv-linux-x64");
if (!fs.existsSync(packageDir)) {
  throw new Error(
    `No package at ${packageDir}. Run ${platform === "win32" ? "npm run dist:win" : "npm run dist:linux"} first — `
    + "the installer wraps that package rather than building its own."
  );
}

function requireTool(command, hint) {
  const probe = spawnSync(command, ["-VERSION"], { stdio: "ignore" });
  const found = probe.error?.code !== "ENOENT";
  if (!found) throw new Error(`${command} is not installed. ${hint}`);
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function report(file) {
  const megabytes = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  const digest = checksum(file);
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, "ascii");
  console.log(`\nInstaller: ${file} (${megabytes} MB)\n${digest}`);
}

// --------------------------------------------------------------------- Windows

// A per-user install under LOCALAPPDATA, deliberately. A machine-wide install
// would need elevation, and Evolv keeps everything — profiles, database, keys —
// in the user's own space anyway, so asking for admin would buy nothing and
// cost the one thing an unsigned build cannot afford: a UAC prompt on top of a
// SmartScreen warning.
function buildWindowsInstaller() {
  requireTool("makensis", "Install it with `apt-get install nsis`, or `choco install nsis` on Windows.");

  const installerName = `Evolv-Setup-${pkg.version}.exe`;
  const makeDir = path.join(outDir, "make", "nsis", "win32", "x64");
  fs.mkdirSync(makeDir, { recursive: true });
  const target = path.join(makeDir, installerName);
  fs.rmSync(target, { force: true });

  const script = `
Unicode true
Name "Evolv"
OutFile "${target.replace(/\\/g, "\\\\")}"
InstallDir "$LOCALAPPDATA\\Programs\\Evolv"
InstallDirRegKey HKCU "Software\\Evolv" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!define MUI_ICON "${path.join(root, "build", "icon.ico").replace(/\\/g, "\\\\")}"
!define MUI_UNICON "${path.join(root, "build", "icon.ico").replace(/\\/g, "\\\\")}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\\Evolv.exe"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Evolv"
  SetOutPath "$INSTDIR"
  ; Clear the previous install first. Electron ships differently shaped trees
  ; between versions, and overwriting in place leaves orphaned locale and
  ; resource files that the new build never loads but the uninstaller still
  ; counts as ours.
  RMDir /r "$INSTDIR\\resources"
  RMDir /r "$INSTDIR\\locales"
  File /r "${packageDir.replace(/\\/g, "\\\\")}\\*.*"

  CreateShortcut "$SMPROGRAMS\\Evolv.lnk" "$INSTDIR\\Evolv.exe"
  CreateShortcut "$DESKTOP\\Evolv.lnk" "$INSTDIR\\Evolv.exe"

  WriteRegStr HKCU "Software\\Evolv" "InstallDir" "$INSTDIR"
  ; Registered per-user so it appears in Settings > Apps without elevation.
  !define UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Evolv"
  WriteRegStr HKCU "\${UNINSTALL_KEY}" "DisplayName" "Evolv"
  WriteRegStr HKCU "\${UNINSTALL_KEY}" "DisplayVersion" "${pkg.version}"
  WriteRegStr HKCU "\${UNINSTALL_KEY}" "Publisher" "Evolv"
  WriteRegStr HKCU "\${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\\Evolv.exe"
  WriteRegStr HKCU "\${UNINSTALL_KEY}" "UninstallString" "$INSTDIR\\Uninstall.exe"
  WriteRegDWORD HKCU "\${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "\${UNINSTALL_KEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Only the installed program is removed. Conversations, profiles, keys and
  ; downloaded models live in %APPDATA%\\Evolv and are left alone — an uninstall
  ; that silently destroyed someone's chat history would be unforgivable, and
  ; reinstalling is the common reason people uninstall.
  Delete "$SMPROGRAMS\\Evolv.lnk"
  Delete "$DESKTOP\\Evolv.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Evolv"
  DeleteRegKey HKCU "Software\\Evolv"
SectionEnd
`;

  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evolv-nsis-")), "evolv.nsi");
  fs.writeFileSync(scriptPath, script);
  console.log(`Building Windows installer from ${packageDir}…`);
  execFileSync("makensis", ["-V2", scriptPath], { stdio: "inherit" });
  fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });

  if (!fs.existsSync(target)) throw new Error("makensis reported success but produced no installer.");
  report(target);
}

// ----------------------------------------------------------------------- Linux

// One network call stands between a green build and a red one, and it is the
// last step of a job that has already spent five minutes packaging. A dropped
// connection there is not a broken commit, so it is retried rather than
// reported as a build failure.
const RETRY_ATTEMPTS = 4;

function fetchRuntime(destination) {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 100_000) return destination;
  console.log("Downloading the AppImage runtime…");

  // Downloaded beside the target and moved into place only once the size checks
  // out. A half-written file left at the destination would satisfy the cache
  // test above on the next run and get concatenated into an AppImage that
  // cannot start.
  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });

  try {
    retrySync(() => {
      try {
        execFileSync("curl", ["-sSL", "--fail", "--connect-timeout", "20", "-o", partial, APPIMAGE_RUNTIME_URL], { stdio: "inherit" });
        if (fs.statSync(partial).size < 100_000) throw new Error("the download looks truncated");
      } catch (error) {
        // Cleared on every failed attempt, so a partial file can never be
        // mistaken for a finished one by the next attempt or the next build.
        fs.rmSync(partial, { force: true });
        throw error;
      }
    }, { attempts: RETRY_ATTEMPTS, label: "The AppImage runtime download" });
  } catch (error) {
    throw new Error(
      `Could not download the AppImage runtime from ${APPIMAGE_RUNTIME_URL} after ${RETRY_ATTEMPTS} attempts `
      + `(${error.message}). This is a network failure, not a problem with the build.`
    );
  }

  fs.renameSync(partial, destination);
  return destination;
}

function buildAppImage() {
  requireTool("mksquashfs", "Install it with `apt-get install squashfs-tools`.");

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-appdir-"));
  const appDir = path.join(stage, "Evolv.AppDir");
  fs.cpSync(packageDir, appDir, { recursive: true });

  // An AppImage is mounted read-only at a path that changes every launch, so
  // nothing may be written inside it. Evolv already keeps its data in the
  // user's directories, which is what makes it a candidate for this format at
  // all — an app that wrote beside its binary could not ship this way.
  fs.writeFileSync(path.join(appDir, "evolv.desktop"), `[Desktop Entry]
Type=Application
Name=Evolv
Comment=Local-first AI chat that runs on your own machine
Exec=Evolv
Icon=evolv
Categories=Development;Utility;
Terminal=false
StartupWMClass=Evolv
`);
  fs.copyFileSync(path.join(root, "build", "icon.png"), path.join(appDir, "evolv.png"));
  // The spec still expects .DirIcon; some launchers read it and nothing else.
  fs.copyFileSync(path.join(root, "build", "icon.png"), path.join(appDir, ".DirIcon"));

  // --no-sandbox because the Chromium sandbox needs either a setuid helper or
  // unprivileged user namespaces, and an AppImage can rely on neither: it is
  // mounted noswid, and several distributions ship userns restricted. Evolv
  // loads only its own loopback server with contextIsolation on and node
  // integration off, so the renderer has no Node surface to escape to.
  fs.writeFileSync(path.join(appDir, "AppRun"), `#!/bin/sh
HERE="$(dirname "$(readlink -f "\${0}")")"
exec "\${HERE}/Evolv" --no-sandbox "$@"
`);
  fs.chmodSync(path.join(appDir, "AppRun"), 0o755);
  fs.chmodSync(path.join(appDir, "Evolv"), 0o755);

  const makeDir = path.join(outDir, "make", "appimage", "linux", "x64");
  fs.mkdirSync(makeDir, { recursive: true });
  const target = path.join(makeDir, `Evolv-${pkg.version}-x86_64.AppImage`);
  fs.rmSync(target, { force: true });

  const squashfs = path.join(stage, "evolv.squashfs");
  // Before compression, not after: squashing 600MB takes half a minute, and
  // there is no reason to spend it only to discover the network is down.
  const runtime = fetchRuntime(path.join(outDir, "appimage-runtime-x86_64"));

  console.log(`Building AppImage from ${packageDir}…`);
  // -root-owned so the image does not carry whichever uid happened to build it.
  execFileSync("mksquashfs", [appDir, squashfs, "-root-owned", "-noappend", "-comp", "zstd", "-Xcompression-level", "19"], {
    stdio: "inherit"
  });

  fs.writeFileSync(target, Buffer.concat([fs.readFileSync(runtime), fs.readFileSync(squashfs)]));
  fs.chmodSync(target, 0o755);
  fs.rmSync(stage, { recursive: true, force: true });

  report(target);
  return target;
}

// The map that lets an installed copy update itself without downloading the
// whole image again. Most of an AppImage is Electron, which is identical
// between releases; published alongside the image, this is what lets the
// updater ask for only the parts that differ.
async function writeBlockMap(target) {
  const mapPath = `${target}.blocks`;
  fs.writeFileSync(mapPath, await buildBlockMap(target));
  const size = fs.statSync(mapPath).size;
  console.log(`Block map: ${path.basename(mapPath)} (${(size / 1024).toFixed(0)} KB)`);
  report(mapPath);
}

if (platform === "win32") buildWindowsInstaller();
else await writeBlockMap(buildAppImage());
