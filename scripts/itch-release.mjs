import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const command = process.argv[2];
const releasePlatform = process.argv[3] === "linux" ? "linux" : "windows";
const outputRoot = process.env.EVOLV_OUT_DIR ? path.resolve(process.env.EVOLV_OUT_DIR) : path.join(root, "out");
const buildDir = path.join(outputRoot, releasePlatform === "linux" ? "Evolv-linux-x64" : "Evolv-win32-x64");
const executableName = releasePlatform === "linux" ? "Evolv" : "Evolv.exe";
const itchPlatform = releasePlatform === "linux" ? "linux" : "windows";

function findButler() {
  const explicit = String(process.env.BUTLER_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = path.join(root, "work", "tools", "butler", process.platform === "win32" ? "butler.exe" : "butler");
  if (fs.existsSync(local)) return local;
  const names = process.platform === "win32" ? ["butler.exe", "butler"] : ["butler"];
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    const versions = path.join(process.env.APPDATA, "itch", "broth", "butler", "versions");
    if (fs.existsSync(versions)) {
      const candidates = fs.readdirSync(versions).map((version) => path.join(versions, version, "butler.exe"))
        .filter(fs.existsSync).sort().reverse();
      if (candidates[0]) return candidates[0];
    }
  }
  throw new Error("Butler was not found. Install the itch.io app or add butler to PATH.");
}

function runButler(args) {
  const result = spawnSync(findButler(), args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function windowsSigningGate({ required }) {
  if (releasePlatform !== "windows") return true;
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "windows-signing.mjs"), "gate", buildDir
  ], { cwd: root, stdio: "inherit", shell: false });
  if (result.status === 0) return true;
  if (!required) {
    console.warn("WARNING: Windows build is not Authenticode-verified.");
    return false;
  }
  if (process.env.EVOLV_ALLOW_UNSIGNED_PUSH === "1") {
    console.warn("EXPLICIT UNSIGNED OVERRIDE: EVOLV_ALLOW_UNSIGNED_PUSH=1 permits this itch.io upload. SmartScreen may warn users.");
    return false;
  }
  throw new Error("itch.io push blocked: Windows Authenticode gate failed. Sign the build or explicitly set EVOLV_ALLOW_UNSIGNED_PUSH=1.");
}

if (!fs.existsSync(path.join(buildDir, executableName))) {
  const script = releasePlatform === "linux" ? "dist:linux on Linux Mint" : "dist:win";
  throw new Error(`The packaged ${releasePlatform} build is missing. Run npm run ${script} first.`);
}

if (command === "validate") {
  windowsSigningGate({ required: false });
  runButler(["validate", "--platform", itchPlatform, "--arch", "amd64", buildDir]);
} else if (command === "push") {
  const user = String(process.env.ITCH_USER || "").trim();
  const project = String(process.env.ITCH_PROJECT || "").trim();
  if (!/^[a-z0-9-]+$/i.test(user) || !/^[a-z0-9-]+$/i.test(project)) {
    throw new Error("Set ITCH_USER and ITCH_PROJECT before pushing.");
  }
  windowsSigningGate({ required: true });
  runButler(["validate", "--platform", itchPlatform, "--arch", "amd64", buildDir]);
  runButler(["push", buildDir, `${user}/${project}:${itchPlatform}`, "--userversion", packageJson.version]);
} else {
  throw new Error("Use: node scripts/itch-release.mjs validate|push [linux]");
}
