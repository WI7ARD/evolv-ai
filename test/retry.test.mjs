import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { retrySync } from "../scripts/lib/retry.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Nothing here sleeps: the waits are recorded instead, so the backoff can be
// asserted rather than endured.
function spy() {
  const waits = [];
  const lines = [];
  return { waits, lines, sleep: (ms) => waits.push(ms), log: (line) => lines.push(line) };
}

test("a call that works is made once and its value returned", () => {
  const { waits, sleep, log } = spy();
  let calls = 0;
  const value = retrySync(() => { calls += 1; return "downloaded"; }, { sleep, log });

  assert.equal(value, "downloaded");
  assert.equal(calls, 1, "a working call must not be repeated");
  assert.deepEqual(waits, [], "and must not wait");
});

test("a failing call is retried, backing off, until it works", () => {
  const { waits, lines, sleep, log } = spy();
  let calls = 0;
  const value = retrySync(() => {
    calls += 1;
    if (calls < 3) throw new Error("socket hang up");
    return "downloaded";
  }, { delayMs: 1000, label: "The download", sleep, log });

  assert.equal(value, "downloaded");
  assert.equal(calls, 3);
  // Doubling, so a longer outage is waited out without four calls in a second.
  assert.deepEqual(waits, [1000, 2000]);
  assert.match(lines[0], /The download failed \(attempt 1 of 4\): socket hang up/);
});

test("it gives up eventually and raises the real error", () => {
  const { waits, sleep, log } = spy();
  let calls = 0;

  assert.throws(
    () => retrySync(() => { calls += 1; throw new Error("connection died"); }, { attempts: 3, delayMs: 10, sleep, log }),
    // The last failure, not a wrapper: the caller needs to know what went wrong.
    /connection died/
  );
  assert.equal(calls, 3);
  assert.equal(waits.length, 2, "no wait after the final attempt — nothing follows it");
});

test("a failure that will never succeed is not repeated", () => {
  const { waits, sleep, log } = spy();
  let calls = 0;

  // A missing prebuilt binary is an answer, not an outage. Retrying it four
  // times only delays the message that explains what to change.
  assert.throws(() => retrySync(
    () => { calls += 1; throw new Error("No prebuilt binaries found"); },
    { retryable: (error) => !/no prebuilt binaries found/i.test(error.message), sleep, log }
  ), /No prebuilt binaries found/);

  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("every download in the build chain retries", async () => {
  // Three separate CI failures, three unretried downloads: the AppImage
  // runtime, better-sqlite3 during npm ci, and the Electron-ABI build of
  // better-sqlite3 while packaging. This checks the last two shapes stay
  // wrapped, since neither can be exercised without a real network.
  const pack = await readFile(path.join(root, "scripts", "pack-win.mjs"), "utf8");
  assert.match(pack, /retrySync\(downloadPrebuild/, "the prebuild download must be retried");

  // It also used to answer a dropped connection with "pin electron to a version
  // with a published prebuild", sending the reader after a version problem that
  // was not there.
  assert.match(pack, /network failure, so re-running should fix it/);
  assert.match(pack, /no prebuilt binaries found/i, "the two cases have to be told apart to say either");

  const installers = await readFile(path.join(root, "scripts", "make-installers.mjs"), "utf8");
  assert.match(installers, /retrySync\(/);
});
