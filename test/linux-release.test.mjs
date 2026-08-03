import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Linux release has a native launcher manifest and dedicated build commands", () => {
  const manifest = fs.readFileSync(new URL("../.itch-linux.toml", import.meta.url), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const forge = fs.readFileSync(new URL("../forge.config.cjs", import.meta.url), "utf8");
  assert.match(manifest, /path\s*=\s*"Evolv"/);
  assert.match(manifest, /platform\s*=\s*"linux"/);
  assert.match(packageJson.scripts["dist:linux"], /--platform=linux/);
  assert.match(packageJson.scripts["itch:validate:linux"], /validate linux/);
  assert.match(forge, /"win32",\s*"linux"/);
  assert.match(forge, /\.itch-linux\.toml/);
});

test("Linux packaging rejects cross-building so executable bits and native modules stay valid", () => {
  const script = fs.readFileSync(new URL("../scripts/pack-win.mjs", import.meta.url), "utf8");
  assert.match(script, /platform === "linux" && process\.platform !== "linux"/);
  assert.match(script, /better-sqlite3/);
  assert.match(script, /tar\.gz/);
  assert.match(script, /voice-assets\\\/whisper\\\/release/);
});

test("Linux package validator checks the launcher, manifest, and ELF native module", (t) => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "evolv-linux-validation-"));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  const nativeDirectory = path.join(
    build,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release"
  );
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(path.join(build, "Evolv"), "launcher", { mode: 0o755 });
  fs.writeFileSync(path.join(build, ".itch.toml"), 'path = "Evolv"\nplatform = "linux"\n');
  fs.writeFileSync(path.join(nativeDirectory, "better_sqlite3.node"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));
  const result = spawnSync(process.execPath, [
    new URL("../scripts/validate-linux.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    build
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /validation passed/);
});
