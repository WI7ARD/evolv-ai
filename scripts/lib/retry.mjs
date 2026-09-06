// Retrying a download, for build scripts.
//
// Three CI builds in a row went red without a line of application code being
// at fault: a dropped connection fetching the AppImage runtime, a socket hang
// up fetching better-sqlite3's prebuilt binary during npm ci, and another one
// fetching the Electron-ABI build of the same binary while packaging. Each was
// a single unretried network call somewhere in a chain that had already spent
// minutes doing real work.
//
// The build scripts are synchronous end to end — they shell out with
// execFileSync and spawnSync — so this is a synchronous retry rather than an
// async one. That is deliberate: making the callers async to gain a promise
// nothing would await is a worse trade than blocking a build script that has
// nothing else to do.

// Long enough to outlast a blip, short enough that four attempts do not
// dominate a build. Tests shorten it.
export const DEFAULT_DELAY_MS = Number(process.env.EVOLV_RETRY_DELAY_MS) || 2000;
export const DEFAULT_ATTEMPTS = 4;

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs `operation` until it stops throwing, backing off between attempts, and
// re-throws the last error once the attempts are spent. `retryable` exists so a
// caller can distinguish a failure worth repeating from one that never will be:
// a missing prebuild is an answer, not an outage, and retrying it four times
// only delays a message the user needs to read.
export function retrySync(operation, {
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  label = "That",
  retryable = () => true,
  log = console.log,
  sleep = sleepSync
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      const wait = delayMs * 2 ** (attempt - 1);
      log(`${label} failed (attempt ${attempt} of ${attempts}): ${error.message}. Retrying in ${Math.round(wait / 1000)}s…`);
      sleep(wait);
    }
  }
}
