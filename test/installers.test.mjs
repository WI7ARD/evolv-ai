import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts", "make-installers.mjs");

test("the installers wrap the real package rather than repackaging", async () => {
  const source = await readFile(script, "utf8");

  // This is the whole reason the script exists in this shape. pack-win.mjs
  // swaps in the Electron-ABI better_sqlite3.node and unpacks the voice assets
  // out of the asar; a second packaging pipeline would drop both silently and
  // the first sign would be a shipped app whose database will not open.
  assert.match(source, /Evolv-win32-x64/);
  assert.match(source, /Evolv-linux-x64/);
  // Checked against imports rather than the whole file, because the header
  // names electron-builder precisely to explain why it is not used.
  const imports = source.match(/^import .*$/gm)?.join("\n") || "";
  assert.doesNotMatch(imports, /electron-builder|@electron\/packager/, "installers must not package a second time");

  // And it must refuse rather than produce an empty installer.
  assert.match(source, /No package at .*Run/s);
});

test("uninstalling removes the program and never the user's data", async () => {
  const source = await readFile(script, "utf8");
  const uninstall = source.slice(source.indexOf('Section "Uninstall"'), source.indexOf("SectionEnd", source.indexOf('Section "Uninstall"')));

  assert.ok(uninstall.includes('RMDir /r "$INSTDIR"'), "the installed program should be removed");
  // Conversations, profiles, saved keys and downloaded models live in APPDATA.
  // Reinstalling is the usual reason to uninstall, and an uninstaller that
  // quietly deleted someone's chat history would be unforgivable.
  assert.doesNotMatch(uninstall, /\$APPDATA|userData/, "the uninstaller must not touch the user's data directory");
});

test("the Windows installer needs no administrator rights", async () => {
  const source = await readFile(script, "utf8");

  // A machine-wide install would need elevation. Evolv keeps everything in the
  // user's own space, so admin would buy nothing and cost a UAC prompt stacked
  // on top of the SmartScreen warning an unsigned build already gets.
  assert.match(source, /RequestExecutionLevel user/);
  assert.match(source, /InstallDir "\$LOCALAPPDATA/);
  assert.doesNotMatch(source, /RequestExecutionLevel admin/);
  // Registered under HKCU so it still appears in Settings > Apps.
  assert.match(source, /WriteRegStr HKCU "\\\$\{UNINSTALL_KEY\}" "DisplayName"/);
});

test("the AppImage can run where it is mounted", async () => {
  const source = await readFile(script, "utf8");

  // An AppImage is mounted read-only at a path that changes every launch, and
  // noexec-adjacent enough that the Chromium sandbox cannot use its setuid
  // helper. Evolv loads only its own loopback origin with contextIsolation on,
  // so there is no Node surface in the renderer to escape to.
  assert.match(source, /--no-sandbox/);
  assert.match(source, /readlink -f/, "AppRun must resolve its own directory, not assume a fixed path");
  assert.match(source, /Categories=/, "a desktop entry is what makes it appear in a launcher");
  assert.match(source, /\.DirIcon/);
});

test("CI builds and uploads both installers", async () => {
  const workflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

  assert.match(workflow, /npm run installer:win/);
  assert.match(workflow, /npm run installer:linux/);
  assert.match(workflow, /Evolv-Windows-Installer/);
  assert.match(workflow, /Evolv-Linux-AppImage/);
  // Both formats need tooling the runner does not ship with.
  assert.match(workflow, /nsis squashfs-tools/);
  // A silent upload of nothing is how a release goes out empty.
  assert.match(workflow, /if-no-files-found: error/);

  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts["installer:win"], "node scripts/make-installers.mjs --platform=win32");
  assert.equal(manifest.scripts["installer:linux"], "node scripts/make-installers.mjs --platform=linux");
});

test("an installer build refuses when there is no package to wrap", async (t) => {
  // Pointed at an empty output directory, so this never depends on whether a
  // package happens to be lying around from an earlier build.
  const empty = path.join(root, "out", "does-not-exist-for-tests");
  if (existsSync(empty)) return t.skip("scratch path unexpectedly exists");

  await assert.rejects(
    () => run(process.execPath, [script, "--platform=linux"], { env: { ...process.env, EVOLV_OUT_DIR: empty } }),
    (error) => /No package at/.test(error.stderr || "")
  );
});
