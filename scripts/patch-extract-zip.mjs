// extract-zip@2.0.1 pulls in yauzl@2.10 / fd-slicer, whose read streams never
// emit data on Node >=24. Every electron-forge / @electron/packager run that
// extracts the Electron template therefore hangs on the first file. This patch
// rewrites the installed extract-zip entry point to extract with the bundled
// Windows bsdtar (System32\tar.exe, present since Windows 10 1803), which reads
// zip archives natively and does not depend on yauzl. It is idempotent and runs
// from `postinstall`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "node_modules", "extract-zip", "index.js");
const MARKER = "PATCHED: yauzl@2.10 / fd-slicer read streams never emit";

if (!fs.existsSync(target)) {
  console.log("patch-extract-zip: extract-zip not installed, nothing to do.");
  process.exit(0);
}

const source = fs.readFileSync(target, "utf8");
if (source.includes(MARKER)) {
  console.log("patch-extract-zip: already patched.");
  process.exit(0);
}

const original = `module.exports = async function (zipPath, opts) {
  debug('creating target directory', opts.dir)

  if (!path.isAbsolute(opts.dir)) {
    throw new Error('Target directory is expected to be absolute')
  }

  await fs.mkdir(opts.dir, { recursive: true })
  opts.dir = await fs.realpath(opts.dir)
  return new Extractor(zipPath, opts).extract()
}`;

const replacement = `async function legacyExtract (zipPath, opts) {
  debug('creating target directory', opts.dir)

  if (!path.isAbsolute(opts.dir)) {
    throw new Error('Target directory is expected to be absolute')
  }

  await fs.mkdir(opts.dir, { recursive: true })
  opts.dir = await fs.realpath(opts.dir)
  return new Extractor(zipPath, opts).extract()
}

// ${MARKER} on Node >=24, so the streaming
// extraction above hangs on the first entry. On Windows, extract with the
// bundled bsdtar (System32\\tar.exe, present since Windows 10 1803), which reads
// zip archives natively and does not depend on yauzl.
module.exports = async function (zipPath, opts) {
  if (!path.isAbsolute(opts.dir)) {
    throw new Error('Target directory is expected to be absolute')
  }
  await fs.mkdir(opts.dir, { recursive: true })
  opts.dir = await fs.realpath(opts.dir)
  if (process.platform === 'win32') {
    const { execFileSync } = require('child_process')
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'tar.exe')
    debug('extracting via bsdtar', bsdtar, zipPath, '->', opts.dir)
    execFileSync(bsdtar, ['-x', '-f', zipPath, '-C', opts.dir], { stdio: 'ignore' })
    return
  }
  return legacyExtract(zipPath, opts)
}
module.exports.legacyExtract = legacyExtract`;

if (!source.includes(original)) {
  console.warn("patch-extract-zip: expected extract-zip entry point not found; skipping (upstream may have changed).");
  process.exit(0);
}

fs.writeFileSync(target, source.replace(original, replacement));
console.log(`patch-extract-zip: patched ${target}`);
