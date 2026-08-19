import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { EVOLV_REPOSITORY } from "../lib/version.mjs";
import { applyUpdate, parseBlockMap, planUpdate } from "../lib/block-delta.mjs";

// Read from package.json rather than written here, so the updater and the
// release workflow cannot point at different repositories again. The fallback
// only matters if the manifest is unreadable, which is a packaging accident.
export const DEFAULT_UPDATE_REPOSITORY = EVOLV_REPOSITORY || "WI7ARD/evolv-ai";
const MAX_UPDATE_BYTES = 2 * 1024 ** 3;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const TRUSTED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com"
]);
const execFileAsync = promisify(execFile);

async function extractWindowsZip(zipPath, { dir }) {
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }",
    zipPath, dir
  ], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
}

export function normalizeVersion(value) {
  const match = String(value || "").trim().match(VERSION_PATTERN);
  if (!match) throw new Error("The release version is not valid semantic versioning.");
  return match.slice(1).map(Number).join(".");
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left).split(".").map(Number);
  const b = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

// What each platform ships. Windows gets a portable ZIP that replaces a folder;
// Linux gets a single AppImage file, plus the block map that lets an installed
// copy rebuild it from the parts that changed instead of downloading 300 MB.
export function releaseAssetNames(version, platform = "win32") {
  return platform === "linux"
    ? { package: `Evolv-${version}-x86_64.AppImage`, blocks: `Evolv-${version}-x86_64.AppImage.blocks` }
    : { package: `Evolv-win32-x64-${version}.zip`, blocks: "" };
}

export function selectRelease(payload, currentVersion, platform = "win32") {
  if (!payload || payload.draft || payload.prerelease) throw new Error("No stable GitHub release is available.");
  const version = normalizeVersion(payload.tag_name);
  const available = compareVersions(version, currentVersion) > 0;
  const names = releaseAssetNames(version, platform);
  const checksumName = `${names.package}.sha256`;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const find = (name) => (name ? assets.find((asset) => asset?.name === name) : null);
  const zip = find(names.package);
  const checksum = find(checksumName);
  const blocks = find(names.blocks);
  if (available && (!zip?.browser_download_url || !checksum?.browser_download_url)) {
    throw new Error(`GitHub release ${version} is missing its ${platform === "linux" ? "AppImage" : "ZIP"} or SHA-256 file.`);
  }
  return {
    available,
    version,
    name: String(payload.name || `Evolv ${version}`).slice(0, 160),
    // What the download will cost, from the release rather than from a header
    // partway through it. Known before anything is written, which is the only
    // moment refusing to start is still free.
    downloadBytes: Number(zip?.size) || 0,
    notes: String(payload.body || "").slice(0, 8_000),
    pageUrl: String(payload.html_url || ""),
    zip: zip ? { name: names.package, url: zip.browser_download_url, size: Number(zip.size) || 0 } : null,
    checksum: checksum ? { name: checksumName, url: checksum.browser_download_url } : null,
    // Absent only means a full download; the update still works.
    blocks: blocks?.browser_download_url ? { name: names.blocks, url: blocks.browser_download_url } : null
  };
}

function validateRepository(value) {
  const repository = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new Error("The GitHub update repository is invalid.");
  }
  return repository;
}

function validateUpdateUrl(value, { api = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("The update URL is not trusted.");
  if (api ? url.hostname !== "api.github.com" : !TRUSTED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error("The update host is not trusted.");
  }
  return url;
}

// How much room is left where the update will be written.
//
// Returned rather than assumed, because the whole reason this exists is people
// running out of it. `statfs` is not on every platform Node runs on; when it is
// missing the answer is "unknown", and an unknown does not block an update — it
// only stops the check being able to warn first.
async function availableBytes(directory) {
  try {
    const stats = await fs.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

// What a directory holds, following it all the way down. Used to say how much
// the updater is sitting on, which is a number nobody can find out otherwise.
async function directorySize(directory) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
      continue;
    }
    try {
      total += (await fs.stat(full)).size;
    } catch { /* it went away underneath us, which is fine */ }
  }
  return total;
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export class DesktopUpdateService {
  constructor({
    currentVersion,
    userDataPath,
    executablePath,
    repository = process.env.EVOLV_UPDATE_REPOSITORY || DEFAULT_UPDATE_REPOSITORY,
    fetchImpl = globalThis.fetch,
    extractImpl = extractWindowsZip,
    spawnImpl = spawn,
    platform = process.platform,
    // Set by the AppImage runtime to the path of the running image. Its absence
    // on Linux means Evolv was started some other way — unpacked, or from
    // source — and replacing a file nobody installed is not the updater's call.
    appImagePath = process.env.APPIMAGE || "",
    pid = process.pid
  }) {
    this.currentVersion = normalizeVersion(currentVersion);
    this.userDataPath = path.resolve(userDataPath);
    this.executablePath = path.resolve(executablePath);
    this.installDir = path.dirname(this.executablePath);
    this.repository = validateRepository(repository);
    this.fetchImpl = fetchImpl;
    this.extractImpl = extractImpl;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.appImagePath = appImagePath ? path.resolve(appImagePath) : "";
    this.pid = pid;
    this.savings = null;
    this.release = null;
    this.staged = null;
    this.phase = "idle";
    this.error = "";
  }

  get updatesRoot() {
    return path.join(this.userDataPath, "updates");
  }

  // What the updater is sitting on, and which versions it belongs to.
  //
  // Nothing else can answer this. The folder lives under userData, which on
  // Windows is a path inside AppData that nobody browses to by accident, so
  // several hundred megabytes of finished downloads can sit there for months
  // looking, from outside, like the app is simply large.
  async holdings() {
    let entries = [];
    try {
      entries = await fs.readdir(this.updatesRoot, { withFileTypes: true });
    } catch {
      return { bytes: 0, versions: [] };
    }
    const versions = [];
    let bytes = 0;
    for (const entry of entries) {
      const full = path.join(this.updatesRoot, entry.name);
      const size = entry.isDirectory() ? await directorySize(full) : await fs.stat(full).then((stat) => stat.size).catch(() => 0);
      bytes += size;
      if (entry.isDirectory() && VERSION_PATTERN.test(entry.name)) versions.push({ version: entry.name, bytes: size });
    }
    return { bytes, versions: versions.sort((left, right) => compareVersions(right.version, left.version)) };
  }

  // Throw away every staged update except the ones named.
  //
  // A finished update has no further use for the package it came from: the
  // files are in the install directory now. Keeping it was not a decision, it
  // was an omission — nothing ever deleted anything, so every update a person
  // ever installed was still on their disk, one full copy each.
  async reclaim({ keep = [] } = {}) {
    const before = await this.holdings();
    const kept = new Set(keep.filter(Boolean).map((version) => normalizeVersion(version)));
    let entries = [];
    try {
      entries = await fs.readdir(this.updatesRoot, { withFileTypes: true });
    } catch {
      return { freedBytes: 0, heldBytes: 0 };
    }
    for (const entry of entries) {
      // The apply script is tiny and is rewritten each time; leaving it costs
      // nothing and deleting it mid-update would be the one way to break an
      // install that is already under way.
      if (entry.name === "apply-evolv-update.ps1") continue;
      if (entry.isDirectory() && kept.has(entry.name)) continue;
      await fs.rm(path.join(this.updatesRoot, entry.name), { recursive: true, force: true });
    }
    const after = await this.holdings();
    return { freedBytes: Math.max(0, before.bytes - after.bytes), heldBytes: after.bytes };
  }

  // Called once the app has started, which is proof the version now installed
  // works — and therefore that everything staged to produce it is spent.
  //
  // The same reasoning main.mjs already applied to the previous AppImage on
  // Linux, applied to the two things Windows leaves behind: the downloaded
  // package, and the copy of the old install the swap script renamed aside.
  async cleanupAfterStart() {
    const freed = await this.reclaim({ keep: [] });
    let previousInstall = 0;
    if (this.platform === "win32") {
      const previous = `${this.installDir}.previous`;
      previousInstall = await directorySize(previous);
      if (previousInstall > 0) await fs.rm(previous, { recursive: true, force: true }).catch(() => {});
    }
    if (this.platform === "linux" && this.appImagePath) {
      const previous = `${this.appImagePath}.previous`;
      previousInstall = await fs.stat(previous).then((stat) => stat.size).catch(() => 0);
      if (previousInstall > 0) await fs.rm(previous, { force: true }).catch(() => {});
    }
    return { freedBytes: freed.freedBytes + previousInstall, heldBytes: freed.heldBytes };
  }

  supported() {
    if (this.platform === "win32") return true;
    // Linux updates replace the running AppImage. Anything else was installed
    // by a package manager or run from source, and owns its own updates.
    return this.platform === "linux" && Boolean(this.appImagePath);
  }

  status(holdings = null) {
    return {
      supported: this.supported(),
      // How much disk the updater is holding, when the caller has looked it up.
      // Null rather than zero when it has not, because "nothing" and "not
      // measured" are different things to put in front of someone.
      heldBytes: holdings ? holdings.bytes : null,
      // How much of the download the block map saved, once one is planned.
      savings: this.savings,
      currentVersion: this.currentVersion,
      repository: this.repository,
      phase: this.phase,
      error: this.error,
      release: this.release ? {
        available: this.release.available,
        version: this.release.version,
        name: this.release.name,
        notes: this.release.notes,
        pageUrl: this.release.pageUrl
      } : null,
      readyToInstall: Boolean(this.staged)
    };
  }

  async trustedFetch(value, { api = false, range = null } = {}) {
    let url = validateUpdateUrl(value, { api });
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await this.fetchImpl(url, {
        redirect: "manual",
        headers: {
          "user-agent": `Evolv/${this.currentVersion}`,
          accept: api ? "application/vnd.github+json" : "application/octet-stream",
          ...(range ? { range: `bytes=${range.start}-${range.end}` } : {})
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === 5) throw new Error("The update download redirected too many times.");
        const location = response.headers.get("location");
        if (!location) throw new Error("The update redirect was malformed.");
        url = validateUpdateUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw new Error(`GitHub update request failed (${response.status}).`);
      return response;
    }
    throw new Error("The update request could not be completed.");
  }

  async check() {
    if (!this.supported()) return this.status();
    this.phase = "checking";
    this.error = "";
    try {
      const response = await this.trustedFetch(`https://api.github.com/repos/${this.repository}/releases/latest`, { api: true });
      const payload = await response.json();
      this.release = selectRelease(payload, this.currentVersion, this.platform);
      this.phase = this.release.available ? "available" : "current";
    } catch (error) {
      this.phase = "error";
      this.error = error.message;
    }
    return this.status();
  }

  // The published SHA-256 is the anchor for everything that follows: on Linux
  // the block map has to agree with it before a single byte is reused.
  async expectedChecksum() {
    const checksumResponse = await this.trustedFetch(this.release.checksum.url);
    const checksumText = await checksumResponse.text();
    if (checksumText.length > 1_024) throw new Error("The update checksum file is oversized.");
    const expected = checksumText.match(/\b[a-fA-F0-9]{64}\b/)?.[0]?.toLowerCase();
    if (!expected) throw new Error("The update checksum file is invalid.");
    return expected;
  }

  // Rebuilds the new AppImage out of the one already installed plus the parts
  // that differ. Most of the image is Electron and does not change between
  // releases, so this is usually a few megabytes instead of three hundred.
  async stageAppImage(updateRoot, expected) {
    const target = path.join(updateRoot, this.release.zip.name);
    let plan = null;
    if (this.release.blocks) {
      const mapResponse = await this.trustedFetch(this.release.blocks.url);
      const map = parseBlockMap(Buffer.from(await mapResponse.arrayBuffer()));
      // A block map that describes some other file would direct the assembly
      // to build that file instead, and it would pass its own hash check.
      if (map.sha256 !== expected) throw new Error("The block map does not describe the published release.");
      plan = await planUpdate(this.appImagePath, map);
    }

    if (plan) {
      const result = await applyUpdate({
        localPath: this.appImagePath,
        outputPath: target,
        plan,
        fetchRange: async (start, end) => {
          const response = await this.trustedFetch(this.release.zip.url, { range: { start, end } });
          // A server that ignores the range returns the whole file with 200,
          // which would be assembled into nonsense.
          if (response.status !== 206) throw new Error("The update server did not honour a byte range request.");
          return Buffer.from(await response.arrayBuffer());
        }
      });
      this.savings = { fetchedBytes: result.fetchBytes, reusedBytes: result.reusedBytes, totalBytes: plan.length };
    } else {
      // No block map, or nothing installed to reuse: an ordinary download.
      const response = await this.trustedFetch(this.release.zip.url);
      if (!response.body) throw new Error("The update package had no body.");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: "w" }));
      const actual = await sha256File(target);
      if (actual !== expected) {
        await fs.rm(target, { force: true });
        throw new Error("The downloaded update failed SHA-256 verification.");
      }
      const { size } = await fs.stat(target);
      this.savings = { fetchedBytes: size, reusedBytes: 0, totalBytes: size };
    }

    await fs.chmod(target, 0o755);
    this.staged = { sourceDir: "", zipPath: target, packagePath: target, version: this.release.version, expected };
  }

  // Refuse before filling the disk rather than partway through it.
  //
  // A download that runs out of room halfway leaves the disk full *and* the
  // update unfinished, which is the worst of both and is how someone ends up
  // with no space and no idea why. The package is unpacked as well as
  // downloaded, so the room needed is several times the file: about two and a
  // half for the unpacked tree, plus the package itself while it is verified.
  async requireRoom(directory) {
    const download = Number(this.release?.zip?.size) || 0;
    if (!download) return null;
    const needed = Math.round(download * 3.5);
    const free = await availableBytes(directory);
    // Unknown is not a refusal. A platform whose free space cannot be read is
    // not a reason to stop someone updating.
    if (free === null) return null;
    if (free < needed) {
      throw new Error(
        `Not enough room to update: ${formatBytes(needed)} is needed and ${formatBytes(free)} is free. ` +
        `The update unpacks to about ${formatBytes(download * 2.5)} on top of the ${formatBytes(download)} download.`
      );
    }
    return { needed, free };
  }

  async download() {
    if (!this.supported()) throw new Error("Automatic installation is not available on this platform.");
    if (!this.release?.available) await this.check();
    if (!this.release?.available || !this.release.zip || !this.release.checksum) {
      throw new Error(this.error || "No newer release is available.");
    }
    this.phase = "downloading";
    this.error = "";
    try {
      // Anything left from an earlier update is spent, and clearing it first
      // may be the very thing that makes room for this one.
      await this.reclaim({ keep: [this.release.version] });
      const updateRoot = path.join(this.updatesRoot, this.release.version);
      await fs.mkdir(updateRoot, { recursive: true });
      await this.requireRoom(updateRoot);
      const expected = await this.expectedChecksum();
      if (this.platform === "linux") {
        await this.stageAppImage(updateRoot, expected);
        this.phase = "ready";
        return this.status();
      }
      const zipPath = path.join(updateRoot, this.release.zip.name);
      const stagingRoot = path.join(updateRoot, "staged");

      const zipResponse = await this.trustedFetch(this.release.zip.url);
      const length = Number(zipResponse.headers.get("content-length") || 0);
      if (length && (length < 1 || length > MAX_UPDATE_BYTES)) throw new Error("The update package size is invalid.");
      if (!zipResponse.body) throw new Error("The update package had no body.");
      await pipeline(Readable.fromWeb(zipResponse.body), createWriteStream(zipPath, { flags: "w" }));
      const actual = await sha256File(zipPath);
      if (actual !== expected) {
        await fs.rm(zipPath, { force: true });
        throw new Error("The downloaded update failed SHA-256 verification.");
      }

      await fs.rm(stagingRoot, { recursive: true, force: true });
      await fs.mkdir(stagingRoot, { recursive: true });
      await this.extractImpl(zipPath, { dir: stagingRoot });
      const wrappedSource = path.join(stagingRoot, "Evolv-win32-x64");
      const sourceDir = await fs.access(path.join(wrappedSource, "Evolv.exe")).then(() => wrappedSource).catch(() => stagingRoot);
      for (const required of ["Evolv.exe", path.join("resources", "app.asar"), "release-integrity.json"]) {
        const target = path.resolve(sourceDir, required);
        if (!target.startsWith(`${path.resolve(sourceDir)}${path.sep}`)) throw new Error("The staged update escaped its folder.");
        await fs.access(target);
      }
      const integrity = JSON.parse(await fs.readFile(path.join(sourceDir, "release-integrity.json"), "utf8"));
      if (integrity.schemaVersion !== 1 || normalizeVersion(integrity.version) !== this.release.version) {
        throw new Error("The staged update integrity manifest has the wrong version.");
      }
      for (const [relative, expectedFileHash] of Object.entries({
        "Evolv.exe": integrity.files?.["Evolv.exe"],
        "resources/app.asar": integrity.files?.["resources/app.asar"]
      })) {
        if (!/^[a-f0-9]{64}$/i.test(expectedFileHash || "")) throw new Error("The staged update integrity manifest is invalid.");
        const actualFileHash = await sha256File(path.join(sourceDir, ...relative.split("/")));
        if (actualFileHash !== expectedFileHash.toLowerCase()) throw new Error(`The staged ${relative} failed integrity verification.`);
      }
      // The package has done its job: the files are unpacked and every one of
      // them has been checked against the published manifest. Holding a second
      // compressed copy of what is already sitting beside it, until the install
      // happens and forever after, is what filled people's disks.
      await fs.rm(zipPath, { force: true }).catch(() => {});
      this.staged = { sourceDir, zipPath: "", version: this.release.version, expected };
      this.phase = "ready";
      return this.status();
    } catch (error) {
      this.phase = "error";
      this.error = error.message;
      throw error;
    }
  }

  // Replacing a single file, which is the whole reason AppImages are pleasant
  // to update. The copy lands beside the target first so the rename that swaps
  // it in is atomic and on the same filesystem — userData is usually not.
  async installAppImage() {
    const target = this.appImagePath;
    await fs.access(path.dirname(target), constants.W_OK);
    const staging = `${target}.new`;
    const previous = `${target}.previous`;
    await fs.copyFile(this.staged.packagePath, staging);
    await fs.chmod(staging, 0o755);
    // Verified once more where it will actually run: a copy onto a full disk
    // can truncate, and this is the last moment it costs nothing to notice.
    if (await sha256File(staging) !== this.staged.expected) {
      await fs.rm(staging, { force: true });
      throw new Error("The staged AppImage failed verification after copying.");
    }
    await fs.rm(previous, { force: true });
    await fs.rename(target, previous);
    await fs.rename(staging, target);
    const child = this.spawnImpl(target, [], { detached: true, stdio: "ignore" });
    child.unref?.();
    this.phase = "installing";
    return { ...this.status(), willRestart: true };
  }

  async prepareInstall() {
    if (!this.staged) throw new Error("Download and verify the update first.");
    if (this.platform === "linux") return this.installAppImage();
    if (this.platform !== "win32") throw new Error("Automatic installation is not available on this platform.");
    await fs.access(this.installDir, constants.W_OK);
    const scriptPath = path.join(this.userDataPath, "updates", "apply-evolv-update.ps1");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, `param(
  [int]$EvolvProcessId,
  [string]$SourceDirectory,
  [string]$InstallDirectory
)
$ErrorActionPreference = "Stop"
$backup = "$InstallDirectory.previous"
try { Wait-Process -Id $EvolvProcessId -Timeout 45 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 700
try {
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  Move-Item -LiteralPath $InstallDirectory -Destination $backup
  Move-Item -LiteralPath $SourceDirectory -Destination $InstallDirectory
  $next = Start-Process -FilePath (Join-Path $InstallDirectory "Evolv.exe") -PassThru
  Start-Sleep -Seconds 4
  if ($next.HasExited) { throw "The updated Evolv process exited during startup." }
  Remove-Item -LiteralPath $backup -Recurse -Force
} catch {
  if (Test-Path -LiteralPath $InstallDirectory) { Remove-Item -LiteralPath $InstallDirectory -Recurse -Force }
  if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $InstallDirectory }
  if (Test-Path -LiteralPath (Join-Path $InstallDirectory "Evolv.exe")) { Start-Process -FilePath (Join-Path $InstallDirectory "Evolv.exe") }
  exit 1
}
`, "utf8");
    const child = this.spawnImpl("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-EvolvProcessId", String(this.pid), "-SourceDirectory", this.staged.sourceDir, "-InstallDirectory", this.installDir
    ], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref?.();
    this.phase = "installing";
    return { ...this.status(), willRestart: true };
  }
}
