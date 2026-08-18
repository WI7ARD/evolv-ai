import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareVersions, DesktopUpdateService, normalizeVersion, selectRelease } from "../electron/update-service.mjs";

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
