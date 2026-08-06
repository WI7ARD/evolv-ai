import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { canonicalRoot, canonicalRootSync } from "../lib/canonical-path.mjs";

test("canonicalising a folder resolves links so every caller agrees on one spelling", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-canonical-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const real = path.join(root, "real-folder");
  const link = path.join(root, "link-to-folder");
  await mkdir(real);
  try {
    await symlink(real, link, "junction");
  } catch {
    t.skip("Directory links are unavailable in this environment.");
    return;
  }

  // Both spellings of the same directory must canonicalise to one value, and
  // the sync and async forms must not disagree with each other.
  const viaReal = await canonicalRoot(real);
  const viaLink = await canonicalRoot(link);
  assert.equal(viaLink, viaReal, "a link and its target must canonicalise identically");
  assert.equal(canonicalRootSync(link), viaReal, "sync and async canonicalisation must agree");

  // A trailing separator or a redundant segment is the same folder too.
  assert.equal(await canonicalRoot(`${link}${path.sep}`), viaReal);
  assert.equal(await canonicalRoot(path.join(link, ".")), viaReal);
});

test("canonicalising reports a missing folder rather than inventing one", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-canonical-missing-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await assert.rejects(
    () => canonicalRoot(path.join(root, "not-here")),
    (error) => error.code === "ENOENT"
  );
  // The sync form is used where a watcher must still start; it degrades to the
  // resolved path instead of throwing.
  const missing = path.join(root, "also-not-here");
  assert.equal(canonicalRootSync(missing), path.resolve(missing));
  assert.ok(fs.existsSync(root));
});
