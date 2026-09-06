import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const realpathNativeAsync = promisify(fs.realpath.native);

// One canonical form for any folder Evolv stores, compares, or watches.
//
// The same directory can be named several ways: through a symlink or junction,
// with different casing on Windows, or as an 8.3 short path (`RUNNER~1`), which
// is what os.tmpdir() hands back on some Windows systems. Two parts of the
// application that normalise differently will disagree about whether they are
// looking at the same folder, and two of those disagreements were real bugs:
//
//   - A project grant saved by one normalisation and verified by another fails
//     every later check with PROJECT_GRANT_STALE.
//   - fs.watch given a non-canonical directory aborts the process on Windows.
//     libuv computes each changed file's path relative to the watched
//     directory and asserts the directory is a prefix of it
//     (`!_wcsnicmp(filename, dir, dirlen)` in src/win/fs-event.c); a short or
//     differently-cased directory string fails that assertion, and an assert
//     in libuv is abort(), not an exception, so nothing can catch it.
//
// The native realpath is the strict form: it resolves links and returns the
// path as the filesystem actually spells it, expanding short names. The
// JavaScript realpath resolves links but does not do either of the Windows
// normalisations, so the two must never be mixed.

export function canonicalRootSync(root) {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Native realpath can fail on filesystems that do not implement it. Fall
    // back rather than lose the ability to open the folder at all.
    try { return fs.realpathSync(resolved); } catch { return resolved; }
  }
}

export async function canonicalRoot(root) {
  const resolved = path.resolve(root);
  try {
    return await realpathNativeAsync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    const { realpath } = await import("node:fs/promises");
    return realpath(resolved);
  }
}
