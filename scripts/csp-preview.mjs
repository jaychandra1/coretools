/**
 * Serve a production build (dist/, from `vite build`) with the web app's
 * real Content-Security-Policy from vercel.json, so features that the CSP
 * could block — WebAssembly, workers — can be checked locally before they
 * ship. `vite preview` sends no CSP at all.
 *
 *   npx vite build && node scripts/csp-preview.mjs   → http://localhost:4174/
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const port = Number(process.env.PORT) || 4174;

const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const csp = vercel.headers
  .find((h) => h.source === "/app/:path*")
  .headers.find((h) => h.key === "Content-Security-Policy").value;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist + sep) && file !== dist) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
}).listen(port, () => console.log(`dist/ on http://localhost:${port}/ with CSP: ${csp}`));
