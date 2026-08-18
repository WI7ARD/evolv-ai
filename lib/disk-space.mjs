// How much room is actually left to put a model in.
//
// Evolv chose which builds to offer by memory alone, then asked for up to
// sixteen gigabytes of downloads. On a laptop with a nearly full disk that is a
// download that fails somewhere near the end, after twenty minutes, with an
// error from Ollama about space — which is the worst possible moment to learn
// it. The size is known before anything starts.
import fs from "node:fs";
import os from "node:os";

// Left free after installing. A machine with nothing spare does not work well,
// and filling someone's last two gigabytes to install an optional assistant is
// not a trade Evolv gets to make on their behalf.
export const DISK_MARGIN_BYTES = 2_000_000_000;

// Ollama keeps its blobs under OLLAMA_MODELS, or ~/.ollama by default. The
// filesystem holding that directory is the one that has to have the room, and
// on a machine with a small system drive and a large data drive those are not
// the same answer.
export function ollamaStoragePath(env = process.env, home = os.homedir()) {
  return env.OLLAMA_MODELS || `${home}/.ollama`;
}

// Zero means "unknown", never "full": a filesystem Evolv cannot measure must
// not be reported as out of space, because that would withhold an install the
// machine can perfectly well do.
export function freeDiskBytes(target = ollamaStoragePath()) {
  for (const candidate of [target, os.homedir(), "/"]) {
    try {
      const stats = fs.statfsSync(candidate);
      return stats.bavail * stats.bsize;
    } catch {
      // Try the next one up: the models directory may not exist yet.
    }
  }
  return 0;
}

// A model that has to be downloaded to a machine Evolv is not running on is not
// this machine's problem. Only a local Ollama shares the disk.
export function ollamaIsLocal(url = "") {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

// As many builds as the free space can hold, smallest first.
//
// Smallest first on purpose: with room for one, the right one to take is the
// small fast build that works everywhere, not a larger one that leaves nothing
// behind it. Returns everything when free space is unknown, because a guess
// that withholds a working install is worse than no check at all.
export function affordableBuilds(builds = [], freeBytes = 0, margin = DISK_MARGIN_BYTES) {
  if (!freeBytes) return [...builds];
  let budget = Math.max(0, freeBytes - margin);
  const affordable = [];
  for (const build of [...builds].sort((left, right) => (left.approximateBytes || 0) - (right.approximateBytes || 0))) {
    const size = build.approximateBytes || 0;
    if (size > budget) continue;
    budget -= size;
    affordable.push(build);
  }
  return affordable;
}
