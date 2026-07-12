#!/usr/bin/env node
// Local static preview for the Optriva frontend build — lets Dylan look at
// what a website-redesign mission produced BEFORE it's deployed to the live
// VPS. Serves ~/optriva-website/frontend/build with SPA fallback (so client
// routes like /pricing, /admin work on direct load, same as Caddy's
// try_files). Always reflects whatever is currently in build/ — no caching,
// so a rebuild is visible on refresh with no server restart needed.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = "/Users/dylanthomas/optriva-website/frontend/build";
const PORT = 4173;

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  try {
    let filePath = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    let st = await stat(filePath).catch(() => null);
    if (!st || st.isDirectory()) filePath = path.join(ROOT, "index.html"); // SPA fallback
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`preview server up on http://localhost:${PORT}`));
