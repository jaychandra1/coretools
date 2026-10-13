import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tests run in plain Node: the core logic is framework-agnostic, and the
// rune-based stores (`*.svelte.ts`) are compiled by the Svelte plugin so the
// vault, backup and credential state machines can be tested directly. Store
// tests bring their own IndexedDB (`fake-indexeddb/auto`).
export default defineConfig({
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
