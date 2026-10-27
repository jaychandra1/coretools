import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Single-sourced from package.json (see scripts/sync-version.mjs); shown in
// the app header so bug reports can be tied to a build.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

// Tauri expects a fixed dev-server port. `TAURI_DEV_HOST` is injected by the
// Tauri CLI when developing against a physical device; it is otherwise unset.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
//
// Two build targets share this config, selected by Vite's `--mode`:
//   • default (production) → for the Tauri desktop bundle. Served from the
//     bundle root, so base="/" and output goes to `dist/`.
//   • `--mode web`         → for the public web deploy (Vercel), where the app
//     is hosted under the "/app" path alongside the marketing site. Output goes
//     to `dist/app/` so the marketing files can sit at `dist/` root.
export default defineConfig(({ mode }) => {
  const isWeb = mode === "web";
  return {
    plugins: [svelte()],
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    base: isWeb ? "/app/" : "/",
    // Prevent Vite from clearing Rust compiler errors printed by the Tauri CLI.
    clearScreen: false,
    build: {
      outDir: isWeb ? "dist/app" : "dist",
      emptyOutDir: true,
    },
    // The writing checker's worker (src/lib/writing/checker.worker.ts) loads
    // Harper, which splits into chunks: only ES-module workers can.
    worker: { format: "es" },
    // Harper finds its WebAssembly file next to its own module
    // (new URL(..., import.meta.url)); pre-bundling would move the module.
    optimizeDeps: { exclude: ["harper.js"] },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      // Never let Vite watch the Rust source tree.
      watch: { ignored: ["**/src-tauri/**"] },
    },
  };
});
