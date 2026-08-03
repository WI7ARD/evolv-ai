import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.resolve(process.argv[2] || path.join(root, "out", "Evolv-linux-x64"));
const executable = path.join(buildDir, "Evolv");
const manifest = path.join(buildDir, ".itch.toml");
const nativeModule = path.join(
  buildDir,
  "resources",
  "app.asar.unpacked",
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node"
);
const voiceRoot = path.join(buildDir, "resources", "app.asar.unpacked", "electron", "voice-assets");

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

function findFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && predicate(entry.name, candidate)) result.push(candidate);
    }
  }
  return result;
}

requireFile(executable, "Linux launcher");
requireFile(manifest, "itch.io manifest");
requireFile(nativeModule, "better-sqlite3 native module");

const manifestText = fs.readFileSync(manifest, "utf8");
if (!/path\s*=\s*"Evolv"/.test(manifestText) || !/platform\s*=\s*"linux"/.test(manifestText)) {
  throw new Error("The packaged itch.io manifest does not select the Linux Evolv launcher.");
}

const magic = fs.readFileSync(nativeModule).subarray(0, 4);
if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
  throw new Error("better_sqlite3.node is not a Linux ELF binary.");
}

if (process.platform === "linux") {
  fs.accessSync(executable, fs.constants.X_OK);
}

const windowsVoiceFiles = findFiles(
  voiceRoot,
  (name) => /\.(?:dll|exe)$/i.test(name)
);
if (windowsVoiceFiles.length) {
  throw new Error(`Windows-only voice files leaked into the Linux build: ${windowsVoiceFiles[0]}`);
}

console.log(`Linux package validation passed: ${buildDir}`);
