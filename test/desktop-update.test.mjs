import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { buildBlockMap } from "../lib/block-delta.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareVersions, DEFAULT_UPDATE_REPOSITORY, DesktopUpdateService, normalizeVersion, selectRelease } from "../electron/update-service.mjs";

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
  assert.equal((await fs.stat(appImagePath)).mode & 0o111, 0o111, "and it is still executable");
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
