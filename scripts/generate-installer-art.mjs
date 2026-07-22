/**
 * Generates the NSIS installer artwork so the Windows setup wizard carries the
 * CoreTools brand instead of the stock NSIS graphics:
 *
 *   src-tauri/installer/nsis-sidebar.bmp  (164x314 — welcome/finish sidebar)
 *   src-tauri/installer/nsis-header.bmp   (150x57  — header on other pages)
 *
 * NSIS requires 24-bit BMP, which this script hand-encodes — zero dependencies
 * so it runs identically locally and in CI. Referenced from tauri.conf.json
 * (bundle.windows.nsis). Run: `node scripts/generate-installer-art.mjs`
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "installer");
mkdirSync(OUT_DIR, { recursive: true });

/* ----------------------------- palette ----------------------------- */

const DARK_TOP = [26, 18, 42]; // violet-tinted near-black
const DARK_BOTTOM = [11, 13, 18]; // #0b0d12
const VIOLET = [139, 92, 246]; // #8b5cf6 (brand accent)
const BAR_LEFT = [255, 255, 255];
const BAR_RIGHT = [203, 182, 251]; // white @55% over violet

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/* ------------------------- logo rasterizer ------------------------- */

/**
 * Sample the CoreTools mark (rounded square + two bars, 32-unit design like
 * the favicon) at pixel (x, y) for a logo of size `s` anchored at (x0, y0).
 * Returns an RGB array or null when outside the mark.
 */
function logoPixel(x, y, x0, y0, s) {
  const lx = x - x0;
  const ly = y - y0;
  if (lx < 0 || ly < 0 || lx >= s || ly >= s) return null;

  // Rounded-corner mask (radius 7/32 of the size, like the favicon).
  const r = (7 / 32) * s;
  const nearL = lx < r, nearR = lx >= s - r, nearT = ly < r, nearB = ly >= s - r;
  const cx = nearL ? r : nearR ? s - r - 1 : lx;
  const cy = nearT ? r : nearB ? s - r - 1 : ly;
  if ((lx - cx) ** 2 + (ly - cy) ** 2 > r * r) return null;

  const u = (lx / s) * 32;
  const v = (ly / s) * 32;
  if (u >= 7 && u < 15 && v >= 7 && v < 25) return BAR_LEFT;
  if (u >= 17 && u < 25 && v >= 7 && v < 25) return BAR_RIGHT;
  return VIOLET;
}

/* --------------------------- BMP encoder --------------------------- */

/** Encode a 24-bit bottom-up BMP from a per-pixel RGB callback. */
function encodeBMP(width, height, pixelAt) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowSize * height;
  const fileSize = 54 + imageSize;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive → bottom-up rows
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB, uncompressed
  buf.writeUInt32LE(imageSize, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize; // bottom-up
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      const o = row + x * 3;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
    }
  }
  return buf;
}

/* ---------------------------- sidebar ------------------------------ */

const SB_W = 164;
const SB_H = 314;
const SB_LOGO = 84;
const SB_LOGO_X = (SB_W - SB_LOGO) / 2;
const SB_LOGO_Y = 72;

function sidebarPixel(x, y) {
  const logo = logoPixel(x, y, SB_LOGO_X, SB_LOGO_Y, SB_LOGO);
  if (logo) return logo;

  // Vertical dark gradient with a soft violet glow behind the logo.
  let base = lerp(DARK_TOP, DARK_BOTTOM, y / SB_H);
  const gx = SB_W / 2;
  const gy = SB_LOGO_Y + SB_LOGO / 2;
  const d = Math.hypot(x - gx, y - gy);
  const R = 105;
  if (d < R) {
    const glow = 0.28 * (1 - d / R) ** 2;
    base = lerp(base, VIOLET, glow);
  }
  return base;
}

/* ----------------------------- header ------------------------------ */

const HD_W = 150;
const HD_H = 57;
const HD_LOGO = 34;
const HD_LOGO_X = HD_W - HD_LOGO - 14;
const HD_LOGO_Y = (HD_H - HD_LOGO) / 2;

function headerPixel(x, y) {
  return logoPixel(x, y, HD_LOGO_X, HD_LOGO_Y, HD_LOGO) ?? DARK_BOTTOM;
}

/* ------------------------------ write ------------------------------ */

const sidebar = encodeBMP(SB_W, SB_H, sidebarPixel);
const header = encodeBMP(HD_W, HD_H, headerPixel);
writeFileSync(join(OUT_DIR, "nsis-sidebar.bmp"), sidebar);
writeFileSync(join(OUT_DIR, "nsis-header.bmp"), header);
console.log(`Wrote installer/nsis-sidebar.bmp (${sidebar.length} bytes, ${SB_W}x${SB_H})`);
console.log(`Wrote installer/nsis-header.bmp (${header.length} bytes, ${HD_W}x${HD_H})`);
