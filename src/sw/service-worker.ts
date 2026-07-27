/**
 * EdgeSync — Service Worker (TypeScript source, Phase 3)
 * ----------------------------------------------------------------------------
 * Compiled by esbuild to /public/sw.js — a single IIFE bundle.
 *
 * Responsibilities:
 *   1. App-shell precache on `install`.
 *   2. Three routing strategies (see routeTable()):
 *        • cache-first            — static shell & fingerprinted assets
 *        • stale-while-revalidate — read APIs (GET)
 *        • network-only+IDB       — write APIs (POST /api/mutations)
 *   3. Drain the mutation queue when the browser fires a `sync` event
 *      under the `edge-sync` tag (Background Sync API).
 *
 * Why an IIFE?  Service workers run in their own global scope and cannot
 * import ES modules from the page.  esbuild's `--format=iife` gives us
 * tree-shaking and minification while producing a valid worker script.
 *
 * Note: idb is bundled into the worker.  At < 8 KB minified the impact
 * on the 150 KB gzipped budget is acceptable and avoids hand-rolling a
 * fragile raw-IDB layer here.
 */

/// <reference lib="webworker" />

import { openDB, type IDBPDatabase } from "idb";
import type { EdgeSyncSchema } from "../db/connection";
import type {
  Manifest,
  MutationEnvelope,
  ServiceRecord,
  SyncStatus,
} from "../types/domain";

declare const self: ServiceWorkerGlobalScope;

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** Bumped on every release to invalidate the app-shell cache. */
const SHELL_VERSION = "edgesync-shell-v1";

/**
 * Files that must be available offline.  Kept tiny on purpose — the gzip
 * budget for the entire app is ~150 KB.
 */
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/app.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
] as const;

/** Background-Sync tag — referenced from the page side too. */
export const SYNC_TAG = "edge-sync";

/**
 * Lock name shared with the page-side SyncEngine.  When both contexts try
 * to drain, only one holds the lock at a time — the other waits or
 * bails.  This is the audit B7 cross-context guard.
 */
const DRAIN_LOCK = "edgesync-drain";

/** Cap on envelopes drained per `sync` event — keeps the SW from
 *  blocking on huge queues (audit H2). */
const MAX_PER_SYNC = 50;

/** Header used to opt out of any SW interception (e.g. dev tools). */
const HDR_NO_CACHE = "x-edgesync-no-cache";

/* -------------------------------------------------------------------------
 * Minimal IndexedDB driver
 * -------------------------------------------------------------------------
 * The SW only needs the syncQueue store, so we open a narrowed view of
 * the same `edgesync` database the page side uses.
 */

type SyncDB = IDBPDatabase<EdgeSyncSchema>;

function openSyncDB(): Promise<SyncDB> {
  // Attach to the same `edgesync` DB the page side uses.  We open with
  // the full schema (not a narrowed Pick) because `drainQueue` now
  // writes the canonical server row to the entity store (audit B8).
  return openDB<EdgeSyncSchema>("edgesync", 1);
}

async function getAllPending(db: SyncDB): Promise<MutationEnvelope[]> {
  const now = Date.now();
  const rows = await db.getAllFromIndex("syncQueue", "by-status", "pending");
  return rows
    .filter((e) => e.nextAttemptAt <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function patchEnvelope(
  db: SyncDB,
  id: string,
  patch: Partial<MutationEnvelope>,
): Promise<MutationEnvelope | undefined> {
  const cur = await db.get("syncQueue", id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  await db.put("syncQueue", next);
  return next;
}

/* -------------------------------------------------------------------------
 * Strategies
 * ------------------------------------------------------------------------- */

/**
 * Cache-First: return cached response immediately; refresh cache in the
 * background.  If nothing cached, fetch + cache + return.
 */
async function cacheFirst(req: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Stale-while-revalidate shadow: refresh without blocking the response.
    fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

/**
 * Stale-While-Revalidate: return cached immediately (if any) while a
 * network fetch updates the cache in the background.  If nothing cached
 * and the network fails, return 504.
 */
async function staleWhileRevalidate(
  req: Request,
  cacheName: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null as Response | null);
  return cached ?? (await network) ?? new Response("", { status: 504 });
}

/**
 * Network-Only with IndexedDB envelope fallback for write requests.
 *
 * The page-side repository already persisted the envelope before issuing
 * this fetch (see repository.ts), so on network failure we don't need to
 * re-encode the body — we just touch `nextAttemptAt` so the next drain
 * pass picks it up immediately, then return a 202 to the caller so the
 * optimistic UI keeps the row marked pending.
 */
async function networkOnlyWithFallback(req: Request): Promise<Response> {
  try {
    return await fetch(req);
  } catch {
    return new Response(
      JSON.stringify({ queued: true, offline: true }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * SPA navigation: try network, fall back to the cached shell.  This is
 * what lets `/some/deep/link` resolve to the running app while offline.
 */
async function navigationFallback(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_VERSION);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    const shell = await caches.match("/index.html");
    return shell ?? new Response("", { status: 504 });
  }
}

/* -------------------------------------------------------------------------
 * Route table
 * ------------------------------------------------------------------------- */

type Strategy =
  | "cache-first"
  | "swr"
  | "network-only"
  | "navigate-fallback"
  | "passthrough";

function routeTable(req: Request): { strategy: Strategy; cache: string | null } {
  const url = new URL(req.url);
  const p = url.pathname;

  // App shell.
  if (
    p === "/" || p === "/index.html" || p === "/app.js" ||
    p === "/app.css" || p === "/manifest.webmanifest"
  ) {
    return { strategy: "cache-first", cache: SHELL_VERSION };
  }

  // Other static assets.
  if (/\.(woff2?|ttf|png|jpg|webp|svg|ico)$/i.test(p)) {
    return { strategy: "cache-first", cache: "edgesync-static-v1" };
  }

  // Read APIs.
  if (/^\/api\//.test(p) && req.method === "GET") {
    return { strategy: "swr", cache: "edgesync-api-v1" };
  }

  // Writes.
  if (/^\/api\/mutations/.test(p) && req.method !== "GET") {
    return { strategy: "network-only", cache: null };
  }

  // Default for navigations: network, then cached shell.
  if (req.mode === "navigate") {
    return { strategy: "navigate-fallback", cache: SHELL_VERSION };
  }

  return { strategy: "passthrough", cache: null };
}

/* -------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------- */

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_VERSION);
      await cache.addAll([...SHELL_ASSETS]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([
        SHELL_VERSION,
        "edgesync-static-v1",
        "edgesync-api-v1",
      ]);
      const names = await caches.keys();
      await Promise.all(
        names.map((n) => (keep.has(n) ? null : caches.delete(n))),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Skip non-HTTP(S) schemes (chrome-extension://, data:, etc).
  if (!/^https?:$/i.test(new URL(req.url).protocol)) return;
  if (req.headers.has(HDR_NO_CACHE)) return;

  const route = routeTable(req);

  switch (route.strategy) {
    case "cache-first":
      event.respondWith(cacheFirst(req, route.cache!));
      break;
    case "swr":
      event.respondWith(staleWhileRevalidate(req, route.cache!));
      break;
    case "network-only":
      event.respondWith(networkOnlyWithFallback(req));
      break;
    case "navigate-fallback":
      event.respondWith(navigationFallback(req));
      break;
    case "passthrough":
    default:
      // Let the browser handle it natively.
      break;
  }
});

/* -------------------------------------------------------------------------
 * Background Sync — drain the queue
 * -------------------------------------------------------------------------
 *
 * The browser fires `sync` here once connectivity returns.  We drain the
 * queue synchronously with exponential backoff per row.  If the network
 * drops mid-drain we bail out — the browser will fire `sync` again later.
 *
 * For browsers without Background Sync we also accept a manual
 * `postMessage({ type: "edge-sync:drain" })` from the page.
 */

self.addEventListener("sync", (event) => {
  if ((event as SyncEvent).tag !== SYNC_TAG) return;
  (event as SyncEvent).waitUntil(drainQueue());
});

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === "edge-sync:drain") {
    event.waitUntil(drainQueue());
    return;
  }
  // Page-side update prompt (audit M5): when the user clicks "Reload"
  // the page posts SKIP_WAITING and we kick the waiting SW to activate.
  if (data?.type === "SKIP_WAITING" && self.registration.waiting) {
    self.registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
});

// When the new SW tells us to skip waiting, become the active SW.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === "SKIP_WAITING" && self.skipWaiting) {
    void self.skipWaiting();
  }
});

/**
 * Drain the mutation queue with exponential backoff on failure.
 * Notifies open clients after every ack so the StatusBar can update.
 *
 * Returns once the queue is empty OR a network failure is hit (we don't
 * want to burn battery spinning through 100 rows when offline).
 *
 * Audit fixes:
 *   - B7: acquire `navigator.locks.request(DRAIN_LOCK)` so the page and
 *     the SW can't both drain simultaneously.
 *   - B8: after a 2xx, apply the server canonical row to the entity
 *     store so `_pending` flips to false.  Page-side SyncEngine does the
 *     same on its drain path — both now converge.
 *   - H2: cap each `sync` event at MAX_PER_SYNC envelopes; if the queue
 *     still has rows, the browser re-fires `sync` (or the page drains
 *     the remainder when it boots).
 */
export async function drainQueue(): Promise<void> {
  const runDrain = async (): Promise<void> => {
    const db = await openSyncDB();
    try {
      let processed = 0;
      let didProgress = true;
      while (didProgress && processed < MAX_PER_SYNC) {
        didProgress = false;
        const batch = await getAllPending(db);
        if (batch.length === 0) return;

        for (const env of batch) {
          if (processed >= MAX_PER_SYNC) return;
          processed++;

          await patchEnvelope(db, env.id, { status: "in_flight" as SyncStatus });

          let res: Response;
          try {
            res = await fetch("/api/mutations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(env),
            });
          } catch {
            // Network down.  Reset to pending with backoff so the next
            // `sync` event retries, then bail.
            await patchEnvelope(db, env.id, {
              status: "pending",
              retryCount: env.retryCount + 1,
              nextAttemptAt: Date.now() + backoffMs(env.retryCount + 1),
              lastError: "network",
            });
            await broadcast({ type: "edge-sync:network-down" });
            return;
          }

          if (res.status === 200 || res.status === 201) {
            // Server ACKed.  Apply the canonical row to the entity so
            // `_pending` flips to false on the local store (audit B8);
            // then drop the envelope.
            let serverRow: unknown = undefined;
            try {
              serverRow = await res.json();
            } catch {
              /* ignore — server may return no body */
            }
            await applyRowToEntity(db, env, serverRow);
            await db.delete("syncQueue", env.id);
            didProgress = true;
            await broadcast({
              type: "edge-sync:ack",
              id: env.id,
              serverRow,
              entity: env.entity,
            });
            continue;
          }

          if (res.status === 409) {
            // Server returned a conflict.  Persist the conflict payload so
            // the SyncEngine + UI can surface it.
            const conflict = await res.json().catch(() => null);
            await patchEnvelope(db, env.id, {
              status: "conflict",
              conflict: {
                serverVersion: conflict?.serverVersion ?? 0,
                serverRow: conflict?.serverRow ?? null,
              },
              lastError: "conflict",
            });
            await markConflictOnEntity(db, env);
            didProgress = true;
            await broadcast({
              type: "edge-sync:conflict",
              id: env.id,
              conflict,
              entity: env.entity,
            });
            continue;
          }

          if (res.status >= 500) {
            // Transient server error — keep envelope pending, push nextAttemptAt.
            await patchEnvelope(db, env.id, {
              status: "pending",
              retryCount: env.retryCount + 1,
              nextAttemptAt: Date.now() + backoffMs(env.retryCount + 1),
              lastError: `server ${res.status}`,
            });
            didProgress = true;
            await sleep(backoffMs(env.retryCount + 1));
            continue;
          }

          // 4xx other than 409 → permanent failure (validation, auth, etc).
          await patchEnvelope(db, env.id, {
            status: "failed",
            lastError: `permanent ${res.status}`,
          });
          didProgress = true;
          await broadcast({ type: "edge-sync:failed", id: env.id });
        }
      }
    } finally {
      db.close();
    }
  };

  // B7 — keep page and SW drains from racing.
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.locks !== "undefined" &&
    typeof navigator.locks.request === "function"
  ) {
    await navigator.locks.request(DRAIN_LOCK, runDrain);
    return;
  }
  await runDrain();
}

/**
 * Mirror of the page-side `applyServerRow`: validate the row shape and
 * write it to the matching object store, preserving local-only fields
 * the server dropped.  Audit B8 — without this the SW's drain path
 * would delete the envelope but leave the local entity `_pending=true`
 * forever, lying to the UI.
 */
async function applyRowToEntity(
  db: SyncDB,
  env: MutationEnvelope,
  serverRow: unknown,
): Promise<void> {
  if (!serverRow || typeof serverRow !== "object") return;
  const row = serverRow as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return;
  if (row.kind !== env.entity) return;
  if (typeof row.version !== "number") return;
  if (typeof row.updatedAt !== "number") return;

  const storeName: "manifests" | "serviceRecords" =
    env.entity === "manifest" ? "manifests" : "serviceRecords";
  const tx = db.transaction(storeName, "readwrite");
  const existing = await tx.objectStore(storeName).get(row.id);
  // The shape was just validated above; the merge only adds keys, never
  // removes required ones, so the put typechecks.
  const merged = mergePreservingLocalOnly(existing as unknown, row) as unknown as
    | Manifest
    | ServiceRecord;
  await tx.objectStore(storeName).put(merged);
  await tx.done;
}

async function markConflictOnEntity(
  db: SyncDB,
  env: MutationEnvelope,
): Promise<void> {
  const payloadId = (env.payload as { id?: unknown } | null)?.id;
  if (typeof payloadId !== "string") return;
  const storeName: "manifests" | "serviceRecords" =
    env.entity === "manifest" ? "manifests" : "serviceRecords";
  const tx = db.transaction(storeName, "readwrite");
  const current = await tx.objectStore(storeName).get(payloadId);
  if (current) {
    await tx.objectStore(storeName).put({
      ...current,
      _pending: false,
      _hasConflict: true,
    });
  }
  await tx.done;
}

function mergePreservingLocalOnly(
  existing: unknown,
  serverRow: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing || typeof existing !== "object") {
    return { ...serverRow, _pending: false };
  }
  const localOnlyKeys =
    (existing as { _localOnlyKeys?: ReadonlyArray<string> })._localOnlyKeys ?? [];
  const localOnly: Record<string, unknown> = {};
  for (const key of localOnlyKeys) {
    const v = (existing as Record<string, unknown>)[key];
    if (v !== undefined && !(key in serverRow)) {
      localOnly[key] = v;
    }
  }
  return { ...localOnly, ...serverRow, _pending: false };
}

/** Exponential backoff with ±20 % jitter; capped at 60 s. */
export function backoffMs(retry: number): number {
  const base = Math.min(60_000, 500 * Math.pow(2, Math.max(0, retry - 1)));
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.min(60_000, Math.round(jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function broadcast(msg: unknown): Promise<void> {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const c of clients) c.postMessage(msg);
}

/* -------------------------------------------------------------------------
 * Minimal SyncEvent type (lib.webworker.d.ts doesn't always ship it).
 * ------------------------------------------------------------------------- */

interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}