// Builds the Windows ZIP or Linux Mint-compatible tarball for Evolv.
//
// electron-forge's `make` cannot run in this toolchain: @electron/rebuild tries
// to compile better-sqlite3 from C++ source (Visual Studio Build Tools are not
// installed) rather than using the published prebuilt binary, and on Node >=24
// forge swallows that failure silently. This script does what forge's package +
// zip maker would, but obtains the matching Electron-ABI better_sqlite3.node
// from its prebuilt release (no compiler required), so it works on a clean
// machine. Run with: npm run dist:win or, on Linux Mint, npm run dist:linux
import { packager } from "@electron/packager";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrySync } from "./lib/retry.mjs";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = require(path.join(root, "package.json"));
const electronVersion = require("electron/package.json").version;
const outDir = process.env.EVOLV_OUT_DIR ? path.resolve(process.env.EVOLV_OUT_DIR) : path.join(root, "out");
const arch = "x64";
const platformArgument = process.argv.find((argument) => argument.startsWith("--platform="));
const platform = platformArgument?.split("=")[1] || "win32";
if (!["win32", "linux"].includes(platform)) {
  throw new Error("Supported release platforms are win32 and linux.");
}
if (platform === "linux" && process.platform !== "linux") {
  throw new Error(
    "Build the Linux Mint release on Linux so native modules and executable permissions are correct. "
    + "Run npm install && npm run dist:linux on Linux Mint."
  );
}
const electronZipName = `electron-v${electronVersion}-${platform}-${arch}.zip`;

console.log(`Evolv ${pkg.version} → Electron ${electronVersion} (${platform}/${arch})`);

function findFileRecursive(directory, fileName) {
  if (!directory || !fs.existsSync(directory)) return null;
  const pending = [path.resolve(directory)];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === fileName) return candidate;
    }
  }
  return null;
}

function findElectronZipDirectory() {
  const override = process.env.ELECTRON_ZIP_DIR?.trim();
  if (override) {
    const zipPath = path.join(path.resolve(override), electronZipName);
    if (!fs.existsSync(zipPath)) {
      throw new Error(`ELECTRON_ZIP_DIR does not contain ${electronZipName}: ${override}`);
    }
    return path.dirname(zipPath);
  }

  const cacheRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "electron", "Cache"),
    process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, "electron"),
    process.env.HOME && path.join(process.env.HOME, ".cache", "electron")
  ].filter(Boolean);
  for (const cacheRoot of cacheRoots) {
    const zipPath = findFileRecursive(cacheRoot, electronZipName);
    if (zipPath) return path.dirname(zipPath);
  }
  return null;
}

const electronZipDir = findElectronZipDirectory();
if (electronZipDir) console.log(`Using cached Electron archive: ${path.join(electronZipDir, electronZipName)}`);
else console.log("No matching Electron archive was cached; the packager will download it.");

function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function getRuntimePackageRoots() {
  const installOnly = new Set(["prebuild-install"]);
  const queue = Object.keys(pkg.dependencies || {});
  const visited = new Set();
  const roots = [];
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name) || installOnly.has(name)) continue;
    visited.add(name);
    const packageJsonPath = path.join(root, "node_modules", ...name.split("/"), "package.json");
    if (!fs.existsSync(packageJsonPath)) throw new Error(`Runtime dependency is missing: ${name}`);
    const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    roots.push(normalizePath(path.dirname(packageJsonPath)));
    queue.push(...Object.keys(metadata.dependencies || {}));
  }
  return roots;
}

const runtimePackageRoots = getRuntimePackageRoots();

// Ensure the application icon exists (generated, not compiled in from a binary).
const requiredIcon = platform === "win32" ? "icon.ico" : "icon.png";
if (!fs.existsSync(path.join(root, "build", requiredIcon))) {
  console.log("Generating application icon…");
  spawnSync(process.execPath, [path.join(root, "scripts", "make-icon.mjs")], { stdio: "inherit" });
}

// 1) Fetch the Electron-ABI better_sqlite3.node prebuilt binary into a scratch
//    copy (the installed one is Node-ABI and may be locked while in use).
const stageRoot = path.resolve(os.tmpdir(), "evolv-bs3-prebuild");
const resolvedTemp = path.resolve(os.tmpdir());
if (!stageRoot.startsWith(`${resolvedTemp}${path.sep}`)) {
  throw new Error("Unsafe native-module staging path.");
}
const stage = path.join(stageRoot, "better-sqlite3");
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.cpSync(path.join(root, "node_modules", "better-sqlite3"), stage, { recursive: true });
fs.rmSync(path.join(stage, "build", "Release", "better_sqlite3.node"), { force: true });
console.log("Downloading Electron-ABI better-sqlite3 prebuild…");
const electronBinary = path.join(stage, "build", "Release", "better_sqlite3.node");

// prebuild-install has no retry of its own, and a socket hang up here used to
// print "pin electron to a version with a published prebuild" — advice that
// sends you looking for a version problem when the network simply dropped.
// Output is captured rather than inherited so the two cases can be told apart:
// no published binary is an answer and is not worth repeating, while anything
// else is worth another attempt.
const missing = /no prebuilt binaries found/i;
let output = "";

function downloadPrebuild() {
  const prebuild = spawnSync(process.execPath, [
    require.resolve("prebuild-install/bin.js"),
    "--runtime", "electron", "--target", electronVersion, "--arch", arch, "--platform", platform
  ], { cwd: stage, encoding: "utf8" });
  output = `${prebuild.stdout || ""}${prebuild.stderr || ""}`.trim();
  if (output) console.log(output);
  if (prebuild.status !== 0 || !fs.existsSync(electronBinary)) {
    throw new Error(output.split("\n").pop() || `prebuild-install exited ${prebuild.status}`);
  }
}

try {
  retrySync(downloadPrebuild, {
    label: "The better-sqlite3 prebuild download",
    retryable: () => !missing.test(output)
  });
} catch {
  if (missing.test(output)) {
    console.error(`\nNo prebuilt better-sqlite3 for Electron ${electronVersion}. Pin electron to a version`);
    console.error("with a published prebuild (see README) or install a C++ toolchain to compile from source.");
  } else {
    console.error(`\nCould not download the better-sqlite3 prebuild for Electron ${electronVersion}.`);
    console.error("The prebuild exists; the download failed. This is a network failure, so re-running should fix it.");
  }
  process.exit(1);
}

// Package only runtime source and production dependencies. This prevents local
// metadata, tests, release material, build tools, and unrelated dependencies
// from leaking into app.asar.
function shouldIgnore(candidate) {
  const p = candidate.replace(/\\/g, "/");
  if (!p) return false;
  const lower = p.toLowerCase();
  if (lower === "/server.mjs" || lower === "/package.json") return false;
  if (platform === "linux") {
    if (lower === "/electron/windows-speech.ps1") return true;
    if (/^\/electron\/voice-assets\/piper\/piper(?:\/|$)/.test(lower)) return true;
    if (/^\/electron\/voice-assets\/whisper\/release(?:\/|$)/.test(lower)) return true;
  }
  if (/^\/(?:electron|lib|public|packs|server)(?:\/|$)/.test(lower)) return false;
  if (lower === "/node_modules" || lower.startsWith("/node_modules/")) {
    const absolute = normalizePath(path.join(root, p.slice(1)));
    const required = runtimePackageRoots.some((packageRoot) =>
      absolute === packageRoot
      || absolute.startsWith(`${packageRoot}/`)
      || packageRoot.startsWith(`${absolute}/`)
    );
    if (!required) return true;
    if (/\/(?:\.github|docs?|examples?|src|deps|test|tests)(?:\/|$)/.test(lower)) return true;
    if (/\.(?:c|cc|cpp|d\.ts|gyp|gypi|h|hpp|map|md|markdown|sh)$/.test(lower)) return true;
    if (/\/\.(?:forge-meta|npmignore|travis\.yml)$/.test(lower)) return true;
    return false;
  }
  return true;
}

// 2) Package the app. Native modules are kept out of the asar so the binary can
//    be swapped and loaded at runtime.
console.log("Packaging application…");
const [appPath] = await packager({
  dir: root,
  out: outDir,
  platform,
  arch,
  overwrite: true,
  asar: { unpack: "**/*.{node,ps1}", unpackDir: "electron/voice-assets" },
  executableName: "Evolv",
  icon: path.join(root, "build", "icon"),
  ignore: shouldIgnore,
  electronVersion,
  ...(electronZipDir ? { electronZipDir } : {}),
  quiet: true
});

// 3) Replace the Node-ABI binary the packager copied with the Electron-ABI one.
const packagedBinary = path.join(appPath, "resources", "app.asar.unpacked", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
if (!fs.existsSync(packagedBinary)) {
  console.error(`Expected unpacked native module missing: ${packagedBinary}`);
  process.exit(1);
}
fs.copyFileSync(electronBinary, packagedBinary);
console.log("Swapped in Electron-ABI better_sqlite3.node");

// 4) Ship the platform-specific itch.io manifest next to the executable.
const itchManifest = platform === "linux" ? ".itch-linux.toml" : ".itch.toml";
fs.copyFileSync(path.join(root, itchManifest), path.join(appPath, ".itch.toml"));
if (platform === "linux") {
  const executable = path.join(appPath, "Evolv");
  fs.chmodSync(executable, 0o755);
  fs.copyFileSync(path.join(root, "LINUX-MINT.md"), path.join(appPath, "README-LINUX-MINT.md"));
  execFileSync(process.execPath, [path.join(root, "scripts", "validate-linux.mjs"), appPath], { stdio: "inherit" });
}

// Windows Authenticode is opt-in because a real certificate and RFC 3161
// timestamp service are external credentials. A required gate always verifies
// the finished executable and native modules before they can be archived.
let windowsSigning = { status: "not-applicable" };
if (platform === "win32") {
  windowsSigning = { status: "unsigned", verified: false };
  if (process.env.EVOLV_SIGN_WINDOWS === "1") {
    execFileSync(process.execPath, [path.join(root, "scripts", "windows-signing.mjs"), "sign", appPath], { stdio: "inherit" });
    windowsSigning = { status: "signed", verified: true, certificateThumbprint: String(process.env.WINDOWS_SIGN_CERT_SHA1 || "").toUpperCase() };
  }
  if (process.env.EVOLV_REQUIRE_CODE_SIGNING === "1") {
    execFileSync(process.execPath, [path.join(root, "scripts", "windows-signing.mjs"), "gate", appPath], { stdio: "inherit" });
    windowsSigning.status = "signed";
    windowsSigning.verified = true;
  } else if (!windowsSigning.verified) {
    console.warn("UNSIGNED WINDOWS BUILD: set EVOLV_SIGN_WINDOWS=1 and signing variables to sign, or EVOLV_REQUIRE_CODE_SIGNING=1 to enforce the gate.");
  }
  fs.writeFileSync(path.join(appPath, "release-integrity.json"), JSON.stringify({
    product: "Evolv",
    version: pkg.version,
    platform,
    arch,
    createdAt: new Date().toISOString(),
    authenticode: windowsSigning
  }, null, 2));
}

// 5) Archive the package. A tarball preserves Linux executable permissions.
const archiveType = platform === "linux" ? "tar" : "zip";
const makeDir = path.join(outDir, "make", archiveType, platform, arch);
fs.mkdirSync(makeDir, { recursive: true });
const archivePath = path.join(
  makeDir,
  `${path.basename(appPath)}-${pkg.version}.${platform === "linux" ? "tar.gz" : "zip"}`
);
fs.rmSync(archivePath, { force: true });
const archiveArguments = platform === "linux"
  ? ["-czf", archivePath, "-C", outDir, path.basename(appPath)]
  : ["-a", "-c", "-f", archivePath, "-C", outDir, path.basename(appPath)];
execFileSync("tar", archiveArguments, { stdio: "inherit" });

const archiveMb = (fs.statSync(archivePath).size / 1024 / 1024).toFixed(1);
console.log(`\nDistributable: ${archivePath} (${archiveMb} MB)`);
