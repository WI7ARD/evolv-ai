// Updating a 311 MB AppImage by downloading only the parts that changed.
//
// Most of an Evolv AppImage is Electron and node_modules, which are identical
// between releases; the part that actually changes is the application code. A
// full download makes the person pay 311 MB for a few megabytes of difference,
// every release. This is the standard remedy — zsync's algorithm — with the two
// substitutions modern Node forces:
//
//   * zsync's strong checksum is MD4, which OpenSSL 3 refuses to provide, so
//     this uses SHA-256 truncated to 128 bits.
//   * zsync's control file would need its own build dependency (zsyncmake) to
//     produce, for compatibility with a tool nothing in this pipeline runs.
//
// So the file format is ours and both halves live here. What is not ours is the
// idea, which is rsync's: a weak checksum that can roll one byte at a time to
// find matching blocks wherever they have moved to, and a strong checksum to
// confirm each match.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

// Small enough that a change costs little, large enough that the map stays
// small: a 311 MB image maps to about 95 KB at this size.
export const BLOCK_SIZE = 65_536;
const STRONG_BYTES = 16;
const ENTRY_BYTES = 4 + STRONG_BYTES;
const MAP_VERSION = 1;

function strongHash(buffer) {
  return createHash("sha256").update(buffer).digest().subarray(0, STRONG_BYTES);
}

// rsync's weak checksum: a is the sum of the bytes, b the sum of the running
// totals, which weights each byte by its distance from the end of the window.
// Both are kept to 16 bits so the pair packs into one 32-bit number.
function weakSum(buffer, start, length) {
  let a = 0;
  let b = 0;
  for (let index = 0; index < length; index += 1) {
    a = (a + buffer[start + index]) & 0xffff;
    b = (b + a) & 0xffff;
  }
  return (((b << 16) | a) >>> 0);
}

// The whole point of the weak checksum: slide the window one byte without
// looking at the other 65,535. Dropping `out` removes its contribution to a,
// and length copies of it from b; adding `in` contributes to both.
function rollWeakSum(previous, out, next, length) {
  let a = (previous & 0xffff);
  let b = ((previous >>> 16) & 0xffff);
  a = (a - out + next) & 0xffff;
  b = (b - ((length * out) & 0xffff) + a) & 0xffff;
  return (((b << 16) | a) >>> 0);
}

export async function buildBlockMap(filePath, { blockSize = BLOCK_SIZE } = {}) {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const blocks = Math.ceil(size / blockSize);
    const table = Buffer.alloc(blocks * ENTRY_BYTES);
    const whole = createHash("sha256");
    const buffer = Buffer.alloc(blockSize);

    for (let index = 0; index < blocks; index += 1) {
      const { bytesRead } = await handle.read(buffer, 0, blockSize, index * blockSize);
      const block = buffer.subarray(0, bytesRead);
      whole.update(block);
      // A short final block cannot be found by a full-width rolling window, so
      // its weak checksum is recorded as zero and it is always fetched. It is
      // one block; the alternative is padding rules that only ever mislead.
      const weak = bytesRead === blockSize ? weakSum(block, 0, blockSize) : 0;
      table.writeUInt32BE(weak, index * ENTRY_BYTES);
      strongHash(block).copy(table, index * ENTRY_BYTES + 4);
    }

    const header = JSON.stringify({
      version: MAP_VERSION,
      blockSize,
      length: size,
      blocks,
      sha256: whole.digest("hex")
    });
    return Buffer.concat([Buffer.from(`${header}\n`, "utf8"), table]);
  } finally {
    await handle.close();
  }
}

export function parseBlockMap(buffer) {
  const split = buffer.indexOf(0x0a);
  if (split < 0) throw new Error("The block map has no header.");
  const header = JSON.parse(buffer.subarray(0, split).toString("utf8"));
  if (header.version !== MAP_VERSION) throw new Error(`Unsupported block map version ${header.version}.`);
  if (!Number.isInteger(header.blockSize) || header.blockSize <= 0) throw new Error("The block map has no block size.");
  if (!/^[a-f0-9]{64}$/i.test(header.sha256 || "")) throw new Error("The block map has no file hash.");
  const table = buffer.subarray(split + 1);
  if (table.length !== header.blocks * ENTRY_BYTES) throw new Error("The block map is truncated.");
  return { ...header, table };
}

// Where each block of the new file can be found: an offset in the file already
// on disk, or a range that has to be downloaded.
export async function planUpdate(localPath, map, { blockSize = map.blockSize } = {}) {
  const wanted = new Map();
  for (let index = 0; index < map.blocks; index += 1) {
    const weak = map.table.readUInt32BE(index * ENTRY_BYTES);
    if (weak === 0) continue;
    if (!wanted.has(weak)) wanted.set(weak, []);
    wanted.get(weak).push(index);
  }

  const found = new Map();
  const handle = await fs.open(localPath, "r").catch(() => null);
  if (handle) {
    try {
      const { size } = await handle.stat();
      // Read in chunks that overlap by one block less a byte, so a match
      // straddling a chunk boundary is still seen.
      const chunkSize = Math.max(blockSize * 64, blockSize + 1);
      const carry = blockSize - 1;
      let absolute = 0;
      let tail = Buffer.alloc(0);

      while (absolute < size && found.size < wanted.size) {
        const raw = Buffer.alloc(chunkSize);
        const { bytesRead } = await handle.read(raw, 0, chunkSize, absolute);
        if (bytesRead <= 0) break;
        const window = Buffer.concat([tail, raw.subarray(0, bytesRead)]);
        const base = absolute - tail.length;

        if (window.length >= blockSize) {
          let weak = weakSum(window, 0, blockSize);
          for (let offset = 0; ; offset += 1) {
            const candidates = wanted.get(weak);
            if (candidates) {
              // The weak checksum is 32 bits over 65 KB, so it collides; the
              // strong hash is what decides. Only computed on a weak hit.
              const strong = strongHash(window.subarray(offset, offset + blockSize));
              for (const index of candidates) {
                if (found.has(index)) continue;
                if (strong.equals(map.table.subarray(index * ENTRY_BYTES + 4, (index + 1) * ENTRY_BYTES))) {
                  found.set(index, base + offset);
                }
              }
            }
            if (offset + blockSize >= window.length) break;
            weak = rollWeakSum(weak, window[offset], window[offset + blockSize], blockSize);
          }
        }

        absolute += bytesRead;
        tail = window.subarray(Math.max(0, window.length - carry));
      }
    } finally {
      await handle.close();
    }
  }

  const blocks = [];
  let reusedBytes = 0;
  let fetchBytes = 0;
  for (let index = 0; index < map.blocks; index += 1) {
    const start = index * blockSize;
    const end = Math.min(start + blockSize, map.length);
    if (found.has(index)) {
      blocks.push({ index, source: "local", offset: found.get(index), bytes: end - start });
      reusedBytes += end - start;
    } else {
      blocks.push({ index, source: "remote", start, end, bytes: end - start });
      fetchBytes += end - start;
    }
  }

  // Adjacent missing blocks become one request. Fetching 300 blocks singly
  // would spend more on round trips than on bytes.
  const ranges = [];
  for (const block of blocks) {
    if (block.source !== "remote") continue;
    const last = ranges.at(-1);
    if (last && last.end === block.start) last.end = block.end;
    else ranges.push({ start: block.start, end: block.end });
  }

  return { blockSize, length: map.length, sha256: map.sha256, blocks, ranges, reusedBytes, fetchBytes };
}

// Writes the new file from the two sources, then proves it. The whole-file
// hash is the guarantee that matters: if any block was matched wrongly or any
// range arrived damaged, the result does not match and nothing is installed.
export async function applyUpdate({ localPath, outputPath, plan, fetchRange }) {
  const fetched = new Map();
  for (const range of plan.ranges) {
    const body = await fetchRange(range.start, range.end - 1);
    if (body.length !== range.end - range.start) {
      throw new Error(`The update server returned ${body.length} bytes for a ${range.end - range.start} byte range.`);
    }
    fetched.set(range.start, body);
  }

  const local = await fs.open(localPath, "r").catch(() => null);
  const output = await fs.open(outputPath, "w");
  try {
    const whole = createHash("sha256");
    const buffer = Buffer.alloc(plan.blockSize);
    for (const block of plan.blocks) {
      let bytes;
      if (block.source === "local") {
        if (!local) throw new Error("The file being updated disappeared mid-update.");
        const { bytesRead } = await local.read(buffer, 0, block.bytes, block.offset);
        if (bytesRead !== block.bytes) throw new Error("The file being updated changed mid-update.");
        bytes = buffer.subarray(0, block.bytes);
      } else {
        const range = plan.ranges.find((item) => block.start >= item.start && block.end <= item.end);
        bytes = fetched.get(range.start).subarray(block.start - range.start, block.end - range.start);
      }
      whole.update(bytes);
      await output.write(bytes);
    }
    const actual = whole.digest("hex");
    if (actual !== plan.sha256) throw new Error("The assembled update failed SHA-256 verification.");
    return { sha256: actual, reusedBytes: plan.reusedBytes, fetchBytes: plan.fetchBytes };
  } finally {
    await output.close();
    await local?.close();
  }
}
