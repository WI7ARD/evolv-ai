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

export const EVOLV_VERSION = read();
export const EVOLV_USER_AGENT = `Evolv/${EVOLV_VERSION}`;
