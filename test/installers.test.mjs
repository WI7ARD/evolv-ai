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

test("the Git LFS guard can actually fire", async (t) => {
  // `find -size -1k` rounds sizes up to whole blocks, so a 133-byte LFS
  // pointer counts as 1k and "smaller than 1k" matches nothing whatsoever.
  // Written that way the guard passes on a checkout containing no voice models
  // at all — which is how an installer ships with 133-byte stubs where Piper
  // and Whisper should be, and only fails when someone first uses voice.
  const workflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  // The command itself, not the file: the comment above it names the broken
  // form deliberately, to explain why it is not used.
  const commands = workflow.split("\n").filter((line) => /\bfind\b.*voice-assets/.test(line) && !line.trimStart().startsWith("#"));
  assert.ok(commands.length, "the guard should still exist");
  for (const command of commands) {
    assert.doesNotMatch(command, /-size -1k\b/, "a block-rounded size test can never match a pointer file");
    assert.match(command, /-size -1024c/);
  }

  // Proven rather than asserted: build a pointer file and check both forms
  // against the real `find`. Skipped on Windows, where `find.exe` is an
  // unrelated string-search tool and these arguments mean nothing — the step
  // being validated is a bash step that only ever runs on ubuntu-latest, so
  // there is nothing here for a Windows runner to verify.
  if (process.platform === "win32") return;

  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(path.join(tmpdir(), "evolv-lfs-"));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  await writeFile(path.join(scratch, "model.onnx"),
    "version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 632012\n");

  const seek = (size) => run("find", [scratch, "-type", "f", "-size", size, "-exec", "grep", "-l", "^version https://git-lfs", "{}", "+"])
    .then((result) => result.stdout.trim())
    .catch(() => "");

  assert.equal(await seek("-1k"), "", "confirms the old form was blind to pointers");
  assert.match(await seek("-1024c"), /model\.onnx/, "the form in the workflow must catch one");
});

test("no workflow installs dependencies without retrying", async () => {
  // A single socket hang-up while better-sqlite3 fetched its prebuilt binary
  // failed a whole build: the install fell back to compiling from source, and
  // the compiler fallback is dead on the current Windows image, which ships a
  // Visual Studio the bundled node-gyp reads as unsupported. The install has to
  // survive a blip on its own.
  const { readdir } = await import("node:fs/promises");
  const directory = path.join(root, ".github", "workflows");

  for (const file of await readdir(directory)) {
    const workflow = await readFile(path.join(directory, file), "utf8");
    const bare = workflow.split("\n").filter((line) => /^\s*-\s*(name:.*\n\s*)?run:\s*npm ci\b/.test(line));
    assert.deepEqual(bare, [], `${file} installs with a bare npm ci, which fails the build on one dropped connection`);
    assert.match(workflow, /uses: \.\/\.github\/actions\/install-deps/, `${file} should install through the retrying step`);
  }

  const action = await readFile(path.join(root, ".github", "actions", "install-deps", "action.yml"), "utf8");
  assert.match(action, /using: composite/);
  assert.match(action, /for attempt in 1 2 3/, "one attempt is what caused the failure");
  // Through the environment, so an argument cannot become part of the script.
  assert.match(action, /npm ci \$NPM_CI_ARGS/);
  assert.doesNotMatch(action.slice(action.indexOf("run: |")), /\$\{\{/, "inputs must not be interpolated into the script");
});

// A dropped connection while fetching the AppImage runtime failed a CI build
// that had already packaged both platforms successfully. Nothing was wrong with
// the commit, and nothing about a retry is guesswork — so these two tests drive
// the real script with a `curl` that misbehaves on purpose.
//
// Skipped on Windows: the shims are /bin/sh scripts, and the AppImage path only
// ever runs on the Linux runner.
async function withFakeTools(t, curlBehaviour) {
  const { mkdtemp, writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { rm } = await import("node:fs/promises");

  const scratch = await mkdtemp(path.join(tmpdir(), "evolv-appimage-"));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });

  // The package the installer wraps. Its contents do not matter here; that it
  // exists does, because the script refuses without it.
  await mkdir(path.join(scratch, "Evolv-linux-x64"), { recursive: true });
  await writeFile(path.join(scratch, "Evolv-linux-x64", "Evolv"), "#!/bin/sh\n");

  const shims = path.join(scratch, "bin");
  await mkdir(shims, { recursive: true });

  await writeFile(path.join(shims, "curl"), `#!/bin/sh
count=$(cat "$SHIM_STATE/curl-count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$SHIM_STATE/curl-count"
out=""
while [ $# -gt 0 ]; do
  [ "$1" = "-o" ] && out="$2"
  shift
done
${curlBehaviour}
`);
  // mksquashfs is probed with -VERSION before it is used.
  await writeFile(path.join(shims, "mksquashfs"), `#!/bin/sh
[ "$1" = "-VERSION" ] && exit 0
head -c 4096 /dev/zero > "$2"
`);
  await chmod(path.join(shims, "curl"), 0o755);
  await chmod(path.join(shims, "mksquashfs"), 0o755);

  return {
    scratch,
    build: () => run(process.execPath, [script, "--platform=linux"], {
      env: {
        ...process.env,
        PATH: `${shims}${path.delimiter}${process.env.PATH}`,
        SHIM_STATE: scratch,
        EVOLV_OUT_DIR: scratch,
        EVOLV_RETRY_DELAY_MS: "10"
      }
    }),
    curlCalls: async () => Number((await readFile(path.join(scratch, "curl-count"), "utf8")).trim())
  };
}

test("a dropped connection retries instead of failing the build", async (t) => {
  if (process.platform === "win32") return;

  // curl exit 56 is the failure CI actually hit: the connection died mid
  // transfer. The third attempt succeeds.
  const { scratch, build, curlCalls } = await withFakeTools(t, `
if [ "$count" -lt 3 ]; then exit 56; fi
head -c 200000 /dev/zero > "$out"`);

  await build();
  assert.equal(await curlCalls(), 3, "the first two failures should have been retried, not reported");

  const image = path.join(scratch, "make", "appimage", "linux", "x64", "Evolv-0.6.3-x86_64.AppImage");
  assert.ok(existsSync(image), "the build should finish once the download succeeds");
});

test("a truncated runtime is never left behind to be reused", async (t) => {
  if (process.platform === "win32") return;

  // A short read that curl itself calls a success. Cached at the destination it
  // would satisfy the next run's "already downloaded" check and get pasted onto
  // the front of an AppImage that cannot start.
  const { scratch, build, curlCalls } = await withFakeTools(t, `head -c 64 /dev/zero > "$out"`);

  await assert.rejects(build, (error) => /network failure, not a problem with the build/.test(error.stderr || ""));
  assert.equal(await curlCalls(), 4, "it should give up rather than retry forever");
  assert.equal(existsSync(path.join(scratch, "appimage-runtime-x86_64")), false,
    "a bad download must not be cached as a good one");
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
