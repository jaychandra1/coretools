/**
 * Microsoft Store listing screenshots (Partner Center → the submission →
 * Store listings → Screenshots), written to microsoftstore/screenshots/ as
 * 1920 × 1080 PNGs — one per tool, filled with made-up demo data (Microsoft's
 * fictional companies: Contoso, Fabrikam, Northwind…). Never anything real.
 *
 * It builds the web version of the app (`vite build --mode web`, the same UI
 * the desktop app shows), serves it locally, drives each tool with
 * Playwright's Chromium and captures it in the dark theme. The header's
 * "Preview" badge reads "Desktop" in the installed app, so the screenshots
 * show that. Captions for each are in microsoftstore/README.md.
 *
 * Run: `node scripts/store-screenshots.mjs` (after `npx playwright install
 * chromium`, which the end-to-end tests need anyway).
 */
import { chromium } from "@playwright/test";
import { build, preview } from "vite";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "microsoftstore", "screenshots");
mkdirSync(OUT_DIR, { recursive: true });

// 1280 × 720 CSS pixels at 1.5× = 1920 × 1080: large enough type for the
// Store's thumbnails, above its 1366 × 768 minimum.
const VIEWPORT = { width: 1280, height: 720 };
const SCALE = 1.5;

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
  await shrink(page, "main textarea", 150);
}

async function ymlValidator(page) {
  await openTab(page, "YML-Validator");
  await page.getByPlaceholder("Paste YAML here, or load a .yaml file…").fill(example("k8s/messy-deployment.yaml"));
  await page.getByRole("button", { name: "Optimize", exact: true }).click();
  await page.getByText("Optimized manifest").waitFor();
  await shrink(page, "main textarea", 150);
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

async function jsonStudio(page) {
  await openTab(page, "JSON-Studio");
  await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 60_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(JSON.stringify(ORDER));
  await page.getByRole("button", { name: "Format", exact: true }).click();
  await page.getByRole("navigation", { name: "Studio tools" }).getByRole("button", { name: "Query" }).click();
  await page.getByRole("textbox", { name: "Query expression" }).fill("$.items[?(@.quantity >= 10)]");
  await toastGone(page, "Formatted");
}

const SHOTS = [
  ["1-diff-checker.png", diffChecker],
  ["2-yml-validator.png", ymlValidator],
  ["3-grammar-polisher.png", grammarPolisher],
  ["4-authenticator.png", authenticator],
  ["5-credential-manager.png", credentialManager],
  ["6-json-studio.png", jsonStudio],
];

// ---- run ------------------------------------------------------------------------

await build({ root, mode: "web", logLevel: "warn" });
const server = await preview({ root, mode: "web", logLevel: "warn", preview: { port: 4182, strictPort: true } });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "dark" });
  // The browser build warns that the browser may evict its storage; the
  // installed app's storage is persistent and never shows that.
  await context.addInitScript(() => {
    if (navigator.storage) navigator.storage.persisted = async () => true;
  });
  const page = await context.newPage();
  await page.goto("http://localhost:4182/app/");
  for (const [file, drive] of SHOTS) {
    await drive(page);
    // What the installed app's header says.
    await page.evaluate(() => {
      const badge = document.querySelector("header .mode");
      if (badge) badge.lastChild.textContent = badge.lastChild.textContent.replace("Preview", "Desktop");
    });
    await page.mouse.move(0, VIEWPORT.height - 1);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT_DIR, file) });
    console.log(`Wrote microsoftstore/screenshots/${file}`);
  }
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
