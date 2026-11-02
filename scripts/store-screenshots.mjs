/**
 * Microsoft Store listing screenshots (Partner Center → the submission →
 * Store listings → Screenshots), written to microsoftstore/screenshots/ as
 * 2560 × 1440 PNGs, filled with made-up demo data (Microsoft's fictional
 * companies: Contoso, Fabrikam, Northwind…). Never anything real.
 *
 * It builds the web version of the app (`vite build --mode web`, the same UI
 * the desktop app shows), serves it locally, drives each tool with
 * Playwright's Chromium and captures it at a desktop window's size. Each
 * capture is then shown as the app's window — a Windows 11 title bar with
 * the app's own icon and name — over the brand's dark violet backdrop. No
 * other text or logos are added (Microsoft's screenshot guidelines); the
 * captions go in Partner Center (microsoftstore/README.md lists them).
 * The header's "Preview" badge reads "Desktop" in the installed app, and the
 * browser-only storage warning never shows there, so neither shows here.
 *
 * Run: `node scripts/store-screenshots.mjs` (after `npx playwright install
 * chromium`, which the end-to-end tests need anyway). The title bar uses
 * Segoe UI, as Windows does, when the machine has it.
 */
import { chromium } from "@playwright/test";
import { build, preview } from "vite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "microsoftstore", "screenshots");
mkdirSync(OUT_DIR, { recursive: true });
for (const old of readdirSync(OUT_DIR).filter((file) => file.endsWith(".png"))) rmSync(join(OUT_DIR, old));

// The app window's content area, in CSS pixels, drawn at 2× — about the
// app's default window size (1100 × 760 in tauri.conf.json), 16:9.
const WINDOW = { width: 1120, height: 620 };
// The finished image: 1280 × 720 CSS at 2× = 2560 × 1440 (the Store takes
// 1366 × 768 up to 3840 × 2160).
const CANVAS = { width: 1280, height: 720 };
const SCALE = 2;

/** A throwaway master password for the demo vault (fresh browser profile). */
const DEMO_PASSWORD = "lantern orchard copper seventy";

/** A random demo 2FA secret (base32): codes that look real and belong to nothing. */
function demoSecret() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return [...randomBytes(20)].map((byte) => alphabet[byte % 32]).join("");
}

const example = (path) => readFileSync(join(root, "examples", path), "utf8");

// ---- the tools ------------------------------------------------------------------

async function openTab(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
}

/** Resize text boxes the way their resize handle does, scrolled to the top. */
async function shrink(page, selector, height) {
  await page.locator(selector).evaluateAll((boxes, px) => {
    for (const box of boxes) {
      box.style.height = `${px}px`;
      box.scrollTop = 0;
    }
  }, height);
}

/** Wait out a confirmation toast ("Account added") so it isn't in the shot. */
async function toastGone(page, text) {
  await page.getByText(text, { exact: true }).waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
}

async function diffChecker(page) {
  await openTab(page, "Diff-Checker");
  const [original, modified] = await page.locator("main textarea").all();
  await original.fill(example("diff/nginx.original.conf"));
  await modified.fill(example("diff/nginx.modified.conf"));
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Keep all modified" }).waitFor();
  await shrink(page, "main textarea", 110);
}

async function ymlValidator(page) {
  await openTab(page, "YML-Validator");
  await page.getByPlaceholder("Paste YAML here, or load a .yaml file…").fill(example("k8s/messy-deployment.yaml"));
  await page.getByRole("button", { name: "Optimize", exact: true }).click();
  await page.getByText("Optimized manifest").waitFor();
  await shrink(page, "main textarea", 110);
}

const EMAIL = `hey team,

The the quarterly report is due tommorow and we recieve feedback from the client alot. Its a good idea to review the numbers together before we send it!!

cheers`;

async function grammarPolisher(page) {
  await openTab(page, "Grammar-Polisher");
  await page.getByText("It's an email").click();
  await page.getByRole("textbox", { name: "Your text" }).fill(EMAIL);
  // The grammar engine (WebAssembly) loads on first use.
  await page.getByRole("button", { name: "tomorrow", exact: true }).waitFor({ timeout: 60_000 });
}

const CASUAL = `hey Jordan,

can u send me the Q3 numbers asap? it's for the client meeting tmrw. thx!

cheers`;

async function grammarRewrite(page) {
  await page.getByRole("textbox", { name: "Your text" }).fill(CASUAL);
  await page.getByRole("radio", { name: "Professional" }).click();
  // The rewrite opens under the editor: bring it into view.
  await page.getByRole("button", { name: "Use this version" }).evaluate((button) => button.scrollIntoView({ block: "end" }));
}

const ACCOUNTS = [
  ["Contoso", "alex@contoso.com"],
  ["Fabrikam", "alex.kim@fabrikam.com"],
  ["Northwind Traders", "akim"],
  ["Tailspin Toys", "alex@tailspintoys.com"],
  ["Wide World Importers", "alex.kim"],
  ["Adventure Works", "alex@adventure-works.com"],
];

async function createVault(page) {
  await openTab(page, "Authenticator");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByPlaceholder(/New password/).fill(DEMO_PASSWORD);
  await page.getByPlaceholder("Confirm new password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Set password & encrypt" }).click();
  await page.getByText("Secrets are encrypted at rest.").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close dialog" }).click();
}

async function authenticator(page) {
  await createVault(page);
  for (const [issuer, account] of ACCOUNTS) {
    await page.getByRole("button", { name: "+ Add" }).click();
    await page.getByRole("button", { name: "Manual entry" }).click();
    await page.getByPlaceholder("GitHub").fill(issuer);
    await page.getByPlaceholder("user@example.com").fill(account);
    await page.getByPlaceholder("JBSW Y3DP EHPK 3PXP").fill(demoSecret());
    await page.getByRole("button", { name: "Add account" }).last().click();
    await page.getByText(issuer, { exact: true }).first().waitFor();
  }
  await page.getByRole("button", { name: "Dismiss backup reminder" }).click();
  await toastGone(page, "Account added");
  // Fresh codes with most of their 30 seconds left, not about to roll over.
  const into = (Date.now() / 1000) % 30;
  if (into > 6) await page.waitForTimeout((30 - into + 2) * 1000);
}

const LOGINS = [
  // platform, URL, username, category, owner, tags
  ["Contoso Cloud Console", "https://console.contoso.com", "alex.admin", "Cloud", "Platform team", "prod, infra"],
  ["Fabrikam CI", "https://ci.fabrikam.com", "build-bot", "DevOps", "Platform team", "ci"],
  ["Northwind Database", "https://db.northwindtraders.com", "dba-readonly", "Database", "Data team", "prod"],
  ["Tailspin Mail", "https://mail.tailspintoys.com", "alex@tailspintoys.com", "Email", "Alex Kim", ""],
  ["Adventure Works HR", "https://hr.adventure-works.com", "alex.kim", "HR", "Alex Kim", ""],
];

async function credentialManager(page) {
  // The vault exists already (Authenticator above).
  await openTab(page, "Credential-Manager");
  for (const [platform, url, username, category, owner, tags] of LOGINS) {
    await page.getByRole("button", { name: "+ Add credential" }).click();
    await page.getByPlaceholder("AWS Production").fill(platform);
    await page.getByPlaceholder("https://console.aws.amazon.com").fill(url);
    await page.getByPlaceholder("devops-admin").fill(username);
    await page.getByRole("button", { name: "Generate" }).click();
    await page.getByPlaceholder("Cloud").fill(category);
    await page.getByPlaceholder("Platform team").fill(owner);
    await page.getByPlaceholder("prod, infra").fill(tags);
    await page.getByRole("button", { name: "Add credential" }).last().click();
    await page.getByText(platform, { exact: true }).first().waitFor();
  }
  await toastGone(page, "Credential added");
}

const ORDER = {
  order: "NW-10248",
  customer: { name: "Northwind Traders", country: "Germany", vip: true },
  items: [
    { sku: "CHAI-01", name: "Chai", quantity: 12, price: 18 },
    { sku: "CHNG-02", name: "Chang", quantity: 10, price: 19 },
    { sku: "ANIS-03", name: "Aniseed Syrup", quantity: 5, price: 10 },
  ],
  shipping: { method: "express", address: { city: "Berlin", postcode: "10115" } },
  paid: true,
};

const studioTool = (page, name) =>
  page.getByRole("navigation", { name: "Studio tools" }).getByRole("button", { name, exact: true }).click();

async function jsonStudio(page) {
  await openTab(page, "JSON-Studio");
  await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 60_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(JSON.stringify(ORDER));
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await studioTool(page, "Query");
  await page.getByRole("textbox", { name: "Query expression" }).fill("$.items[?(@.quantity >= 10)]");
  await toastGone(page, "Formatted");
}

async function jsonTree(page) {
  await studioTool(page, "Tree");
  // Open the first order line too, so the tree shows a few levels.
  await page.getByRole("button", { name: "Expand" }).first().click().catch(() => {});
}

/** A made-up Contoso access token: realistic claims, random signature bytes. */
function demoJwt() {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return [
    part({ alg: "RS256", typ: "JWT", kid: "contoso-2026" }),
    part({ iss: "https://login.contoso.com", sub: "alex@contoso.com", name: "Alex Kim", aud: "api://payments", scope: "orders.read orders.write", iat: now - 600, exp: now + 3000 }),
    randomBytes(256).toString("base64url"),
  ].join(".");
}

async function codec(page) {
  await openTab(page, "Codec");
  await page.getByRole("tab", { name: "Inspect" }).click();
  await page.locator(".toollist").getByRole("button", { name: "JWT Decoder" }).click();
  await page.getByRole("textbox", { name: "Input text" }).fill(demoJwt());
  await page.getByText("Not expired").waitFor();
  // Typing scrolled down; show Codec's header and privacy notice.
  await page.evaluate(() => {
    document.querySelector("main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
}

async function lightTheme(page) {
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await openTab(page, "Credential-Manager");
}

const SHOTS = [
  ["01-diff-checker.png", diffChecker],
  ["02-yml-validator.png", ymlValidator],
  ["03-grammar-polisher.png", grammarPolisher],
  ["04-grammar-rewrite.png", grammarRewrite],
  ["05-authenticator.png", authenticator],
  ["06-credential-manager.png", credentialManager],
  ["07-json-studio-query.png", jsonStudio],
  ["08-json-studio-tree.png", jsonTree],
  ["09-codec.png", codec],
  ["10-light-theme.png", lightTheme],
];

// ---- the window frame -----------------------------------------------------------

const appIcon = readFileSync(join(root, "src-tauri", "icons", "32x32.png")).toString("base64");

// Film grain over the backdrop, as on the Store art (scripts/generate-store-art.mjs).
const GRAIN =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
  );

// Windows 11's caption buttons: minimize, maximize, close.
const CAPTION = [
  '<path d="M0 5h10"/>',
  '<rect x="0.5" y="0.5" width="9" height="9" rx="1.5"/>',
  '<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>',
]
  .map((glyph) => `<div><svg viewBox="0 0 10 10">${glyph}</svg></div>`)
  .join("");

/** The capture as the app's window on the brand backdrop. */
const framed = (shot, light) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    position: relative; overflow: hidden;
    background:
      radial-gradient(900px 520px at 50% 40%, rgba(139, 92, 246, 0.42), rgba(139, 92, 246, 0) 65%),
      radial-gradient(620px 420px at 8% 4%, rgba(99, 102, 241, 0.3), rgba(99, 102, 241, 0) 70%),
      radial-gradient(640px 420px at 94% 10%, rgba(217, 70, 239, 0.2), rgba(217, 70, 239, 0) 70%),
      radial-gradient(800px 360px at 50% 115%, rgba(76, 29, 149, 0.45), rgba(76, 29, 149, 0) 70%),
      linear-gradient(180deg, #171029 0%, #0c0b14 75%, #09090e 100%);
  }
  body::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: url("${GRAIN}"); opacity: 0.85; mix-blend-mode: soft-light;
  }
  .window {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 1;
    width: ${WINDOW.width}px; border-radius: 9px; overflow: hidden;
    background: ${light ? "#f3f3f3" : "#1f1f23"};
    box-shadow:
      0 0 0 1px ${light ? "rgba(0, 0, 0, 0.25)" : "rgba(255, 255, 255, 0.11)"},
      0 30px 80px rgba(6, 2, 18, 0.7), 0 10px 24px rgba(0, 0, 0, 0.4),
      0 0 120px rgba(139, 92, 246, 0.18);
  }
  .titlebar {
    height: 32px; display: flex; align-items: center;
    color: ${light ? "#1a1a1a" : "#f3f3f3"};
    font: 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  }
  .titlebar img { width: 16px; height: 16px; margin: 0 10px 0 12px; }
  .caption { margin-left: auto; display: flex; height: 100%; }
  .caption div { width: 46px; display: grid; place-items: center; }
  .caption svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; opacity: 0.9; }
  .shot { display: block; width: ${WINDOW.width}px; height: ${WINDOW.height}px; }
</style></head><body><div class="window">
  <div class="titlebar"><img src="data:image/png;base64,${appIcon}" alt=""><span>CoreTools</span><div class="caption">${CAPTION}</div></div>
  <img class="shot" src="data:image/png;base64,${shot}" alt="">
</div></body></html>`;

// ---- run ------------------------------------------------------------------------

await build({ root, mode: "web", logLevel: "warn" });
const server = await preview({ root, mode: "web", logLevel: "warn", preview: { port: 4182, strictPort: true } });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: WINDOW, deviceScaleFactor: SCALE, colorScheme: "dark" });
  // The browser build warns that the browser may evict its storage; the
  // installed app's storage is persistent and never shows that.
  await context.addInitScript(() => {
    if (navigator.storage) navigator.storage.persisted = async () => true;
  });
  const page = await context.newPage();
  await page.goto("http://localhost:4182/app/");

  const frameContext = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: SCALE });
  const frame = await frameContext.newPage();

  for (const [file, drive] of SHOTS) {
    await drive(page);
    // What the installed app says: "Desktop" in the header, and Codec's
    // notice reads "on this device" rather than the browser build's wording.
    await page.evaluate(() => {
      const badge = document.querySelector("header .mode");
      if (badge) badge.lastChild.textContent = badge.lastChild.textContent.replace("Preview", "Desktop");
      for (const line of document.querySelectorAll(".codec .privacy span")) {
        for (const node of line.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) node.textContent = node.textContent.replace("in your browser", "on this device");
        }
      }
    });
    await page.mouse.move(0, WINDOW.height - 1);
    await page.waitForTimeout(600);
    const shot = (await page.screenshot()).toString("base64");
    const light = await page.evaluate(() => document.documentElement.dataset.theme === "light");
    await frame.setContent(framed(shot, light));
    await frame.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
    writeFileSync(join(OUT_DIR, file), await frame.screenshot());
    console.log(`Wrote microsoftstore/screenshots/${file}`);
  }
  await frameContext.close();
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
