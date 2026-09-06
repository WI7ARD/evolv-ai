import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { applyUpdate, buildBlockMap, parseBlockMap, planUpdate, BLOCK_SIZE } from "../lib/block-delta.mjs";

// Small blocks keep the fixtures small; the algorithm does not care.
const BLOCK = 1024;

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evolv-delta-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

// Stands in for the release server: serves byte ranges of the new file and
// counts what was actually asked for.
function server(newFile) {
  const state = { bytes: 0, requests: 0 };
  return {
    state,
    fetchRange: async (start, end) => {
      state.requests += 1;
      state.bytes += end - start + 1;
      return newFile.subarray(start, end + 1);
    }
  };
}

async function update(root, oldFile, newFile, { blockSize = BLOCK } = {}) {
  const oldPath = path.join(root, "old.bin");
  const newPath = path.join(root, "new.bin");
  const outPath = path.join(root, `out-${randomBytes(4).toString("hex")}.bin`);
  await writeFile(oldPath, oldFile);
  await writeFile(newPath, newFile);

  const map = parseBlockMap(await buildBlockMap(newPath, { blockSize }));
  const plan = await planUpdate(oldPath, map);
  const remote = server(newFile);
  const result = await applyUpdate({ localPath: oldPath, outputPath: outPath, plan, fetchRange: remote.fetchRange });
  return { plan, result, remote, produced: await readFile(outPath) };
}

test("an unchanged file downloads nothing at all", async (t) => {
  const root = await workspace(t);
  const file = randomBytes(BLOCK * 20);

  const { plan, remote, produced } = await update(root, file, file);

  assert.equal(remote.state.bytes, 0, "nothing was fetched");
  assert.equal(plan.fetchBytes, 0);
  assert.ok(produced.equals(file));
});

test("changing one block downloads one block, not the file", async (t) => {
  const root = await workspace(t);
  const oldFile = randomBytes(BLOCK * 20);
  const newFile = Buffer.from(oldFile);
  randomBytes(BLOCK).copy(newFile, BLOCK * 7);

  const { remote, produced } = await update(root, oldFile, newFile);

  assert.ok(produced.equals(newFile), "the result is the new file, byte for byte");
  assert.ok(remote.state.bytes <= BLOCK * 2, `fetched ${remote.state.bytes} bytes for a ${BLOCK} byte change`);
  assert.ok(remote.state.bytes < newFile.length / 4, "nothing like a full download");
});

test("inserting bytes at the front still reuses everything after the insertion", async (t) => {
  const root = await workspace(t);
  // The case fixed-offset comparison cannot handle: every later block has moved
  // to an address that is not a multiple of the block size. This is the entire
  // reason the weak checksum rolls a byte at a time.
  const oldFile = randomBytes(BLOCK * 20);
  const newFile = Buffer.concat([randomBytes(37), oldFile]);

  const { remote, produced } = await update(root, oldFile, newFile);

  assert.ok(produced.equals(newFile));
  assert.ok(remote.state.bytes <= BLOCK * 3, `a 37 byte insertion cost ${remote.state.bytes} bytes`);
});

test("with no file to update from, everything is downloaded and the result is still correct", async (t) => {
  const root = await workspace(t);
  const newFile = randomBytes(BLOCK * 8 + 11);
  const outPath = path.join(root, "fresh.bin");
  const newPath = path.join(root, "new.bin");
  await writeFile(newPath, newFile);

  const map = parseBlockMap(await buildBlockMap(newPath, { blockSize: BLOCK }));
  const plan = await planUpdate(path.join(root, "does-not-exist.bin"), map);
  const remote = server(newFile);
  await applyUpdate({ localPath: path.join(root, "does-not-exist.bin"), outputPath: outPath, plan, fetchRange: remote.fetchRange });

  assert.equal(remote.state.bytes, newFile.length, "a first install is a full download");
  assert.ok((await readFile(outPath)).equals(newFile));
});

test("a file that is not a multiple of the block size round-trips exactly", async (t) => {
  const root = await workspace(t);
  const oldFile = randomBytes(BLOCK * 5 + 100);
  const newFile = Buffer.concat([oldFile.subarray(0, BLOCK * 5), randomBytes(377)]);

  const { produced } = await update(root, oldFile, newFile);

  assert.ok(produced.equals(newFile));
  assert.equal(produced.length, newFile.length);
});

test("a damaged download is refused rather than installed", async (t) => {
  const root = await workspace(t);
  const oldFile = randomBytes(BLOCK * 10);
  const newFile = Buffer.from(oldFile);
  randomBytes(BLOCK).copy(newFile, BLOCK * 3);
  const oldPath = path.join(root, "old.bin");
  const newPath = path.join(root, "new.bin");
  await writeFile(oldPath, oldFile);
  await writeFile(newPath, newFile);
  const map = parseBlockMap(await buildBlockMap(newPath, { blockSize: BLOCK }));
  const plan = await planUpdate(oldPath, map);

  // One flipped bit anywhere in the assembled file has to stop the install.
  await assert.rejects(() => applyUpdate({
    localPath: oldPath,
    outputPath: path.join(root, "bad.bin"),
    plan,
    fetchRange: async (start, end) => {
      const body = Buffer.from(newFile.subarray(start, end + 1));
      body[0] ^= 0x01;
      return body;
    }
  }), /failed SHA-256 verification/);

  // A range of the wrong size is caught before it can be assembled.
  await assert.rejects(() => applyUpdate({
    localPath: oldPath,
    outputPath: path.join(root, "short.bin"),
    plan,
    fetchRange: async (start, end) => Buffer.from(newFile.subarray(start, end))
  }), /bytes for a/);
});

test("adjacent missing blocks are fetched as one request", async (t) => {
  const root = await workspace(t);
  const oldFile = randomBytes(BLOCK * 20);
  const newFile = Buffer.from(oldFile);
  // Three consecutive blocks rewritten: one range, not three requests.
  randomBytes(BLOCK * 3).copy(newFile, BLOCK * 5);

  const { plan, remote, produced } = await update(root, oldFile, newFile);

  assert.ok(produced.equals(newFile));
  assert.equal(plan.ranges.length, 1, "one contiguous range");
  assert.equal(remote.state.requests, 1);
});

test("a corrupted or foreign block map is refused", async (t) => {
  const root = await workspace(t);
  const filePath = path.join(root, "file.bin");
  await writeFile(filePath, randomBytes(BLOCK * 3));
  const map = await buildBlockMap(filePath, { blockSize: BLOCK });

  assert.throws(() => parseBlockMap(Buffer.from("no newline here")), /no header/);
  assert.throws(() => parseBlockMap(map.subarray(0, map.length - 5)), /truncated/);
  const wrongVersion = Buffer.concat([Buffer.from(`${JSON.stringify({ version: 99 })}\n`), Buffer.alloc(0)]);
  assert.throws(() => parseBlockMap(wrongVersion), /Unsupported block map version/);
});

test("the real block size keeps the map small enough to download first", async (t) => {
  const root = await workspace(t);
  const filePath = path.join(root, "big.bin");
  await writeFile(filePath, randomBytes(BLOCK_SIZE * 4));

  const map = await buildBlockMap(filePath);
  const parsed = parseBlockMap(map);

  assert.equal(parsed.blockSize, BLOCK_SIZE);
  // 20 bytes per block: a 311 MB AppImage maps to about 95 KB.
  assert.equal(parsed.table.length, parsed.blocks * 20);
  assert.ok(map.length / (BLOCK_SIZE * 4) < 0.001, "the map is a thousandth of the file");
  assert.equal(parsed.sha256, createHash("sha256").update(await readFile(filePath)).digest("hex"));
});
