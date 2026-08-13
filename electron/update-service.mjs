import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { EVOLV_REPOSITORY } from "../lib/version.mjs";

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

export function selectRelease(payload, currentVersion) {
  if (!payload || payload.draft || payload.prerelease) throw new Error("No stable GitHub release is available.");
  const version = normalizeVersion(payload.tag_name);
  const available = compareVersions(version, currentVersion) > 0;
  const zipName = `Evolv-win32-x64-${version}.zip`;
  const checksumName = `${zipName}.sha256`;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const zip = assets.find((asset) => asset?.name === zipName);
  const checksum = assets.find((asset) => asset?.name === checksumName);
  if (available && (!zip?.browser_download_url || !checksum?.browser_download_url)) {
    throw new Error(`GitHub release ${version} is missing its ZIP or SHA-256 file.`);
  }
  return {
    available,
    version,
    name: String(payload.name || `Evolv ${version}`).slice(0, 160),
    notes: String(payload.body || "").slice(0, 8_000),
    pageUrl: String(payload.html_url || ""),
    zip: zip ? { name: zipName, url: zip.browser_download_url } : null,
    checksum: checksum ? { name: checksumName, url: checksum.browser_download_url } : null
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
    this.pid = pid;
    this.release = null;
    this.staged = null;
    this.phase = "idle";
    this.error = "";
  }

  status() {
    return {
      supported: this.platform === "win32",
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

  async trustedFetch(value, { api = false } = {}) {
    let url = validateUpdateUrl(value, { api });
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await this.fetchImpl(url, {
        redirect: "manual",
        headers: { "user-agent": `Evolv/${this.currentVersion}`, accept: api ? "application/vnd.github+json" : "application/octet-stream" }
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
    if (this.platform !== "win32") return this.status();
    this.phase = "checking";
    this.error = "";
    try {
      const response = await this.trustedFetch(`https://api.github.com/repos/${this.repository}/releases/latest`, { api: true });
      const payload = await response.json();
      this.release = selectRelease(payload, this.currentVersion);
      this.phase = this.release.available ? "available" : "current";
    } catch (error) {
      this.phase = "error";
      this.error = error.message;
    }
    return this.status();
  }

  async download() {
    if (this.platform !== "win32") throw new Error("Automatic installation is currently available on Windows only.");
    if (!this.release?.available) await this.check();
    if (!this.release?.available || !this.release.zip || !this.release.checksum) {
      throw new Error(this.error || "No newer release is available.");
    }
    this.phase = "downloading";
    this.error = "";
    try {
      const updateRoot = path.join(this.userDataPath, "updates", this.release.version);
      const zipPath = path.join(updateRoot, this.release.zip.name);
      const stagingRoot = path.join(updateRoot, "staged");
      await fs.mkdir(updateRoot, { recursive: true });
      const checksumResponse = await this.trustedFetch(this.release.checksum.url);
      const checksumText = await checksumResponse.text();
      if (checksumText.length > 1_024) throw new Error("The update checksum file is oversized.");
      const expected = checksumText.match(/\b[a-fA-F0-9]{64}\b/)?.[0]?.toLowerCase();
      if (!expected) throw new Error("The update checksum file is invalid.");

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
      this.staged = { sourceDir, zipPath, version: this.release.version, expected };
      this.phase = "ready";
      return this.status();
    } catch (error) {
      this.phase = "error";
      this.error = error.message;
      throw error;
    }
  }

  async prepareInstall() {
    if (!this.staged) throw new Error("Download and verify the update first.");
    if (this.platform !== "win32") throw new Error("Automatic installation is currently available on Windows only.");
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
