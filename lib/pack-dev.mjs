import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 500_000;
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function readPackSourceDirectory(root) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw error("Pack source folder needs a root manifest.json.");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { throw error("Pack manifest.json is malformed."); }
  const files = {};
  const pending = [resolvedRoot];
  let total = Buffer.byteLength(JSON.stringify(manifest));
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw error("Pack source folders cannot contain symbolic links.");
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile() || candidate === manifestPath) continue;
      const size = fs.statSync(candidate).size;
      if (size > MAX_FILE_BYTES) throw error(`Pack source file is too large: ${entry.name}`);
      const relative = path.relative(resolvedRoot, candidate).replace(/\\/g, "/");
      const content = fs.readFileSync(candidate, "utf8");
      if (content.includes("\u0000")) throw error(`Pack source file must be text: ${relative}`);
      total += Buffer.byteLength(content);
      if (total > MAX_PACKAGE_BYTES) throw error("Pack source exceeds the 5 MB package limit.", 413);
      files[relative] = content;
    }
  }
  return { packageVersion: 1, manifest, files };
}

export function watchPackSource(root, onChange) {
  const resolvedRoot = path.resolve(root);
  const watchers = [];
  const directories = [resolvedRoot];
  while (directories.length) {
    const directory = directories.pop();
    watchers.push(fs.watch(directory, () => onChange()));
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
        directories.push(path.join(directory, entry.name));
      }
    }
  }
  return () => watchers.forEach((watcher) => watcher.close());
}
