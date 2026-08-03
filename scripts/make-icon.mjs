// Generates build/icon.ico — Evolv's application icon — with no external image
// dependencies. Each size is drawn into a raw RGBA buffer, encoded as a PNG
// (Node's zlib provides the deflate stream PNG expects), and the PNGs are then
// packed into a single multi-resolution Windows .ico. Re-run with:
//   node scripts/make-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZES = [16, 32, 48, 64, 128, 256];
const MINT = [52, 224, 161];

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

// Draws the Evolv mark: a mint "E" on a dark, diagonally lit rounded tile.
function drawIcon(size) {
  const data = new Uint8Array(size * size * 4);
  const radius = size * 0.19;
  const s = (value) => value * size;
  const stem = s(0.12);
  const left = s(0.31);
  const right = s(0.71);
  const top = s(0.24);
  const bottom = s(0.76);
  const mid = (top + bottom) / 2 - stem / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;

      // Rounded-corner mask: fully transparent outside the tile radius.
      let alpha = 255;
      const cornerX = x < radius ? radius - x - 0.5 : (x > size - radius ? x - (size - radius) + 0.5 : 0);
      const cornerY = y < radius ? radius - y - 0.5 : (y > size - radius ? y - (size - radius) + 0.5 : 0);
      if (cornerX > 0 && cornerY > 0 && Math.hypot(cornerX, cornerY) > radius) alpha = 0;

      // Diagonal gradient background (deep teal → near-black).
      const t = (x + y) / (2 * size);
      let r = Math.round(9 + t * 10);
      let g = Math.round(28 + t * 46);
      let b = Math.round(32 + t * 50);

      // The "E": vertical stem plus top, middle, and bottom bars.
      const onE = inRect(x, y, left, top, left + stem, bottom)
        || inRect(x, y, left, top, right, top + stem)
        || inRect(x, y, left, mid, right - s(0.05), mid + stem)
        || inRect(x, y, left, bottom - stem, right, bottom);
      if (onE) {
        [r, g, b] = MINT;
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = alpha;
    }
  }
  return data;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression, filter, interlace already zero

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + entries.length;
  pngs.forEach((entry, index) => {
    const base = index * 16;
    entries[base] = entry.size >= 256 ? 0 : entry.size;
    entries[base + 1] = entry.size >= 256 ? 0 : entry.size;
    entries[base + 2] = 0; // color palette
    entries[base + 3] = 0; // reserved
    entries.writeUInt16LE(1, base + 4); // color planes
    entries.writeUInt16LE(32, base + 6); // bits per pixel
    entries.writeUInt32LE(entry.png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, entries, ...pngs.map((entry) => entry.png)]);
}

const pngs = SIZES.map((size) => ({ size, png: encodePng(drawIcon(size), size) }));
const ico = encodeIco(pngs);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "icon.ico");
fs.writeFileSync(outPath, ico);
// Also emit the largest PNG for docs/store listings.
fs.writeFileSync(path.join(outDir, "icon.png"), pngs.at(-1).png);
// Prefer the generated Evolv brand files for release builds. The procedural
// icon remains above as a deterministic fallback if those assets are absent.
const brandedIco = path.join(outDir, "..", "public", "assets", "evolv-logo.ico");
const brandedPng = path.join(outDir, "..", "public", "assets", "evolv-logo.png");
if (fs.existsSync(brandedIco) && fs.existsSync(brandedPng)) {
  fs.copyFileSync(brandedIco, outPath);
  fs.copyFileSync(brandedPng, path.join(outDir, "icon.png"));
}
console.log(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes, sizes: ${SIZES.join(", ")})`);
