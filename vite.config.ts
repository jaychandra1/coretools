import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri expects a fixed dev-server port. `TAURI_DEV_HOST` is injected by the
// Tauri CLI when developing against a physical device; it is otherwise unset.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // Prevent Vite from clearing Rust compiler errors printed by the Tauri CLI.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    // Never let Vite watch the Rust source tree.
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
