/**
 * Generates the Microsoft Store listing images (Partner Center → the
 * submission → Store listings → Store logos and Promotional images) into
 * microsoftstore/:
 *
 *   tile-300x300.png, tile-150x150.png, tile-71x71.png  Store display images
 *   box-art-1080x1080.png, box-art-2160x2160.png        1:1 Box art
 *   poster-art-720x1080.png, poster-art-1440x2160.png   9:16 Poster art (Xbox)
 *   super-hero-art-1920x1080.png, …-3840x2160.png       16:9 Super hero art (no text)
 *   titled-hero-art-1920x1080.png                       Xbox titled hero art
 *   promotional-square-art-1080x1080.png                Xbox promotional square (no title)
 *   branded-key-art-584x800.png                         Xbox branded key art
 *
 * The mark is the website favicon's shape (website/index.html: two bars on
 * a rounded violet square) given depth for the Store: a lit gradient field,
 * a glossy sheen and rim, raised bars with soft shadows. The type is the
 * website's own Inter (website/assets/fonts). Unlike the other generate-*
 * scripts this needs real, anti-aliased type and SVG effects, so it draws
 * with the Chromium that Playwright installs for the end-to-end tests
 * (`npx playwright install chromium` if missing).
 * Run: `node scripts/generate-store-art.mjs`
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "microsoftstore");
mkdirSync(OUT_DIR, { recursive: true });

const font = readFileSync(join(root, "website", "assets", "fonts", "inter-var-latin.woff2")).toString("base64");

/**
 * The mark, drawn at any size (one per page: the gradient ids are global).
 * Field lit from the top left (#b197fc → brand #8b5cf6 → #5b21b6), a soft
 * sheen, a bright top rim fading down the sides, a darker floor for depth;
 * the left bar solid white, the right one frosted (the favicon's 55%).
 */
const MARK = `<svg class="mark" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="field" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#b59cff"/>
      <stop offset="0.48" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#5323b8"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.22" cy="0.1" r="0.85">
      <stop offset="0" stop-color="#fff" stop-opacity="0.42"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#1e0a4a" stop-opacity="0"/>
      <stop offset="1" stop-color="#1e0a4a" stop-opacity="0.32"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.7"/>
      <stop offset="0.35" stop-color="#fff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="barSolid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#ebe4ff"/>
    </linearGradient>
    <linearGradient id="barFrost" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.66"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="barEdge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.2"/>
    </linearGradient>
    <filter id="lift" x="-60%" y="-30%" width="220%" height="170%">
      <feDropShadow dx="0" dy="0.7" stdDeviation="0.8" flood-color="#240b5c" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect width="32" height="32" rx="7" fill="url(#field)"/>
  <rect width="32" height="32" rx="7" fill="url(#floor)"/>
  <rect width="32" height="32" rx="7" fill="url(#sheen)"/>
  <rect x="0.35" y="0.35" width="31.3" height="31.3" rx="6.65" fill="none" stroke="url(#rim)" stroke-width="0.7"/>
  <g filter="url(#lift)">
    <rect x="7" y="7" width="8" height="18" rx="1.7" fill="url(#barSolid)"/>
    <rect x="17" y="7" width="8" height="18" rx="1.7" fill="url(#barFrost)"/>
    <rect x="17.25" y="7.25" width="7.5" height="17.5" rx="1.45" fill="none" stroke="url(#barEdge)" stroke-width="0.5"/>
  </g>
</svg>`;

const BASE_CSS = `
  @font-face { font-family: "Inter"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body { font-family: "Inter", sans-serif; color: #f1eefb; -webkit-font-smoothing: antialiased; }
`;

/** Store display images: the mark alone, edge to edge, corners transparent. */
const tile = () => `<style>${BASE_CSS} body { background: transparent; } .mark { display: block; width: 100%; height: 100%; }</style>${MARK}`;

// Film grain over the backdrops (SVG noise), so the gradients don't band.
const GRAIN =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
  );

/**
 * Abstract "lines of a file" on either side (at most `length` vw long), a
 * few lit in violet like the changes Diff-Checker marks: the tools without
 * showing UI or text, which the hero art rules forbid. Kept clear of the
 * bottom third (the Store may lay a gradient there).
 */
function codeLines(length) {
  const rows = [
    [0.62, 0], [0.88, 0], [0.48, 1], [0.74, 0], [0.9, 2], [0.56, 0], [0.8, 0], [0.4, 1], [0.68, 0],
  ];
  const side = (left) =>
    rows
      .map(([width, lit], i) => {
        const style = [
          `top: ${20 + i * 4.6}vh`,
          left ? `left: 6vw` : `right: 6vw`,
          `width: ${(width * length).toFixed(1)}vw`,
          lit === 1
            ? "background: linear-gradient(90deg, rgba(167, 139, 250, 0.75), rgba(139, 92, 246, 0.45)); box-shadow: 0 0 1.2vh rgba(139, 92, 246, 0.45)"
            : lit === 2
              ? "background: rgba(203, 182, 251, 0.32)"
              : "",
        ];
        return `<i style="${style.filter(Boolean).join("; ")}"></i>`;
      })
      .join("");
  return side(true) + side(false);
}

/**
 * Every art image: the mark over a deep violet backdrop (aurora glows,
 * grain, vignette), with a soft halo and two faint orbit rings behind it.
 *
 *   markSize  mark size in vmin
 *   title     name size in vmin (0 = no text at all)
 *   tagline   tagline size in vmin (0 = none)
 *   stacked   name under the mark (else beside it)
 *   centerY   where the lockup sits, % of the height (keep it in the top
 *             two thirds where the Store may overlay the bottom)
 *   lines     side lines' longest length in vw (0 = none)
 *   bar       a branding bar along the bottom (branded key art)
 */
const scene = ({ markSize, title = 0, tagline = 0, stacked = true, centerY = 46, lines = 0, bar = false }) => `<style>${BASE_CSS}
  body {
    position: relative; overflow: hidden;
    background:
      radial-gradient(70vmax 46vmax at 50% ${centerY - 4}%, rgba(139, 92, 246, 0.46), rgba(139, 92, 246, 0) 62%),
      radial-gradient(44vmax 34vmax at 12% 6%, rgba(99, 102, 241, 0.26), rgba(99, 102, 241, 0) 70%),
      radial-gradient(46vmax 34vmax at 92% 14%, rgba(217, 70, 239, 0.18), rgba(217, 70, 239, 0) 70%),
      radial-gradient(60vmax 30vmax at 50% 112%, rgba(76, 29, 149, 0.35), rgba(76, 29, 149, 0) 70%),
      linear-gradient(180deg, #171029 0%, #0c0b14 70%, #09090e 100%);
  }
  body::before {
    content: ""; position: absolute; inset: 0;
    background-image: radial-gradient(rgba(255, 255, 255, 0.07) 0.1vmax, transparent 0.11vmax);
    background-size: 2.2vmax 2.2vmax;
    -webkit-mask-image: radial-gradient(circle at 50% ${centerY}%, #000 0, transparent 58vmax);
  }
  body::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: url("${GRAIN}"), radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0, 0, 0, 0.5) 100%);
    opacity: 0.9; mix-blend-mode: soft-light;
  }
  i { position: absolute; height: 1.7vh; border-radius: 1vh; background: rgba(255, 255, 255, 0.075); }
  .lockup {
    position: absolute; left: 50%; top: ${centerY}%; transform: translate(-50%, -50%);
    display: flex; flex-direction: ${stacked ? "column" : "row"}; align-items: center;
    gap: ${stacked ? markSize * 0.17 : markSize * 0.16}vmin;
  }
  .orbit { position: relative; width: ${markSize}vmin; height: ${markSize}vmin; flex: none; }
  .orbit::before, .orbit::after {
    content: ""; position: absolute; left: 50%; top: 50%; border-radius: 50%;
    transform: translate(-50%, -50%); border: 0.12vmin solid rgba(196, 181, 253, 0.16);
  }
  .orbit::before { width: 168%; height: 168%; }
  .orbit::after { width: 236%; height: 236%; border-color: rgba(196, 181, 253, 0.08); }
  .halo {
    position: absolute; inset: -30%; border-radius: 50%;
    background: radial-gradient(circle, rgba(167, 139, 250, 0.55) 0%, rgba(139, 92, 246, 0.18) 38%, rgba(139, 92, 246, 0) 68%);
    filter: blur(${markSize * 0.06}vmin);
  }
  .mark {
    position: relative; display: block; width: 100%; height: 100%;
    filter: drop-shadow(0 ${markSize * 0.07}vmin ${markSize * 0.14}vmin rgba(36, 11, 92, 0.7)) drop-shadow(0 ${markSize * 0.015}vmin ${markSize * 0.02}vmin rgba(0, 0, 0, 0.35));
  }
  .words { display: flex; flex-direction: column; align-items: ${stacked ? "center" : "flex-start"}; gap: ${tagline * 0.55}vmin; }
  h1 {
    font-size: ${title}vmin; font-weight: 750; letter-spacing: -0.035em; line-height: 1; white-space: nowrap;
    background: linear-gradient(180deg, #ffffff 0%, #ffffff 45%, #d9cdfe 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 0.5vmin 1.2vmin rgba(20, 6, 52, 0.6));
  }
  p { font-size: ${tagline}vmin; font-weight: 500; color: #b9b0da; letter-spacing: 0.005em; white-space: nowrap; }
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 12%;
    background: linear-gradient(90deg, #6d3ae6, #8b5cf6 50%, #6d3ae6);
    box-shadow: inset 0 0.25vmin 0 rgba(255, 255, 255, 0.28);
  }
</style>${lines ? codeLines(lines) : ""}<div class="lockup"><div class="orbit"><div class="halo"></div>${MARK}</div>${
  title ? `<div class="words"><h1>CoreTools</h1>${tagline ? "<p>Offline tools. Private by design.</p>" : ""}</div>` : ""
}</div>${bar ? '<div class="bar"></div>' : ""}`;

// [file, CSS width, CSS height, device scale, page]
const IMAGES = [
  ["tile-300x300.png", 300, 300, 1, tile()],
  ["tile-150x150.png", 150, 150, 1, tile()],
  ["tile-71x71.png", 71, 71, 1, tile()],
  ["box-art-1080x1080.png", 1080, 1080, 1, scene({ markSize: 34, title: 11.5, centerY: 48 })],
  ["box-art-2160x2160.png", 1080, 1080, 2, scene({ markSize: 34, title: 11.5, centerY: 48 })],
  ["poster-art-720x1080.png", 720, 1080, 1, scene({ markSize: 44, title: 14.5, tagline: 4.9, centerY: 44 })],
  ["poster-art-1440x2160.png", 720, 1080, 2, scene({ markSize: 44, title: 14.5, tagline: 4.9, centerY: 44 })],
  // Windows and Xbox: 16:9 super hero art — no text.
  ["super-hero-art-1920x1080.png", 1920, 1080, 1, scene({ markSize: 32, centerY: 40, lines: 20 })],
  ["super-hero-art-3840x2160.png", 1920, 1080, 2, scene({ markSize: 32, centerY: 40, lines: 20 })],
  // Xbox only.
  ["titled-hero-art-1920x1080.png", 1920, 1080, 1, scene({ markSize: 25, title: 15, stacked: false, centerY: 40, lines: 13 })],
  ["promotional-square-art-1080x1080.png", 1080, 1080, 1, scene({ markSize: 34, centerY: 42, lines: 17 })],
  ["branded-key-art-584x800.png", 584, 800, 1, scene({ markSize: 40, title: 14.5, centerY: 40, bar: true })],
];

const browser = await chromium.launch();
try {
  for (const [file, width, height, scale, html] of IMAGES) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const transparent = file.startsWith("tile-");
    await page.screenshot({ path: join(OUT_DIR, file), omitBackground: transparent });
    await context.close();
    console.log(`Wrote microsoftstore/${file} (${width * scale}x${height * scale})`);
  }
} finally {
  await browser.close();
}
