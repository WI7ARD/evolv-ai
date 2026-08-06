import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../lib/database.mjs";
import {
  BundledMarketplaceProvider,
  EVOLV_VERSION,
  MarketplaceService,
  compareSemver,
  permissionDiff,
  safePackPath,
  semverSatisfies,
  validateConfiguration,
  validateManifest,
  validatePackPackage
} from "../lib/marketplace.mjs";
import { canonicalJson, publisherKeyId, signPackPackage } from "../lib/marketplace-signing.mjs";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-marketplace-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test prompt." });
  const secretStore = {
    available: true,
    async encrypt(value) { return Buffer.from(`protected:${value}`).toString("base64"); },
    async decrypt(value) { return Buffer.from(value, "base64").toString().replace(/^protected:/, ""); }
  };
  const marketplace = new MarketplaceService({ database, profileDir: root, platform: "win32", secretStore, ...options });
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, database, marketplace, secretStore };
}

function requiredPermissions(packPackage) {
  return packPackage.manifest.permissions.filter((item) => item.required).map((item) => item.id);
}

test("bundled catalog contains nine complete usable packs including the personal engineering agent", () => {
  const provider = new BundledMarketplaceProvider();
  const packs = provider.listPacks();
  assert.equal(packs.length, 9);
  assert.deepEqual(packs.map((item) => item.name), [
    "Arduino Debugger", "Linux Repair Agent", "Repository Auditor", "UI Critic",
    "Local AI Setup Assistant", "Motorcycle Maintenance Assistant",
    "Small Business Knowledge Assistant", "Game Development Assistant", "Autonomous Engineering Agent"
  ]);
  for (const pack of packs) {
    assert.ok(pack.agents.length >= 1);
    assert.ok(pack.commands.length >= 3);
    assert.ok(pack.workflows.length >= 1);
    assert.ok(pack.examples.length >= 5);
    assert.match(pack.documentation, new RegExp(pack.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(pack.changelog.length);
    if (pack.screenshots.length) {
      assert.match(pack.screenshots[0], /^\/assets\/marketplace\/[a-z0-9-]+\.(?:jpg|png)$/);
      assert.equal(fs.existsSync(path.join(process.cwd(), "public", pack.screenshots[0].replace(/^\/+/, ""))), true);
    }
  }
});

test("manifest, semantic versions, permissions, configuration, and paths are validated", () => {
  assert.equal(compareSemver("1.2.0", "1.1.9"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.deepEqual(permissionDiff(["models.local"], ["models.local", "camera.access"]), { added: ["camera.access"], removed: [] });
  assert.equal(safePackPath("knowledge/guide.md"), "knowledge/guide.md");
  assert.throws(() => safePackPath("../escape"), /unsafe file path/);
  assert.throws(() => safePackPath("C:\\secret.txt"), /unsafe file path/);
  const schema = { type: "object", properties: { count: { type: "number", minimum: 1, maximum: 3 }, mode: { type: "string", enum: ["a", "b"] } } };
  assert.deepEqual(validateConfiguration(schema, { count: 2, mode: "a" }), { count: 2, mode: "a" });
  assert.throws(() => validateConfiguration(schema, { count: 20, mode: "a" }), /Configuration is invalid/);
});

test("bundled install persists, registers commands, disables cleanly, and uninstalls", (t) => {
  const { marketplace } = fixture(t);
  const provider = new BundledMarketplaceProvider();
  const source = provider.getPack("evolv.repository-auditor");
  const installed = marketplace.install({ id: source.manifest.id, approvedPermissions: requiredPermissions(source) });
  assert.equal(installed.enabled, true);
  assert.ok(marketplace.runtime().some((item) => item.id === "evolv.repository-auditor:audit-repository"));
  const resolved = marketplace.resolveCommand("evolv.repository-auditor:audit-repository", "Review this app");
  assert.match(resolved.promptTemplate, /\{\{input\}\}/);
  assert.equal(resolved.inputLength, "Review this app".length);
  assert.match(resolved.agent.systemPrompt, /repository auditor/i);
  const freeForm = marketplace.resolveChat("evolv.repository-auditor", "Something is wrong with this repository");
  assert.equal(freeForm.freeForm, true);
  assert.equal(freeForm.command.name, "Free-form specialist chat");
  assert.match(freeForm.promptTemplate, /infer the concrete task/i);
  assert.equal(freeForm.inputLength, "Something is wrong with this repository".length);
  marketplace.setEnabled(installed.id, false);
  assert.equal(marketplace.runtime().some((item) => item.packId === installed.id), false);
  marketplace.setEnabled(installed.id, true);
  assert.equal(marketplace.uninstall(installed.id).ok, true);
  assert.equal(marketplace.getInstalled(installed.id), null);
});

test("install requires explicit permissions and required revocation disables the pack", (t) => {
  const { marketplace } = fixture(t);
  assert.throws(() => marketplace.install({ id: "evolv.linux-repair", approvedPermissions: [] }), /Approve required permission/);
  const source = new BundledMarketplaceProvider().getPack("evolv.linux-repair");
  marketplace.install({ id: source.manifest.id, approvedPermissions: requiredPermissions(source) });
  const revoked = marketplace.revokePermission(source.manifest.id, "models.local");
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.status, "disabled");
});

test("local update detects a newer version and preserves the old install after invalid input", (t) => {
  const { marketplace } = fixture(t);
  const provider = new BundledMarketplaceProvider();
  const old = provider.getPack("evolv.arduino-debugger", "1.0.0");
  marketplace.install({ id: old.manifest.id, version: old.manifest.version, approvedPermissions: requiredPermissions(old) });
  assert.equal(marketplace.getInstalled(old.manifest.id).updateAvailable, true);
  const latest = provider.getPack(old.manifest.id);
  marketplace.install({ id: old.manifest.id, approvedPermissions: latest.manifest.permissions.map((item) => item.id) });
  assert.equal(marketplace.getInstalled(old.manifest.id).version, "1.1.0");
  const malicious = marketplace.exportPack(old.manifest.id);
  malicious.manifest.version = "1.2.0";
  malicious.files["../escape.txt"] = "no";
  assert.throws(() => marketplace.install({ package: malicious, approvedPermissions: latest.manifest.permissions.map((item) => item.id) }), /unsafe file path/);
  assert.equal(marketplace.getInstalled(old.manifest.id).version, "1.1.0");
});

test("weighted search prefers exact names and supports tags and command names", (t) => {
  const { marketplace } = fixture(t);
  assert.equal(marketplace.catalog({ query: "UI Critic" })[0].id, "evolv.ui-critic");
  assert.equal(marketplace.catalog({ query: "apt" })[0].id, "evolv.linux-repair");
  assert.equal(marketplace.catalog({ query: "serial log" })[0].id, "evolv.arduino-debugger");
  assert.ok(marketplace.catalog({ category: "gaming" }).every((item) => item.category === "gaming"));
});

test("pack configuration persists while secret fields use secure storage and never enter plaintext config", async (t) => {
  const { marketplace, database } = fixture(t);
  const source = new BundledMarketplaceProvider().getPack("evolv.small-business-knowledge");
  source.manifest.id = "evolv.secure-business";
  source.manifest.name = "Secure Business";
  source.manifest.configSchema.properties.privateToken = {
    type: "string", title: "Private token", description: "Test-only secret.", format: "secret"
  };
  marketplace.install({ package: source, approvedPermissions: requiredPermissions(source) });
  const saved = await marketplace.saveConfig(source.manifest.id, {
    organizationName: "Example Co", requireCitations: false, privateToken: "top-secret-value"
  });
  assert.equal(saved.config.organizationName, "Example Co");
  assert.equal("privateToken" in saved.config, false);
  assert.deepEqual(saved.configuredSecrets, ["privateToken"]);
  const row = database.raw.prepare("SELECT encrypted_secret FROM marketplace_secrets WHERE pack_id=?").get(source.manifest.id);
  assert.ok(row.encrypted_secret);
  assert.doesNotMatch(row.encrypted_secret, /top-secret-value/);
  assert.doesNotMatch(JSON.stringify(marketplace.exportPack(source.manifest.id)), /top-secret-value/);
});

test("developer mode creates a valid exportable starter and duplicate manifests are rejected", (t) => {
  const { marketplace } = fixture(t);
  assert.throws(() => marketplace.createStarter({}), /Developer Mode/);
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({
    name: "Release Helper",
    id: "evolv.release-helper",
    description: "Prepare safe release checklists.",
    category: "development",
    author: "Owner",
    agentPrompt: "You are a careful release engineer.",
    commandPrompt: "Prepare a release checklist for: {{input}}"
  });
  assert.equal(validatePackPackage(starter, { platform: "win32" }).manifest.id, "evolv.release-helper");
  marketplace.install({ package: starter, approvedPermissions: requiredPermissions(starter) });
  assert.equal(marketplace.catalog({ filter: "installed" }).some((item) => item.id === "evolv.release-helper"), true);
  assert.equal(marketplace.details("evolv.release-helper").source, "local");
  const duplicate = structuredClone(starter);
  duplicate.files["manifest.json"] = "{}";
  assert.throws(() => validatePackPackage(duplicate, { platform: "win32" }), /must not be duplicated/);
  const invalid = structuredClone(starter.manifest);
  invalid.id = "../../bad";
  assert.throws(() => validateManifest(invalid, { platform: "win32" }), /Pack ID/);
});

test("the minimum-version gate tracks the shipped release, not a hardcoded literal", (t) => {
  const { marketplace } = fixture(t);
  const shipped = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(EVOLV_VERSION, shipped);
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({
    name: "Current Release Pack", id: "evolv.current-release", author: "Owner"
  });
  // A pack authored against the shipped release must install, and one that
  // needs a future release must still be refused.
  const current = structuredClone(starter.manifest);
  current.minEvolvVersion = shipped;
  assert.equal(validateManifest(current, { platform: "win32" }).minEvolvVersion, shipped);
  const future = structuredClone(starter.manifest);
  future.minEvolvVersion = `${Number(shipped.split(".")[0]) + 1}.0.0`;
  assert.throws(() => validateManifest(future, { platform: "win32" }), /requires Evolv/);
});

test("publisher verification is cryptographic and manifests cannot self-award trust", (t) => {
  const { marketplace } = fixture(t);
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({
    name: "Signed Helper", id: "evolv.signed-helper", author: "Test Publisher"
  });
  starter.manifest.verified = true;
  assert.equal(validatePackPackage(starter, { platform: "win32" }).manifest.verified, false);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const signed = signPackPackage(starter, {
    publisher: { id: "test-publisher", name: "Test Publisher", publicKey: publicKeyPem },
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" })
  });
  assert.match(publisherKeyId(publicKeyPem), /^ed25519:[a-f0-9]{64}$/);
  const preview = marketplace.preview({ package: signed });
  assert.equal(preview.verification.state, "signed");
  assert.equal(preview.manifest.verified, false);
  const installed = marketplace.install({
    package: signed,
    trustPublisher: true,
    approvedPermissions: requiredPermissions(signed)
  });
  assert.equal(installed.manifest.verified, true);
  assert.equal(installed.manifest.publisherVerification.state, "trusted");
  assert.equal(marketplace.publishers()[0].trusted, true);

  const tampered = structuredClone(signed);
  tampered.manifest.description = "Changed after signing.";
  assert.throws(() => marketplace.preview({ package: tampered }), /signature verification failed/i);
});

test("remote catalogs require a trusted signature and remain usable from the verified cache", async (t) => {
  const { marketplace } = fixture(t);
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({ name: "Remote Helper", id: "evolv.remote-helper" });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publisher = {
    id: "remote-publisher",
    name: "Remote Publisher",
    publicKey: publicKey.export({ type: "spki", format: "pem" })
  };
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const signedPack = signPackPackage(starter, { publisher, privateKey: privatePem });
  marketplace.install({ package: signedPack, trustPublisher: true, approvedPermissions: requiredPermissions(signedPack) });
  marketplace.uninstall(signedPack.manifest.id);

  const generatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const catalogPayload = { catalogVersion: 1, generatedAt, expiresAt, packages: [signedPack] };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(catalogPayload)), privateKey).toString("base64");
  const signedCatalog = {
    ...catalogPayload,
    publisher,
    signature: { algorithm: "Ed25519", keyId: publisherKeyId(publisher.publicKey), value: signature }
  };
  marketplace.configureRemoteCatalog("http://127.0.0.1:43210/catalog.json");
  const response = new Response(JSON.stringify(signedCatalog), {
    status: 200,
    headers: { "content-type": "application/json", etag: "\"v1\"" }
  });
  const status = await marketplace.syncRemoteCatalog({ fetchImpl: async () => response });
  assert.equal(status.cached, true);
  assert.equal(status.publisherKeyId, publisherKeyId(publisher.publicKey));
  assert.equal(marketplace.catalog().some((item) => item.id === signedPack.manifest.id && item.source === "remote"), true);
  assert.equal(marketplace.preview({ id: signedPack.manifest.id }).verification.trusted, true);
});

test("installed packs persist release channels and expose concrete update notices", (t) => {
  const { marketplace } = fixture(t);
  const provider = new BundledMarketplaceProvider();
  const old = provider.getPack("evolv.arduino-debugger", "1.0.0");
  marketplace.install({ id: old.manifest.id, version: "1.0.0", approvedPermissions: requiredPermissions(old) });
  assert.deepEqual(marketplace.updateNotices().map(({ id, currentVersion, availableVersion, channel }) =>
    ({ id, currentVersion, availableVersion, channel })), [{
    id: old.manifest.id, currentVersion: "1.0.0", availableVersion: "1.1.0", channel: "stable"
  }]);
  assert.equal(marketplace.setReleaseChannel(old.manifest.id, "beta").releaseChannel, "beta");
  assert.equal(marketplace.getInstalled(old.manifest.id).releaseChannel, "beta");
  assert.throws(() => marketplace.setReleaseChannel(old.manifest.id, "unsafe"), /Stable, Beta, or Nightly/);
});

test("file and folder configuration uses the desktop-owned picker boundary", async (t) => {
  const calls = [];
  const host = {
    async chooseConfigurationPath(input) {
      calls.push(input);
      return { canceled: false, path: "C:\\Users\\Owner\\Documents\\Example" };
    }
  };
  const { marketplace } = fixture(t, { host });
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({ name: "Picker Pack", id: "evolv.picker-pack" });
  starter.manifest.configSchema.properties.projectFolder = {
    type: "string", title: "Project folder", description: "Selected project.", format: "folder"
  };
  marketplace.install({ package: starter, approvedPermissions: requiredPermissions(starter) });
  const result = await marketplace.chooseConfigurationPath(starter.manifest.id, "projectFolder");
  assert.equal(result.path, "C:\\Users\\Owner\\Documents\\Example");
  assert.deepEqual(calls, [{ kind: "folder", title: "Project folder" }]);
  await assert.rejects(() => marketplace.chooseConfigurationPath(starter.manifest.id, "missing"), /does not support/);
});

test("developer live reload validates source changes and never expands permissions", async (t) => {
  let sourceRoot = "";
  const host = {
    async choosePackSourceDirectory() { return { canceled: false, path: sourceRoot }; }
  };
  const { marketplace, root } = fixture(t, { host });
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({ name: "Watched Pack", id: "evolv.watched-pack" });
  marketplace.install({ package: starter, approvedPermissions: requiredPermissions(starter) });
  sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, "manifest.json"), JSON.stringify(starter.manifest));
  fs.writeFileSync(path.join(sourceRoot, "README.md"), "# Initial");
  const cli = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "evolv-pack.mjs"), "validate", sourceRoot], {
    cwd: process.cwd(), encoding: "utf8"
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /"valid": true/);
  const started = await marketplace.startDeveloperWatch(starter.manifest.id);
  assert.equal(started.status, "watching");
  assert.equal(started.sourceName, "source");
  const firstReload = started.lastReloadAt;
  await new Promise((resolve) => setTimeout(resolve, 25));
  fs.writeFileSync(path.join(sourceRoot, "README.md"), "# Reloaded");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && marketplace.developerWatchStatus()[0]?.lastReloadAt === firstReload) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.notEqual(marketplace.developerWatchStatus()[0].lastReloadAt, firstReload);
  assert.equal(marketplace.stopDeveloperWatch(starter.manifest.id).ok, true);
  assert.deepEqual(marketplace.developerWatchStatus(), []);
});

test("dependencies and conflicts are enforced for install, disable, and uninstall", (t) => {
  const { marketplace } = fixture(t);
  marketplace.developerMode(true);
  assert.equal(semverSatisfies("1.4.2", "^1.2.0"), true);
  assert.equal(semverSatisfies("2.0.0", "^1.2.0"), false);
  assert.equal(semverSatisfies("1.2.9", "~1.2.0"), true);
  const base = marketplace.createStarter({ name: "Base Pack", id: "evolv.base-pack" });
  const dependent = marketplace.createStarter({ name: "Dependent Pack", id: "evolv.dependent-pack" });
  dependent.manifest.dependencies = [{ id: base.manifest.id, range: "^0.1.0" }];
  assert.throws(() => marketplace.install({ package: dependent, approvedPermissions: requiredPermissions(dependent) }), /before Dependent Pack/);
  marketplace.install({ package: base, approvedPermissions: requiredPermissions(base) });
  marketplace.install({ package: dependent, approvedPermissions: requiredPermissions(dependent) });
  assert.throws(() => marketplace.setEnabled(base.manifest.id, false), /required by enabled pack/);
  assert.throws(() => marketplace.uninstall(base.manifest.id), /depends on it/);

  const conflict = marketplace.createStarter({ name: "Conflict Pack", id: "evolv.conflict-pack" });
  conflict.manifest.conflicts = [{ id: dependent.manifest.id, range: "*", reason: "They provide the same command." }];
  assert.throws(() => marketplace.install({ package: conflict, approvedPermissions: requiredPermissions(conflict) }), /conflicts with enabled pack/);
  marketplace.setEnabled(dependent.manifest.id, false);
  marketplace.install({ package: conflict, approvedPermissions: requiredPermissions(conflict) });
  assert.equal(marketplace.getInstalled(conflict.manifest.id).enabled, true);
});

test("reviews stay in a durable outbox unless a trusted backend signs the response", async (t) => {
  const { marketplace } = fixture(t);
  marketplace.developerMode(true);
  const starter = marketplace.createStarter({ name: "Reviewed Pack", id: "evolv.reviewed-pack" });
  const offlineInstalled = marketplace.install({ package: starter, approvedPermissions: requiredPermissions(starter) });
  const pending = await marketplace.submitReview(offlineInstalled.id, {
    rating: 4, title: "Useful locally", body: "This review should remain clearly local."
  }, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(pending.status, "pending");
  assert.match(pending.lastError, /No trusted review backend/);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publisher = {
    id: "review-service", name: "Review Service",
    publicKey: publicKey.export({ type: "spki", format: "pem" })
  };
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const signedPack = signPackPackage({
    ...starter,
    manifest: { ...starter.manifest, id: "evolv.review-key-pack", name: "Review Key Pack" }
  }, { publisher, privateKey: privatePem });
  marketplace.install({ package: signedPack, trustPublisher: true, approvedPermissions: requiredPermissions(signedPack) });
  marketplace.configureReviewBackend("http://127.0.0.1:4545/api/", publisherKeyId(publisher.publicKey));

  const envelope = (payload) => ({
    payload,
    publisher,
    signature: {
      algorithm: "Ed25519",
      keyId: publisherKeyId(publisher.publicKey),
      value: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64")
    }
  });
  const fetchImpl = async (url, options = {}) => {
    const payload = options.method === "POST"
      ? { accepted: true, reviewId: "remote-review-1" }
      : {
          packId: offlineInstalled.id,
          reviews: [{ id: "remote-review-1", rating: 5, title: "Verified review", body: "Signed by the configured backend.", author: "Tester", createdAt: new Date().toISOString() }]
        };
    return new Response(JSON.stringify(envelope(payload)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const sent = await marketplace.submitReview(offlineInstalled.id, {
    rating: 5, title: "Ready to publish", body: "This one receives a signed acknowledgement."
  }, { fetchImpl });
  assert.equal(sent.status, "sent");
  assert.equal(sent.remoteId, "remote-review-1");
  const synced = await marketplace.syncReviews(offlineInstalled.id, { fetchImpl });
  assert.equal(synced.trustedReviews[0].title, "Verified review");
  assert.equal(synced.verification.trusted, true);
});
