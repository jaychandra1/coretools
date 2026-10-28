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
 * The mark is the website favicon's (website/index.html) and the type is the
 * website's own Inter (website/assets/fonts), so the listing matches the
 * site and the app. Unlike the other generate-* scripts this needs real,
 * anti-aliased type, so it draws with the Chromium that Playwright installs
 * for the end-to-end tests (`npx playwright install chromium` if missing).
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

// The favicon, drawn at any size.
const MARK =
  '<svg class="mark" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="32" height="32" rx="7" fill="#8b5cf6"/>' +
  '<rect x="7" y="7" width="8" height="18" rx="1.5" fill="#fff"/>' +
  '<rect x="17" y="7" width="8" height="18" rx="1.5" fill="#fff" fill-opacity="0.55"/>' +
  "</svg>";

const BASE_CSS = `
  @font-face { font-family: "Inter"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body { font-family: "Inter", sans-serif; color: #edeff4; -webkit-font-smoothing: antialiased; }
`;

/** Store display images: the mark alone, edge to edge, corners transparent. */
const tile = () => `<style>${BASE_CSS} body { background: transparent; } .mark { display: block; width: 100%; height: 100%; }</style>${MARK}`;

/**
 * Box and poster art: the mark over the website's dark canvas with a violet
 * glow, the name under it (and, on the taller poster, the tagline). Sizes
 * are fractions of the width so 1x and 2x match exactly.
 */
const art = ({ markSize, title, tagline }) => `<style>${BASE_CSS}
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background:
      radial-gradient(circle at 50% 42%, rgba(139, 92, 246, 0.34) 0, rgba(139, 92, 246, 0) 46vw),
      linear-gradient(180deg, #1a122a 0%, #0b0d12 100%);
  }
  .mark { width: ${markSize}vw; height: ${markSize}vw; filter: drop-shadow(0 2.2vw 4.4vw rgba(0, 0, 0, 0.45)); }
  h1 { margin-top: 6.5vw; font-size: ${title}vw; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  p { margin-top: 3.4vw; font-size: ${tagline}vw; font-weight: 500; color: #a9a3c4; letter-spacing: -0.005em; }
</style>${MARK}<h1>CoreTools</h1>${tagline ? "<p>Offline tools. Private by design.</p>" : ""}`;

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
          lit === 1 ? "background: rgba(139, 92, 246, 0.55)" : lit === 2 ? "background: rgba(203, 182, 251, 0.35)" : "",
        ];
        return `<i style="${style.filter(Boolean).join("; ")}"></i>`;
      })
      .join("");
  return side(true) + side(false);
}

/**
 * Wide and square promotional art. `title` adds the name beside the mark
 * (titled hero art, branded key art); without it there is no text at all
 * (super hero art, promotional square). Everything sits in the top two
 * thirds. `lines` is the side lines' longest length in vw (0 = none) and
 * `bar` adds a branding bar along the bottom (branded key art).
 */
const promo = ({ markSize, title, lines = 0, bar, stacked }) => `<style>${BASE_CSS}
  body {
    position: relative; overflow: hidden;
    background:
      radial-gradient(circle at 50% 40%, rgba(139, 92, 246, 0.4) 0, rgba(139, 92, 246, 0) 42vmax),
      radial-gradient(circle at 16% 18%, rgba(167, 139, 250, 0.12) 0, rgba(167, 139, 250, 0) 26vmax),
      radial-gradient(circle at 86% 26%, rgba(99, 102, 241, 0.12) 0, rgba(99, 102, 241, 0) 28vmax),
      linear-gradient(180deg, #1a122a 0%, #0b0d12 100%);
  }
  body::before {
    content: ""; position: absolute; inset: 0;
    background-image: radial-gradient(rgba(255, 255, 255, 0.08) 0.11vmax, transparent 0.12vmax);
    background-size: 2.2vmax 2.2vmax;
    -webkit-mask-image: radial-gradient(circle at 50% 40%, #000 0, transparent 62vmax);
  }
  i { position: absolute; height: 1.7vh; border-radius: 1vh; background: rgba(255, 255, 255, 0.08); }
  .lockup {
    position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%);
    display: flex; flex-direction: ${stacked ? "column" : "row"}; align-items: center; gap: ${stacked ? 4 : 3}vmax;
  }
  .mark { width: ${markSize}vmin; height: ${markSize}vmin; flex: none; filter: drop-shadow(0 1.6vmax 3.2vmax rgba(0, 0, 0, 0.5)); }
  h1 { font-size: ${title}vmin; font-weight: 700; letter-spacing: -0.03em; line-height: 1; white-space: nowrap; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 12%; background: #8b5cf6; }
</style>${lines ? codeLines(lines) : ""}<div class="lockup">${MARK}${title ? "<h1>CoreTools</h1>" : ""}</div>${bar ? '<div class="bar"></div>' : ""}`;

// [file, CSS width, CSS height, device scale, page]
const IMAGES = [
  ["tile-300x300.png", 300, 300, 1, tile()],
  ["tile-150x150.png", 150, 150, 1, tile()],
  ["tile-71x71.png", 71, 71, 1, tile()],
  ["box-art-1080x1080.png", 1080, 1080, 1, art({ markSize: 36, title: 11.5 })],
  ["box-art-2160x2160.png", 1080, 1080, 2, art({ markSize: 36, title: 11.5 })],
  ["poster-art-720x1080.png", 720, 1080, 1, art({ markSize: 46, title: 15, tagline: 5.2 })],
  ["poster-art-1440x2160.png", 720, 1080, 2, art({ markSize: 46, title: 15, tagline: 5.2 })],
  // Windows and Xbox: 16:9 super hero art — no text.
  ["super-hero-art-1920x1080.png", 1920, 1080, 1, promo({ markSize: 30, lines: 20 })],
  ["super-hero-art-3840x2160.png", 1920, 1080, 2, promo({ markSize: 30, lines: 20 })],
  // Xbox only.
  ["titled-hero-art-1920x1080.png", 1920, 1080, 1, promo({ markSize: 24, title: 15, lines: 13 })],
  ["promotional-square-art-1080x1080.png", 1080, 1080, 1, promo({ markSize: 36, lines: 18 })],
  ["branded-key-art-584x800.png", 584, 800, 1, promo({ markSize: 40, title: 15, stacked: true, bar: true })],
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
