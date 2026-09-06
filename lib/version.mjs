import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

// The shipped version, read once from package.json.
//
// Two places used to carry it as a literal — the Marketplace compatibility
// gate and the outbound user-agent — and both had drifted to 0.4.0 while the
// product shipped 0.6.3. A literal is a promise to remember, and nobody does.
// The fallback exists so a packaging accident degrades rather than prevents
// startup.
function read() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const version = JSON.parse(fs.readFileSync(manifest, "utf8"))?.version;
    if (typeof version === "string" && SEMVER.test(version)) return version;
  } catch { /* fall through */ }
  return "0.0.0";
}

// The repository the app updates from, read from the same manifest.
//
// This had drifted the same way the version did, and more expensively: the
// updater checked WI7ARD/evolv-personal while the release workflow publishes
// with the token of the repository it runs in. Releases landed in one place and
// the updater looked in another, so every check answered "no stable release is
// available" no matter how many releases existed.
function readRepository() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const url = String(JSON.parse(fs.readFileSync(manifest, "utf8"))?.repository?.url || "");
    // Covers the three forms npm accepts: https, git+https, and scp-style ssh.
    const match = url.match(/github\.com[/:]([A-Za-z0-9_.-]{1,80})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  } catch { /* fall through */ }
  return "";
}

export const EVOLV_VERSION = read();
export const EVOLV_USER_AGENT = `Evolv/${EVOLV_VERSION}`;
export const EVOLV_REPOSITORY = readRepository();
