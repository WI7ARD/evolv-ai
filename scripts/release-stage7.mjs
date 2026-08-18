import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes("--check-only");
const packageArgument = process.argv.indexOf("--package");
const packagePath = packageArgument >= 0 ? path.resolve(process.argv[packageArgument + 1] || "")
  : process.env.EVOLV_STAGE7_PACKAGE ? path.resolve(process.env.EVOLV_STAGE7_PACKAGE) : "";
const checks = [];

function record(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail: String(detail || "") });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

function requireText(relativePath, patterns = []) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    record(relativePath, false, "missing");
    return "";
  }
  const text = fs.readFileSync(target, "utf8");
  const missing = patterns.filter((pattern) => !pattern.test(text));
  record(relativePath, missing.length === 0, missing.length ? `${missing.length} required contract(s) missing` : "present");
  return text;
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
record("version alignment", packageJson.version === lock.version && packageJson.version === lock.packages?.[""]?.version, packageJson.version);

requireText("public/styles.css", [
  /\.sidebar\s*\{[\s\S]*overflow-y:\s*auto/,
  /\.conversation-list\s*\{[\s\S]*overflow:\s*visible/
]);
requireText("public/app.js", [
  /marketplaceInstallInFlight/,
  /verified\.installedRecord/,
  /\/api\/projects\/demo/
]);
requireText("server.mjs", [/\/api\/projects\/demo/, /projectService\.createDemo/]);
requireText("docs/USER-GUIDE.md", [/Marketplace/, /Recovery/, /Linux Mint/]);
requireText("docs/RECOVERY.md", [/backup/i, /recovery code/i, /integrity/i]);
requireText("docs/RELEASE-NOTES-0.5.0-PERSONAL.md", [/0\.5\.0/, /pack install/i, /sidebar/i]);
requireText("docs/STAGE-7-RELIABILITY-RELEASE.md", [/Windows package/, /Linux/, /not verified/i]);
// The two suites that stand between a release and the failures 0.7.0 was about.
// The full test run below would catch them breaking, but not them being
// deleted, and a gate that quietly stops checking something is worse than one
// that never checked it.
requireText("test/failure-matrix.test.mjs", [/PROVIDER_AUTH_FAILED/, /PROVIDER_CIRCUIT_OPEN/, /PROVIDER_UNREACHABLE/]);
requireText("test/chaos.test.mjs", [/SQLITE_FULL/, /integrityCheck/, /malformed|not json/]);
requireText(".itch.toml", [/path\s*=\s*"Evolv\.exe"/, /platform\s*=\s*"windows"/]);
requireText(".itch-linux.toml", [/path\s*=\s*"Evolv"/, /platform\s*=\s*"linux"/]);

if (!checkOnly) {
  const testFiles = fs.readdirSync(path.join(root, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join(root, "test", name));
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
    cwd: root,
    stdio: "inherit",
    shell: false
  });
  record("complete automated test suite", result.status === 0, result.status === 0 ? "passed" : `exit ${result.status}`);
} else {
  record("complete automated test suite", true, "skipped by --check-only");
}

if (packagePath) {
  const executable = path.join(packagePath, "Evolv.exe");
  const manifest = path.join(packagePath, ".itch.toml");
  const nativeModule = path.join(packagePath, "resources", "app.asar.unpacked", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const present = [executable, manifest, nativeModule].every((target) => fs.existsSync(target) && fs.statSync(target).isFile());
  let nativeIsPe = false;
  if (fs.existsSync(nativeModule)) nativeIsPe = fs.readFileSync(nativeModule).subarray(0, 2).equals(Buffer.from("MZ"));
  record("Windows package structure", present && nativeIsPe, packagePath);
} else {
  record("Windows package structure", true, "not supplied; validate after npm run dist:win with --package <folder>");
}

const failed = checks.filter((item) => !item.passed);
const report = {
  schemaVersion: 1,
  version: packageJson.version,
  createdAt: new Date().toISOString(),
  platform: process.platform,
  checkOnly,
  status: failed.length ? "failed" : "passed",
  windowsPackageChecked: Boolean(packagePath),
  linuxBinaryChecked: false,
  linuxNote: "A Linux binary is intentionally not certified by this Windows gate. Run npm run dist:linux and npm run linux:validate on Linux Mint.",
  sourceDigest: crypto.createHash("sha256").update([
    "package.json", "server.mjs", "public/app.js", "public/styles.css", "lib/projects.mjs"
  ].map((file) => fs.readFileSync(path.join(root, file))).reduce((all, item) => Buffer.concat([all, item]), Buffer.alloc(0))).digest("hex"),
  checks
};
const releaseDirectory = path.join(root, "release");
fs.mkdirSync(releaseDirectory, { recursive: true });
fs.writeFileSync(path.join(releaseDirectory, "stage7-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Stage 7 gate ${report.status}. Report: ${path.join(releaseDirectory, "stage7-report.json")}`);
if (failed.length) process.exitCode = 1;
