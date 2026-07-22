/**
 * Generates a 1024x1024 source PNG for the app icon (src-tauri/app-icon.png)
 * matching the CoreTools favicon: two vertical bars on a blue rounded field.
 *
 * This has zero dependencies — it hand-encodes a PNG — so it runs anywhere
 * (locally and in CI). Feed the output to `npm run tauri icon` to produce the
 * full platform icon set. Run: `node scripts/generate-icon.mjs`
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const N = 1024;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "app-icon.png");

// Palette — brand violet, matching the app accent and website favicon.
const BG = [139, 92, 246, 255]; // #8b5cf6
const LEFT = [255, 255, 255, 255];
const RIGHT = [203, 182, 251, 255]; // white @55% over the violet
const TRANSPARENT = [0, 0, 0, 0];

const S = N / 32; // favicon viewBox is 32 units
const corner = Math.round(7 * S); // outer rounded-corner radius

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

// Outer rounded-square mask so the icon isn't a hard square on platforms
// that don't apply their own mask.
function insideRoundedField(x, y) {
  const r = corner;
  const nearL = x < r, nearR = x >= N - r, nearT = y < r, nearB = y >= N - r;
  const cx = nearL ? r : nearR ? N - r - 1 : x;
  const cy = nearT ? r : nearB ? N - r - 1 : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function pixel(x, y) {
  if (!insideRoundedField(x, y)) return TRANSPARENT;
  // Left bar: x 7..15, y 7..25 (favicon units)
  if (inRect(x, y, 7 * S, 7 * S, 15 * S, 25 * S)) return LEFT;
  // Right bar: x 17..25, y 7..25
  if (inRect(x, y, 17 * S, 7 * S, 25 * S, 25 * S)) return RIGHT;
  return BG;
}

// Build raw RGBA scanlines, each prefixed with filter byte 0.
const raw = Buffer.alloc(N * (1 + N * 4));
let o = 0;
for (let y = 0; y < N; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < N; x++) {
    const [r, g, b, a] = pixel(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

// CRC-32 (PNG polynomial)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
console.log(`Wrote ${OUT} (${png.length} bytes, ${N}x${N})`);
