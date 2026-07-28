/**
 * EdgeSync backend — HTTP layer (Phase 1 of the sync backend).
 * ------------------------------------------------------------------------
 * Node stdlib HTTP server that exposes the protocol documented in
 * docs/api.md.  Pure ESM, zero runtime dependencies.
 *
 *   import { startServer } from "./server.mjs";
 *   const srv = await startServer({ port: 8787, dataDir: "./data" });
 *   await srv.close();
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as httpCreate } from "node:http";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage, BadShapeError, isMutableEnvelopeAction } from "./storage.mjs";

const VERSION = "0.1.0";
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB hard ceiling.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

/* -------------------------------------------------------------------------
 * Public entry point
 * ------------------------------------------------------------------------- */

/**
 * @typedef {Object} StartOptions
 * @property {number} [port=8787]
 * @property {string} [host='127.0.0.1']
 * @property {string} dataDir
 * @property {string|null} [authToken=null]      When set, every /api/* requires Bearer
 * @property {Object<string, number>=} [rateLimit]  Override window/max
 */

/**
 * @param {StartOptions} opts
 * @returns {Promise<{ close(): Promise<void>, port: number, storage: Storage, startedAt: number }>}
 */
export async function startServer(opts) {
  if (!opts || !opts.dataDir) {
    throw new Error("startServer requires opts.dataDir");
  }
  const port = Number(opts.port ?? 8787);
  const host = opts.host ?? "127.0.0.1";
  const authToken = opts.authToken ?? null;
  const dataDir = opts.dataDir;

  const storage = new Storage(dataDir);
  await storage.ready();

  const rateMax = opts.rateLimit?.max ?? RATE_LIMIT_MAX;
  const rateWindow = opts.rateLimit?.windowMs ?? RATE_LIMIT_WINDOW_MS;

  /** @type {Map<string, number[]>} */
  const ipHits = new Map();
  const startedAt = Date.now();

  const http = httpCreate(async (req, res) => {
    try {
      await handle(req, res, {
        storage,
        authToken,
        ipHits,
        rateMax,
        rateWindow,
        startedAt,
      });
    } catch (err) {
      // Last-resort guard: an unhandled error in a handler should never
      // take down the connection without a meaningful response.
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal" });
      } else {
        try { res.end(); } catch { /* noop */ }
      }
      console.error("[edgesync] unhandled", err);
    }
  });

  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });

  return {
    port,
    storage,
    startedAt,
    async close() {
      await new Promise((resolve) => http.close(() => resolve()));
      ipHits.clear();
    },
  };
}

/* -------------------------------------------------------------------------
 * Routing / handlers
 * ------------------------------------------------------------------------- */

async function handle(req, res, ctx) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();

  // All /api/* requests need a rate window check.
  if (path.startsWith("/api/")) {
    const allowed = consumeRateToken(ctx.ipHits, clientIp(req), ctx.rateMax, ctx.rateWindow);
    if (!allowed) {
      sendJson(res, 429, { error: "rate_limited", retryAfterMs: ctx.rateWindow });
      return;
    }
    if (path.startsWith("/api/mutations")) {
      if (!ctx.authToken) {
        // Public server: still require Bearer if EDGESYNC_REQUIRE_AUTH=1 was set
        // at the env layer; here we only know about an in-memory token.  No
        // token + no requirement → public.
      } else if (!bearerMatches(req, ctx.authToken)) {
        sendJson(res, 401, { error: "auth" });
        return;
      }
    }
  }

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      uptimeMs: Date.now() - ctx.startedAt,
    });
    return;
  }

  if (method === "GET" && path === "/api/stats") {
    sendJson(res, 200, await ctx.storage.stats());
    return;
  }

  if (method === "GET" && /^\/api\/manifests\/[A-Za-z0-9_-]+$/.test(path)) {
    const id = path.split("/").pop();
    const row = await ctx.storage.getRow("manifest", id);
    if (!row) { sendJson(res, 404, { error: "not_found" }); return; }
    sendJson(res, 200, row);
    return;
  }

  if (method === "POST" && path === "/api/mutations") {
    await handleMutations(req, res, ctx);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function handleMutations(req, res, ctx) {
  const ct = (req.headers["content-type"] || "").toString().toLowerCase();
  if (!ct.includes("application/json")) {
    sendJson(res, 415, { error: "content_type" });
    return;
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) { sendJson(res, 413, { error: "too_large" }); return; }
  if (body.length === 0) { sendJson(res, 400, { error: "empty" }); return; }

  let env;
  try { env = JSON.parse(body); }
  catch { sendJson(res, 400, { error: "shape" }); return; }

  const valid = validateEnvelope(env);
  if (valid !== "ok") { sendJson(res, 400, { error: "shape", detail: valid }); return; }

  // Idempotency: peek the index without writing.  Replays get the
  // canonical row they saw last time, byte-for-byte.
  const prior = await ctx.storage.lookupEnvelope(env.id);
  if (prior !== null) {
    sendJson(res, 200, { replay: true, row: prior });
    return;
  }

  // Apply the mutation.
  let outcome;
  try {
    if (env.action === "delete") {
      const id = env.payload && typeof env.payload.id === "string" ? env.payload.id : null;
      if (!id) { sendJson(res, 400, { error: "shape", detail: "delete payload missing id" }); return; }
      outcome = await ctx.storage.deleteRow(env.entity, id);
    } else {
      outcome = await ctx.storage.applyRow(env.entity, env.payload);
    }
  } catch (err) {
    if (err instanceof BadShapeError) { sendJson(res, 400, { error: "shape", detail: err.message }); return; }
    console.error("[edgesync] apply failed", err);
    sendJson(res, 500, { error: "transient" });
    return;
  }

  if (outcome.status === "conflict") {
    // Persist the canonical row in the idempotency index so replays return it.
    await ctx.storage.rememberEnvelope(env.id, outcome.stored);
    sendJson(res, 409, { serverVersion: outcome.stored.version, serverRow: outcome.stored });
    return;
  }

  if (env.action === "delete" && outcome.status === "missing") {
    sendJson(res, 404, { error: "unknown_envelope_id" });
    return;
  }

  // Record the resulting row in the idempotency index.
  await ctx.storage.rememberEnvelope(env.id, outcome.row);
  sendJson(res, 200, { row: outcome.row });
}

/* -------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

function validateEnvelope(env) {
  if (!env || typeof env !== "object") return "envelope not an object";
  if (typeof env.id !== "string" || env.id.length === 0) return "id missing";
  if (env.entity !== "manifest" && env.entity !== "service_record") return "entity invalid";
  if (!isMutableEnvelopeAction(env.action)) return "action invalid";
  if (typeof env.timestamp !== "number" || !Number.isFinite(env.timestamp)) return "timestamp invalid";
  if (typeof env.status !== "string") return "status invalid";
  if (typeof env.retryCount !== "number") return "retryCount invalid";
  if (typeof env.nextAttemptAt !== "number") return "nextAttemptAt invalid";
  if (!env.payload || typeof env.payload !== "object") return "payload missing";
  if (env.action === "delete") {
    if (typeof env.payload.id !== "string") return "delete payload missing id";
  }
  return "ok";
}

/* -------------------------------------------------------------------------
 * Plumbing
 * ------------------------------------------------------------------------- */

function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

function consumeRateToken(map, ip, max, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = map.get(ip) || [];
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= max) {
    map.set(ip, arr);
    return false;
  }
  arr.push(now);
  map.set(ip, arr);
  return true;
}

function bearerMatches(req, expected) {
  const auth = (req.headers["authorization"] || "").toString();
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return false;
  const got = m[1];
  if (got.length !== expected.length) return false;
  // Both sides are ASCII tokens of equal length; timingSafeEqual is fine.
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on("error", () => resolve(null));
    req.on("end", () => {
      if (tooLarge) resolve(null);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data, "utf8"),
    // Disable HTTP-level caches for the API; the SW owns that.
    "Cache-Control": "no-store",
  });
  res.end(data);
}

/* -------------------------------------------------------------------------
 * Tiny CLI helper (`node backend/server.mjs --port 8787 --datadir ./data`)
 * Runs only when this module is the entry point.  Keeps the event loop
 * alive as long as `srv` is referenced for graceful shutdown.
 * ------------------------------------------------------------------------- */

const isEntry = !!process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url));

if (isEntry) {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.EDGESYNC_TOKEN || args.token || null;
  const port = Number(process.env.PORT || args.port || 8787);
  const host = process.env.HOST || args.host || "127.0.0.1";
  const dataDir = process.env.EDGESYNC_DATA_DIR || args.datadir || "./data";

  const srv = await startServer({ port, host, dataDir, authToken: token });
  console.log(`[edgesync] http://${srv.port} data=${dataDir} auth=${token ? "on" : "off"} v${VERSION}`);

  const shutdown = async (signal) => {
    console.log(`[edgesync] ${signal} received, shutting down`);
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}
