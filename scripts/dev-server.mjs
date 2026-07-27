/**
 * EdgeSync — Minimal static dev server
 * ----------------------------------------------------------------------------
 * Serves /public on http://127.0.0.1:8080.  No framework, no hot reload —
 * just enough to run `npm run serve` and click around in a browser.
 *
 * The service worker only registers on http(s), not file://, so this
 * server is required to exercise SW behavior.
 *
 * Security: bound to `127.0.0.1` only (audit L5 — defaults to `::` on
 * Node 18+, which would expose the dev server on the LAN).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd(), "public");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (url === "/") url = "/index.html";
    const safe = normalize(join(ROOT, url));
    // Use sep-aware comparison so `..` and `%2e%2e` traversals can't
    // escape ROOT on Windows where paths mix `/` and `\\`.
    const withSep = safe.endsWith(sep) ? safe : safe + sep;
    if (!withSep.startsWith(ROOT + sep) && safe !== ROOT) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    const body = await readFile(safe);
    res.writeHead(200, {
      "Content-Type": MIME[extname(safe).toLowerCase()] ?? "application/octet-stream",
      // Service worker must be served same-origin; cache headers off for dev.
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404: " + (req.url ?? "/"));
  }
}).listen(PORT, HOST, () => {
  console.log(`[edgesync] http://${HOST}:${PORT}`);
});
