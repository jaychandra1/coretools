import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests (audit F-17) against the production web build —
 * the same bundle Vercel serves at /app. They exercise the vault through
 * the real UI in a real browser: Argon2id in WebAssembly, IndexedDB, locking.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4180/app/",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite build --mode web && npx vite preview --mode web --port 4180 --strictPort",
    url: "http://localhost:4180/app/",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
