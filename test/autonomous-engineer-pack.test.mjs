import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabase } from "../lib/database.mjs";
import { MarketplaceService, validatePackPackage } from "../lib/marketplace.mjs";

const packPath = path.join(process.cwd(), "packs", "evolv-autonomous-engineer.evolvpack");

test("autonomous engineering pack installs as a bounded declarative agent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-autonomous-pack-"));
  const database = createDatabase({ dataDir: root, defaultPrompt: "Test prompt." });
  const marketplace = new MarketplaceService({ database, profileDir: root, platform: "win32" });
  t.after(() => {
    marketplace.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const source = JSON.parse(fs.readFileSync(packPath, "utf8"));
  const checked = validatePackPackage(source, { platform: "win32" });
  assert.equal(checked.manifest.id, "evolv.autonomous-engineer");
  assert.equal(checked.manifest.verified, false);
  assert.equal(checked.verification.state, "unsigned");
  assert.equal(checked.manifest.permissions.some((item) => item.id === "terminal.execute.unrestricted"), false);
  assert.match(checked.manifest.agents[0].systemPrompt, /never claim success without verification/i);
  assert.match(checked.manifest.documentation, /runtime supplies the actual tools/i);
  assert.deepEqual(checked.manifest.screenshots, ["/assets/marketplace/autonomous-engineer.png"]);
  assert.ok(fs.statSync(path.join(process.cwd(), "public", "assets", "marketplace", "autonomous-engineer.png")).size > 100_000);

  const required = checked.manifest.permissions.filter((item) => item.required).map((item) => item.id);
  const allRequested = checked.manifest.permissions.map((item) => item.id);
  const installed = marketplace.install({ package: source, approvedPermissions: allRequested });
  assert.equal(installed.enabled, true);
  assert.ok(required.every((permission) => installed.grantedPermissions.includes(permission)));
  const commands = marketplace.runtime().filter((item) => item.packId === checked.manifest.id && item.type === "command");
  assert.equal(commands.length, 9);
  assert.ok(commands.some((item) => item.id.endsWith(":implement-change") && item.requiresApproval));
  assert.ok(commands.some((item) => item.id.endsWith(":research-technical-decision") && item.requiresApproval));
  const details = marketplace.details(checked.manifest.id);
  assert.equal(details.diagnostics.unsupportedPermissions.includes("filesystem.write.project"), false);
  assert.equal(details.diagnostics.unsupportedPermissions.includes("terminal.execute.approved"), false);
  assert.equal(details.diagnostics.unsupportedPermissions.includes("network.internet"), false);
  assert.deepEqual(details.diagnostics.unsupportedPermissions, []);
  assert.equal(marketplace.resolveChat(checked.manifest.id, "Improve this app").freeForm, true);
  assert.equal(validatePackPackage(marketplace.exportPack(checked.manifest.id), { platform: "win32" }).manifest.id, checked.manifest.id);
});
