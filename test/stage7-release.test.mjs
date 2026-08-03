import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("Stage 7 ships recovery, user, release, and honest platform documentation", () => {
  for (const file of [
    "docs/USER-GUIDE.md",
    "docs/RECOVERY.md",
    "docs/RELEASE-NOTES-0.5.0-PERSONAL.md",
    "docs/STAGE-7-RELIABILITY-RELEASE.md"
  ]) assert.ok(fs.statSync(path.join(root, file)).size > 500, `${file} is incomplete`);
  const stage = fs.readFileSync(path.join(root, "docs/STAGE-7-RELIABILITY-RELEASE.md"), "utf8");
  assert.match(stage, /Linux executable: not verified/);
  assert.match(stage, /Windows package/);
});

test("Stage 7 static release gate passes and writes a truthful report", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/release-stage7.mjs"), "--check-only"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(root, "release/stage7-report.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.linuxBinaryChecked, false);
  assert.match(report.linuxNote, /Linux Mint/);
  assert.match(report.sourceDigest, /^[a-f0-9]{64}$/);
});

test("personal release version is aligned across package metadata", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, "0.6.3");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(pkg.scripts["release:stage7"], "node scripts/release-stage7.mjs");
});

test("Windows packaging includes the modular goal-runner server routes", () => {
  const packScript = fs.readFileSync(path.join(root, "scripts", "pack-win.mjs"), "utf8");
  assert.match(packScript, /electron\|lib\|public\|packs\|server/);
  assert.ok(fs.existsSync(path.join(root, "server", "goal-routes.mjs")));
});

test("desktop packaging excludes every generated out folder", () => {
  const forge = fs.readFileSync(path.join(root, "forge.config.cjs"), "utf8");
  assert.match(forge, /electronZipDir:\s*process\.env\.ELECTRON_ZIP_DIR/);
  assert.match(forge, /out\(\?:-\[\^\/\]\+\)\?/);
  assert.match(forge, /Evolv-Personal-\[\^\/\]\+/);
  assert.match(forge, /evolv-\(\?:agent\|marketplace\|packaged\)-smoke/);
  assert.match(forge, /release-integrity\.json/);
  assert.match(forge, /resources\/app\.asar/);
});
