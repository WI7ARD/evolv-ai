import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { signingReadiness, signingTargets } from "../lib/windows-signing.mjs";

test("Windows signing readiness requires a certificate, timestamp service, and signtool", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-signing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signTool = path.join(root, "signtool.exe");
  fs.writeFileSync(signTool, "");
  const ready = signingReadiness({
    platform: "win32",
    env: {
      SIGNTOOL_PATH: signTool,
      WINDOWS_SIGN_CERT_SHA1: "A".repeat(40),
      WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test/rfc3161"
    }
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.thumbprint, "A".repeat(40));
  const missing = signingReadiness({ platform: "win32", env: {} });
  assert.equal(missing.ready, false);
  assert.ok(missing.errors.length >= 3);
});

test("Windows signing targets include the app and Evolv-owned native modules", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-sign-targets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "resources", "app.asar.unpacked", "node_modules", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "Evolv.exe"), "test");
  fs.writeFileSync(path.join(root, "resources", "app.asar.unpacked", "node_modules", "example", "native.node"), "test");
  assert.deepEqual(signingTargets(root).map((item) => path.basename(item)).sort(), ["Evolv.exe", "native.node"]);
});
