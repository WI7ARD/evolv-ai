import assert from "node:assert/strict";
import test from "node:test";
import { createElectronSecretStore } from "../lib/secrets.mjs";

function fakeSafeStorage(backend = "gnome_libsecret") {
  return {
    getSelectedStorageBackend: () => backend,
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (buffer) => buffer.toString().replace(/^encrypted:/, "")
  };
}

test("Linux key storage refuses Electron's insecure basic_text backend", async () => {
  const store = createElectronSecretStore(fakeSafeStorage("basic_text"), "linux");
  assert.equal(store.available, false);
  assert.match(store.description, /keyring/i);
  await assert.rejects(store.encrypt("secret"), (error) => error.code === "SECRET_STORE_UNAVAILABLE");
});

test("Linux key storage uses a Secret Service-backed Electron store", async () => {
  const store = createElectronSecretStore(fakeSafeStorage(), "linux");
  assert.equal(store.available, true);
  assert.match(store.description, /Linux desktop keyring/);
  const encrypted = await store.encrypt("secret");
  assert.equal(await store.decrypt(encrypted), "secret");
  assert.doesNotMatch(encrypted, /secret/);
});

test("Windows key storage retains its DPAPI description", () => {
  const store = createElectronSecretStore(fakeSafeStorage("dpapi"), "win32");
  assert.equal(store.available, true);
  assert.match(store.description, /DPAPI/);
});


test("the README says what browser mode actually does with a cloud key", async () => {
  // It said browser builds encrypt keys "with a key held in the server's data
  // directory". They do not: there is no browser secret store at all, and
  // asking for one answers 503. A security claim in a README that the code
  // does not make is worse than no claim — someone trusts it and puts a real
  // key in.
  const { readFile } = await import("node:fs/promises");
  const { createUnavailableSecretStore } = await import("../lib/secrets.mjs");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  const store = createUnavailableSecretStore();
  assert.equal(store.available, false);
  await assert.rejects(() => store.encrypt("sk-test"), (error) => error.code === "SECRET_STORE_UNAVAILABLE");

  assert.doesNotMatch(readme, /encrypted with a key held in the server's data directory/,
    "the claim the code does not support");
  assert.match(readme, /Cloud keys are desktop-only/,
    "and what it does instead, said plainly");
});
