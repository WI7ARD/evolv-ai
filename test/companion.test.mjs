import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDatabase } from "../lib/database.mjs";
import { createCompanionService, normalizePairingCode, formatPairingCode } from "../lib/companion.mjs";

async function withService(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "evolv-companion-"));
  const database = createDatabase({ dataDir: directory, dbPath: path.join(directory, "c.db"), defaultPrompt: "test" });
  let clock = Date.now();
  const service = createCompanionService({ database, clock: () => clock });
  try {
    await run({ service, database, advance: (ms) => { clock += ms; } });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a phone pairs once with a code and gets a token that is never stored in the clear", async () => {
  await withService(async ({ service, database }) => {
    const { code, display } = service.startPairing();
    // Readable off a screen and typeable on a phone: grouped, and without the
    // characters people mistake for each other.
    assert.equal(display, formatPairingCode(code));
    assert.doesNotMatch(code, /[O0I1L]/);

    const { token, device } = service.redeemPairing(display, { name: "Pixel" });
    assert.equal(device.name, "Pixel");
    assert.ok(token.length >= 40);

    // The token verifies, and the database holds no copy of it anywhere.
    assert.equal(service.verifyToken(token).id, device.id);
    const dump = JSON.stringify(database.listCompanionDevices());
    assert.equal(dump.includes(token), false, "a stored token would be replayable from a copied database");

    // One code, one device. The same code cannot mint a second token.
    assert.throws(() => service.redeemPairing(display, { name: "Someone else" }),
      (error) => error.code === "PAIRING_EXPIRED");
  });
});

test("a code expires, and guessing it locks the attempt out", async () => {
  await withService(async ({ service, advance }) => {
    service.startPairing();
    advance(5 * 60 * 1000 + 1);
    assert.equal(service.pendingPairing(), null);
    assert.throws(() => service.redeemPairing("AAAABBBB"), (error) => error.code === "PAIRING_EXPIRED");

    // Guessing is bounded, and the count belongs to the code rather than to
    // whoever is guessing — otherwise changing address buys more tries.
    service.startPairing();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.throws(() => service.redeemPairing("ZZZZZZZZ"), (error) => error.code === "PAIRING_REJECTED");
    }
    assert.throws(() => service.redeemPairing("ZZZZZZZZ"), (error) => error.code === "PAIRING_LOCKED");
  });
});

test("starting a new pairing invalidates the code still on screen", async () => {
  await withService(async ({ service }) => {
    const first = service.startPairing();
    const second = service.startPairing();
    assert.notEqual(first.code, second.code);
    assert.throws(() => service.redeemPairing(first.code), (error) => error.code === "PAIRING_REJECTED");
    assert.ok(service.redeemPairing(second.code).token);
  });
});

test("revoking a device stops its token immediately and keeps the record", async () => {
  await withService(async ({ service }) => {
    const { token, device } = service.redeemPairing(service.startPairing().code, { name: "Old phone" });
    assert.ok(service.verifyToken(token));

    assert.equal(service.revokeDevice(device.id), true);
    assert.equal(service.verifyToken(token), null, "a revoked device must not authenticate");
    assert.equal(service.revokeDevice(device.id), false, "revoking twice is not a second event");

    // The row survives: "what was paired, and when did it lose access" is a
    // question a deleted row cannot answer.
    const listed = service.listDevices().find((item) => item.id === device.id);
    assert.ok(listed?.revokedAt, "the record should remain, marked revoked");
  });
});

test("an unknown or absent token authenticates nothing", async () => {
  await withService(async ({ service }) => {
    assert.equal(service.verifyToken(""), null);
    assert.equal(service.verifyToken(null), null);
    assert.equal(service.verifyToken("not-a-real-token"), null);
  });
});

test("codes are read back the way people actually type them", () => {
  assert.equal(normalizePairingCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizePairingCode(" abcd efgh "), "ABCDEFGH");
  assert.equal(formatPairingCode("ABCDEFGH"), "ABCD-EFGH");
});
