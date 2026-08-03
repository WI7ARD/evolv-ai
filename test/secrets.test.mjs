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

