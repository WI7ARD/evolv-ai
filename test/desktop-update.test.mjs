import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { buildBlockMap } from "../lib/block-delta.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareVersions, DEFAULT_UPDATE_REPOSITORY, DesktopUpdateService, formatBytes, normalizeVersion, selectRelease } from "../electron/update-service.mjs";

test("the updater checks the repository that actually publishes the releases", async () => {
  // These had drifted apart: the updater checked WI7ARD/evolv-personal while
  // the release workflow publishes with the token of the repository it runs in.
  // Every check answered "no stable release is available" however many releases
  // existed, and nothing in the product could report the mismatch.
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const [, owner, repo] = manifest.repository.url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);

  assert.equal(DEFAULT_UPDATE_REPOSITORY, `${owner}/${repo}`);

  // The release workflow runs in this repository and publishes with its own
  // token, so the manifest is what has to agree with it.
  const workflow = await fs.readFile(new URL("../.github/workflows/release-windows.yml", import.meta.url), "utf8");
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test("a Linux update rebuilds the AppImage from the copy already installed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-appimage-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // An AppImage is mostly Electron, which does not change between releases.
  const shared = randomBytes(400 * 1024);
  const installed = Buffer.concat([shared, Buffer.from("application code v0.6.2".padEnd(4096, "."))]);
  const published = Buffer.concat([shared, Buffer.from("application code v0.6.3".padEnd(4096, "."))]);

  const appImagePath = path.join(root, "Evolv-0.6.2-x86_64.AppImage");
  await fs.writeFile(appImagePath, installed);
  const publishedPath = path.join(root, "published.AppImage");
  await fs.writeFile(publishedPath, published);
  const blocks = await buildBlockMap(publishedPath, { blockSize: 4096 });
  const sha256 = createHash("sha256").update(published).digest("hex");

  let rangedBytes = 0;
  let fullDownloads = 0;
  const service = new DesktopUpdateService({
    currentVersion: "0.6.2",
    userDataPath: path.join(root, "userData"),
    executablePath: path.join(root, "unused"),
    platform: "linux",
    appImagePath,
    spawnImpl: () => ({ unref() {} }),
    fetchImpl: async (url, options) => {
      const name = String(url).split("/").pop();
      if (String(url).includes("api.github.com")) {
        return new Response(JSON.stringify({
          tag_name: "v0.6.3",
          assets: ["Evolv-0.6.3-x86_64.AppImage", "Evolv-0.6.3-x86_64.AppImage.sha256", "Evolv-0.6.3-x86_64.AppImage.blocks"]
            .map((asset) => ({ name: asset, browser_download_url: `https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/${asset}` }))
        }), { status: 200 });
      }
      if (name.endsWith(".sha256")) return new Response(`${sha256}  Evolv-0.6.3-x86_64.AppImage\n`, { status: 200 });
      if (name.endsWith(".blocks")) return new Response(blocks, { status: 200 });
      const range = options?.headers?.range?.match(/bytes=(\d+)-(\d+)/);
      if (!range) {
        fullDownloads += 1;
        return new Response(published, { status: 200 });
      }
      const [, start, end] = range.map(Number);
      rangedBytes += end - start + 1;
      return new Response(published.subarray(start, end + 1), { status: 206 });
    }
  });

  assert.equal((await service.check()).release.available, true);
  const downloaded = await service.download();

  assert.equal(downloaded.phase, "ready");
  assert.equal(fullDownloads, 0, "the whole image was never downloaded");
  // The changed tail only, not the 400 KB of shared bytes ahead of it.
  assert.ok(rangedBytes < published.length / 4, `fetched ${rangedBytes} of ${published.length} bytes`);
  assert.equal(downloaded.savings.reusedBytes + downloaded.savings.fetchedBytes, published.length);

  const installedResult = await service.prepareInstall();
  assert.equal(installedResult.willRestart, true);
  // The running image is replaced by the new one, byte for byte, and the old
  // one is kept beside it rather than destroyed.
  assert.ok((await fs.readFile(appImagePath)).equals(published));
  assert.ok((await fs.readFile(`${appImagePath}.previous`)).equals(installed));
  // Windows has no execute bit and chmod is a no-op there, so this asks about
  // the platform the code path is for. Everything above it is filesystem
  // behaviour that is worth checking everywhere.
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(appImagePath)).mode & 0o111, 0o111, "and it is still executable");
  }
});

test("a block map describing some other file is refused", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-appimage-bad-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // The attack the map has to be checked against: a map for a different file
  // would assemble that file instead, and it would pass its own hash check.
  const appImagePath = path.join(root, "Evolv-0.6.2-x86_64.AppImage");
  await fs.writeFile(appImagePath, randomBytes(8192));
  const otherPath = path.join(root, "other.bin");
  await fs.writeFile(otherPath, randomBytes(8192));
  const blocks = await buildBlockMap(otherPath, { blockSize: 4096 });

  const service = new DesktopUpdateService({
    currentVersion: "0.6.2",
    userDataPath: path.join(root, "userData"),
    executablePath: path.join(root, "unused"),
    platform: "linux",
    appImagePath,
    fetchImpl: async (url) => {
      const name = String(url).split("/").pop();
      if (String(url).includes("api.github.com")) {
        return new Response(JSON.stringify({
          tag_name: "v0.6.3",
          assets: ["Evolv-0.6.3-x86_64.AppImage", "Evolv-0.6.3-x86_64.AppImage.sha256", "Evolv-0.6.3-x86_64.AppImage.blocks"]
            .map((asset) => ({ name: asset, browser_download_url: `https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/${asset}` }))
        }), { status: 200 });
      }
      if (name.endsWith(".sha256")) return new Response(`${"a".repeat(64)}  x\n`, { status: 200 });
      return new Response(blocks, { status: 200 });
    }
  });

  await service.check();
  await assert.rejects(() => service.download(), /does not describe the published release/);
});

test("Linux updates are offered only to an installed AppImage", () => {
  const base = { currentVersion: "0.6.2", userDataPath: os.tmpdir(), executablePath: path.join(os.tmpdir(), "evolv") };
  // Run from source or unpacked by a package manager, Evolv does not own the
  // files and must not replace them.
  assert.equal(new DesktopUpdateService({ ...base, platform: "linux", appImagePath: "" }).status().supported, false);
  assert.equal(new DesktopUpdateService({ ...base, platform: "linux", appImagePath: "/opt/Evolv.AppImage" }).status().supported, true);
  assert.equal(new DesktopUpdateService({ ...base, platform: "darwin", appImagePath: "" }).status().supported, false);
});

test("desktop update versions are strict and stable releases must be newer", () => {
  assert.equal(normalizeVersion("v0.6.3"), "0.6.3");
  assert.equal(compareVersions("0.6.3", "0.6.2"), 1);
  assert.equal(compareVersions("0.6.2", "0.6.2"), 0);
  assert.throws(() => normalizeVersion("0.6.3-beta"), /semantic versioning/);
  const current = selectRelease({ tag_name: "v0.6.2", assets: [] }, "0.6.2");
  assert.equal(current.available, false);
  assert.throws(() => selectRelease({ tag_name: "v0.6.3", prerelease: true }, "0.6.2"), /stable/);
});

test("new GitHub releases require exact ZIP and SHA-256 assets", () => {
  assert.throws(() => selectRelease({ tag_name: "v0.6.3", assets: [] }, "0.6.2"), /missing its ZIP/);
  const selected = selectRelease({
    tag_name: "v0.6.3",
    name: "Evolv 0.6.3",
    html_url: "https://github.com/WI7ARD/evolv-ai/releases/tag/v0.6.3",
    assets: [
      { name: "Evolv-win32-x64-0.6.3.zip", browser_download_url: "https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/Evolv-win32-x64-0.6.3.zip" },
      { name: "Evolv-win32-x64-0.6.3.zip.sha256", browser_download_url: "https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/Evolv-win32-x64-0.6.3.zip.sha256" }
    ]
  }, "0.6.2");
  assert.equal(selected.available, true);
  assert.equal(selected.version, "0.6.3");
});

test("desktop updater verifies, stages, and prepares an atomic Windows restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-update-test-"));
  const install = path.join(root, "installed", "Evolv-win32-x64");
  const executable = path.join(install, "Evolv.exe");
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(executable, "old");
  const zipBytes = Buffer.from("verified update fixture");
  const checksum = createHash("sha256").update(zipBytes).digest("hex");
  const release = {
    tag_name: "v0.6.3",
    assets: [
      { name: "Evolv-win32-x64-0.6.3.zip", browser_download_url: "https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/Evolv-win32-x64-0.6.3.zip" },
      { name: "Evolv-win32-x64-0.6.3.zip.sha256", browser_download_url: "https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/Evolv-win32-x64-0.6.3.zip.sha256" }
    ]
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("api.github.com")) return new Response(JSON.stringify(release), { status: 200 });
    if (value.endsWith(".sha256")) return new Response(`${checksum}  Evolv-win32-x64-0.6.3.zip\n`, { status: 200 });
    if (value.endsWith(".zip")) return new Response(zipBytes, { status: 200, headers: { "content-length": String(zipBytes.length) } });
    throw new Error(`Unexpected request ${value}`);
  };
  const extractImpl = async (_zip, { dir }) => {
    const staged = dir;
    await fs.mkdir(path.join(staged, "resources"), { recursive: true });
    await fs.writeFile(path.join(staged, "Evolv.exe"), "new");
    await fs.writeFile(path.join(staged, "resources", "app.asar"), "asar");
    await fs.writeFile(path.join(staged, "release-integrity.json"), JSON.stringify({
      schemaVersion: 1,
      version: "0.6.3",
      files: {
        "Evolv.exe": createHash("sha256").update("new").digest("hex"),
        "resources/app.asar": createHash("sha256").update("asar").digest("hex")
      }
    }));
  };
  let spawned;
  const service = new DesktopUpdateService({
    currentVersion: "0.6.2",
    userDataPath: path.join(root, "user-data"),
    executablePath: executable,
    fetchImpl,
    extractImpl,
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      return { unref() {} };
    },
    platform: "win32",
    pid: 1234
  });
  assert.equal((await service.check()).phase, "available");
  const downloaded = await service.download();
  assert.equal(downloaded.readyToInstall, true);
  const installing = await service.prepareInstall();
  assert.equal(installing.phase, "installing");
  assert.equal(spawned.command, "powershell.exe");
  assert.ok(spawned.args.includes("1234"));
  const script = await fs.readFile(path.join(root, "user-data", "updates", "apply-evolv-update.ps1"), "utf8");
  assert.match(script, /Move-Item -LiteralPath \$InstallDirectory -Destination \$backup/);
  assert.match(script, /updated Evolv process exited during startup/);
  await fs.rm(root, { recursive: true, force: true });
});

test("update downloads reject redirects away from GitHub", async () => {
  const service = new DesktopUpdateService({
    currentVersion: "0.6.2",
    userDataPath: os.tmpdir(),
    executablePath: path.join(os.tmpdir(), "Evolv.exe"),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/update.zip" } }),
    platform: "win32"
  });
  await assert.rejects(() => service.trustedFetch("https://github.com/WI7ARD/evolv-ai/releases/download/v0.6.3/update.zip"), /not trusted/);
});

test("the renderer exposes clear update controls without receiving filesystem access", async () => {
  const root = process.cwd();
  const html = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
  const preload = await fs.readFile(path.join(root, "electron", "preload.cjs"), "utf8");
  const main = await fs.readFile(path.join(root, "electron", "main.mjs"), "utf8");
  assert.match(html, /id="desktop-update-check"/);
  assert.match(html, /id="desktop-update-install"/);
  assert.match(app, /downloadUpdate\(\)/);
  assert.match(preload, /updateStatus: \(\) => ipcRenderer\.invoke\("update:status"\)/);
  assert.match(main, /ipcMain\.handle\("update:install"/);
  assert.doesNotMatch(preload, /userDataPath|executablePath|InstallDirectory/);
});


// Updating should not cost disk that is never given back.
//
// It did. Every Windows update wrote a full package into userData/updates and
// nothing ever deleted one, so a person who had updated five times was sitting
// on five finished downloads — in a folder under AppData that nobody browses to
// by accident, which is why it read as "the app is just enormous" rather than
// as a leak.

const fakeUpdates = async (root, versions) => {
  for (const [version, bytes] of Object.entries(versions)) {
    const directory = path.join(root, "updates", version);
    await fs.mkdir(path.join(directory, "staged"), { recursive: true });
    await fs.writeFile(path.join(directory, `Evolv-win32-x64-${version}.zip`), randomBytes(bytes));
    await fs.writeFile(path.join(directory, "staged", "Evolv.exe"), randomBytes(bytes));
  }
};

const service = (root, options = {}) => new DesktopUpdateService({
  currentVersion: "0.7.0",
  userDataPath: root,
  executablePath: path.join(root, "install", "Evolv.exe"),
  platform: "win32",
  ...options
});

test("the updater can say how much disk it is holding, and give it back", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-updates-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fakeUpdates(root, { "0.6.1": 40_000, "0.6.2": 50_000, "0.7.0": 60_000 });

  const updater = service(root);
  const before = await updater.holdings();
  assert.ok(before.bytes >= 300_000, `expected all six files counted, got ${before.bytes}`);
  assert.deepEqual(before.versions.map((entry) => entry.version), ["0.7.0", "0.6.2", "0.6.1"],
    "newest first, so the list reads the way a person would ask the question");

  const freed = await updater.reclaim();
  assert.ok(freed.freedBytes >= 300_000, `expected the space back, freed ${freed.freedBytes}`);
  assert.equal(freed.heldBytes, 0);
  assert.deepEqual((await updater.holdings()).versions, []);
});

test("reclaiming keeps the update that is being installed right now", async (t) => {
  // Deleting the package mid-install would break the very thing it was clearing
  // space for.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-updates-keep-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fakeUpdates(root, { "0.6.1": 20_000, "0.7.1": 30_000 });
  await fs.writeFile(path.join(root, "updates", "apply-evolv-update.ps1"), "# the swap script");

  const updater = service(root);
  await updater.reclaim({ keep: ["0.7.1"] });
  const held = await updater.holdings();
  assert.deepEqual(held.versions.map((entry) => entry.version), ["0.7.1"]);
  // And the script that performs the swap survives, because an install already
  // under way is running it.
  await fs.access(path.join(root, "updates", "apply-evolv-update.ps1"));
});

test("starting up clears what the last update left behind", async (t) => {
  // Reaching this point is proof the installed version works, which is exactly
  // when the package it came from and the copy of the old install stop being
  // insurance. main.mjs already reasoned this way about the previous AppImage
  // on Linux; Windows kept everything.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-updates-boot-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fakeUpdates(root, { "0.6.9": 25_000, "0.7.0": 25_000 });
  const installDir = path.join(root, "install");
  await fs.mkdir(path.join(`${installDir}.previous`, "resources"), { recursive: true });
  await fs.writeFile(path.join(`${installDir}.previous`, "Evolv.exe"), randomBytes(70_000));

  const updater = service(root);
  const freed = await updater.cleanupAfterStart();
  assert.ok(freed.freedBytes >= 170_000, `expected packages and the old install back, got ${freed.freedBytes}`);
  assert.equal(freed.heldBytes, 0);
  await assert.rejects(() => fs.access(`${installDir}.previous`), "the old install is gone");
});

test("an update is refused before it fills the disk, not partway through", async (t) => {
  // Running out of room halfway leaves the disk full *and* the update
  // unfinished, which is the worst of both — and is how someone ends up with no
  // space and no idea what took it.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-updates-room-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const updater = service(root);
  updater.release = { version: "0.7.1", zip: { size: 200 * 1024 ** 2 } };
  // Pretend the disk has 100 MB left against a 200 MB download that unpacks.
  const originalStatfs = fs.statfs;
  t.after(() => { fs.statfs = originalStatfs; });
  fs.statfs = async () => ({ bavail: 100, bsize: 1024 ** 2 });
  await assert.rejects(() => updater.requireRoom(root), (error) => {
    assert.match(error.message, /Not enough room/);
    // The figures, not just the verdict: what is needed, what is free, and why
    // it is more than the download.
    assert.match(error.message, /700 MB is needed/);
    assert.match(error.message, /100 MB is free/);
    assert.match(error.message, /unpacks to about 500 MB/);
    return true;
  });

  // With room, it says nothing and gets out of the way.
  fs.statfs = async () => ({ bavail: 4_000, bsize: 1024 ** 2 });
  assert.ok(await updater.requireRoom(root));

  // And a platform that cannot answer is not a reason to stop someone updating.
  fs.statfs = async () => { throw new Error("statfs is not supported here"); };
  assert.equal(await updater.requireRoom(root), null);
});

test("sizes are written the way a person would say them", () => {
  assert.equal(formatBytes(250 * 1024 ** 2), "250 MB");
  assert.equal(formatBytes(1.5 * 1024 ** 3), "1.5 GB");
  assert.equal(formatBytes(4096), "4 KB");
  assert.equal(formatBytes(0), "0 bytes");
});

test("the space it is holding is only claimed when it was actually looked up", async (t) => {
  // status() answers without touching the disk, because check() and download()
  // call it constantly and walking a folder each time would be silly. So the
  // figure is null rather than zero when nobody measured — the two mean
  // different things, and the page reading one as the other would hide the
  // button every time someone pressed Check.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolv-updates-held-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fakeUpdates(root, { "0.6.4": 30_000 });

  const updater = service(root);
  assert.equal(updater.status().heldBytes, null, "not measured is not the same as nothing");
  const measured = updater.status(await updater.holdings());
  assert.ok(measured.heldBytes >= 60_000, `expected a real figure, got ${measured.heldBytes}`);

  const page = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(page, /status\.heldBytes !== null/, "the page has to tell the two apart");
});
