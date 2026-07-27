/**
 * EdgeSync — Sync Engine & Conflict Resolution (Phase 4)
 * ----------------------------------------------------------------------------
 * The page-side counterpart to the Service Worker's drainer.
 *
 * Responsibilities:
 *   1. Watch network status (`online` / `offline` events + 30 s heartbeat
 *      ping as a fallback — heartbeat catches the case where the OS
 *      thinks it's online but the radio is dead).
 *   2. On every local mutation (inserted by repository.ts), kick the
 *      engine:
 *        - If online, drain immediately.
 *        - If offline (or the drain fails), register the `edge-sync`
 *          tag with the SW so Background Sync picks it up later.
 *   3. On every server 2xx, replace the local entity with the server's
 *      canonical row and drop the envelope.
 *   4. On every server 409, persist the conflict and surface a banner
 *      via `onConflict`.
 *   5. Exponential backoff with jitter on transient failures.
 *
 * Conflict-resolution strategy
 * ----------------------------
 *  - **Version is monotonic per row.** The server rejects any update
 *    whose incoming `version` is not strictly greater than the stored
 *    one with a 409. The engine persists the conflict payload, sets the
 *    local entity's `_hasConflict = true`, and surfaces a "review"
 *    banner.  We do NOT auto-merge free-form text — the operator picks
 *    fields from each side manually.
 *  - **Cross-tab safety.** Multiple tabs each listen on
 *    `BroadcastChannel('edgesync-sync')`; an ack in one tab republishes
 *    status so the StatusBar decrements together.
 */

import {
  acknowledgeMutation,
  getPendingMutations,
  patchMutation,
  queueSize,
  applyServerRow,
  markEntityConflict,
} from "../db/repository";
import type { MutationEnvelope, BaseEntity } from "../types/domain";

/* -------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------- */

export type SyncStatus =
  | { kind: "online"; queueDepth: number }
  | { kind: "offline"; queueDepth: number }
  | { kind: "syncing"; queueDepth: number; inFlight: number }
  | { kind: "error"; queueDepth: number; message: string };

export interface SyncEngineOptions {
  /** API endpoint for batch POST.  Defaults to `/api/mutations`. */
  endpoint?: string;
  /** Maximum envelopes per HTTP batch. */
  batchSize?: number;
  /** Heartbeat interval (ms).  Pings the endpoint to verify the radio. */
  heartbeatMs?: number;
  /**
   * Authorization token attached to every outbound request.  When set,
   * sent as `Authorization: Bearer <token>`.  When omitted the engine
   * sends no auth header — callers should set this before deploying
   * against a real backend, since envelope ids alone are NOT an auth
   * boundary (audit B9).
   */
  authToken?: string | null;
  /** Called whenever status changes (debounced by the engine). */
  onStatus?: (status: SyncStatus) => void;
  /** Called whenever a server 409 lands. */
  onConflict?: (
    entity: "manifest" | "service_record",
    id: string,
    serverRow: unknown,
  ) => void;
}

/* -------------------------------------------------------------------------
 * Implementation
 * ------------------------------------------------------------------------- */

export class SyncEngine {
  private readonly opts: Required<SyncEngineOptions>;
  private readonly subscribers = new Set<(s: SyncStatus) => void>();
  private draining = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastStatus: SyncStatus | null = null;
  private readonly channel: BroadcastChannel | null =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("edgesync-sync")
      : null;

  constructor(opts: SyncEngineOptions = {}) {
    this.opts = {
      endpoint: opts.endpoint ?? "/api/mutations",
      batchSize: opts.batchSize ?? 25,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      authToken: opts.authToken ?? null,
      onStatus: opts.onStatus ?? (() => {}),
      onConflict: opts.onConflict ?? (() => {}),
    };
    // The initial onStatus counts as a subscriber so it sees every push.
    this.subscribers.add(this.opts.onStatus);
  }

  /**
   * Subscribe to status updates.  Returns an unsubscribe function.
   * Multiple components can subscribe independently — the constructor's
   * `onStatus` is automatically added as the first subscriber.
   */
  subscribe(cb: (s: SyncStatus) => void): () => void {
    this.subscribers.add(cb);
    // Immediately replay the last known status so the UI doesn't flash.
    if (this.lastStatus) cb(this.lastStatus);
    return () => this.subscribers.delete(cb);
  }

  /** Update the auth token at runtime (e.g. after login). */
  setAuthToken(token: string | null): void {
    this.opts.authToken = token;
  }

  /**
   * Build the headers for an outbound request.  Currently just
   * `Authorization: Bearer <token>` when an auth token is configured.
   */
  private authHeaders(): Record<string, string> {
    const token = this.opts.authToken;
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  /** Wire DOM listeners. Idempotent across repeated mount/start calls. */
  start(): void {
    if (typeof window === "undefined" || this.started) return; // SSR / node guard
    this.started = true;

    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    this.channel?.addEventListener("message", this.handleChannelMessage);

    // Initial status push.
    void this.publishStatus();

    // Heartbeat fallback — covers the case where `online` lies.
    this.heartbeat = setInterval(
      () => void this.heartbeatTick(),
      this.opts.heartbeatMs,
    );

    // Kick a drain immediately in case there are envelopes left over
    // from a previous session.
    void this.dispatch();
  }

  /** Tear down listeners and timers. */
  stop(): void {
    if (typeof window === "undefined" || !this.started) return;
    this.started = false;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    this.channel?.removeEventListener("message", this.handleChannelMessage);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Public entry point — call after every local write.  If online,
   * drains synchronously; otherwise registers the Background Sync tag
   * so the SW picks it up when connectivity returns.
   *
   * Concurrency: the page and the Service Worker both try to drain.
   * We hold a `navigator.locks` lock (`edgesync-drain`) so only one
   * context runs the drain at a time — audit B7.
   */
  async dispatch(): Promise<void> {
    if (this.draining) return;
    await this.withDrainLock(async () => {
      this.draining = true;
      try {
        await this.publishStatus();
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          await this.registerBackgroundSync();
          return;
        }
        await this.drainOnce();
      } finally {
        this.draining = false;
        await this.publishStatus();
      }
    });
  }

  /**
   * Run `fn` while holding the shared drain lock.  Falls back to a
   * plain call when `navigator.locks` is unavailable (Safari, jsdom
   * tests) — in that case the page's `this.draining` guard above
   * still prevents re-entry.
   */
  private async withDrainLock<T>(fn: () => Promise<T>): Promise<T> {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.locks === "undefined" ||
      typeof navigator.locks.request !== "function"
    ) {
      return fn();
    }
    return navigator.locks.request("edgesync-drain", fn);
  }

  /* ---------------- private ---------------- */

  private readonly handleOnline = (): void => {
    void this.dispatch();
  };

  private readonly handleOffline = (): void => {
    void this.publishStatus();
  };

  /**
   * Cross-tab message: when one tab drains an envelope, all tabs
   * re-publish their status so the StatusBar can decrement together.
   */
  private readonly handleChannelMessage = (e: MessageEvent): void => {
    const data = e.data as { type?: string } | undefined;
    if (data?.type === "edge-sync:republish") {
      void this.publishStatus();
    }
  };

  /** Active probe — `online` event can lie on flaky radios. */
  private async heartbeatTick(): Promise<void> {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    try {
      const res = await fetch(this.opts.endpoint, {
        method: "HEAD",
        cache: "no-store",
        headers: this.authHeaders(),
      });
      // 405 = "method not allowed" but the server IS reachable.
      if (res.ok || res.status === 405) {
        await this.dispatch();
      }
    } catch {
      // Treat as offline; don't pummel the radio.
      await this.publishStatus();
    }
  }

  /**
   * Drains the queue once (one batch).  On failure, leaves envelopes as
   * `pending` and bumps their `retryCount` / `nextAttemptAt` so the next
   * attempt backs off.
   */
  private async drainOnce(): Promise<void> {
    const batch = (await getPendingMutations()).slice(0, this.opts.batchSize);
    if (batch.length === 0) return;

    for (const env of batch) {
      await this.sendOne(env);
    }
  }

  private async sendOne(env: MutationEnvelope): Promise<void> {
    await patchMutation(env.id, { status: "in_flight" });

    try {
      const res = await fetch(this.opts.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify(env),
      });

      if (res.ok) {
        // Server ACKed — apply the canonical row + drop the envelope.
        const body = await res.json().catch(() => null) as
          | { row?: unknown }
          | null;
        if (body?.row) {
          try {
            await applyServerRow(env, body.row as BaseEntity);
          } catch (rowErr) {
            // Server shape didn't validate.  Leave the envelope pending
            // with the failure so the operator can investigate; bumping
            // retryCount avoids tight loops on a broken server.
            await patchMutation(env.id, {
              status: "failed",
              lastError:
                rowErr instanceof Error
                  ? rowErr.message.slice(0, 200)
                  : "bad server row",
            });
            await patchMutation(env.id, {
              status: "pending",
              retryCount: env.retryCount + 1,
              nextAttemptAt: Date.now() + backoffMs(env.retryCount + 1),
            });
            return;
          }
        } else {
          // Defensive: server accepted the envelope but returned no canonical row.
          await acknowledgeMutation(env);
        }
        this.channel?.postMessage({ type: "edge-sync:republish" });
        return;
      }

      if (res.status === 409) {
        const body = await res.json().catch(() => null) as
          | { serverVersion?: number; serverRow?: unknown }
          | null;
        await patchMutation(env.id, {
          status: "conflict",
          conflict: {
            serverVersion: body?.serverVersion ?? 0,
            serverRow: body?.serverRow ?? null,
          },
          lastError: "conflict",
        });
        await markEntityConflict(env, true);
        this.opts.onConflict(
          env.entity,
          (env.payload as { id?: string })?.id ?? env.id,
          body?.serverRow ?? null,
        );
        return;
      }

      if (res.status >= 500) {
        // Transient — leave pending, bump retryCount, push nextAttemptAt.
        const nextRetry = env.retryCount + 1;
        await patchMutation(env.id, {
          status: "pending",
          retryCount: nextRetry,
          nextAttemptAt: Date.now() + backoffMs(nextRetry),
          lastError: `server ${res.status}`,
        });
        await sleep(backoffMs(nextRetry));
        return;
      }

      // 4xx other than 409 → permanent failure.
      await patchMutation(env.id, {
        status: "failed",
        lastError: `permanent ${res.status}`,
      });
    } catch (err) {
      // Network error — leave pending, bump retry, register SW fallback.
      const nextRetry = env.retryCount + 1;
      await patchMutation(env.id, {
        status: "pending",
        retryCount: nextRetry,
        nextAttemptAt: Date.now() + backoffMs(nextRetry),
        lastError: err instanceof Error ? err.message : "network",
      });
      await this.registerBackgroundSync();
    }
  }

  /** Register the Background Sync tag so the SW drains when connectivity returns. */
  private async registerBackgroundSync(): Promise<void> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      // `sync` is the Background Sync API.  It's not in lib types
      // everywhere, so we probe defensively.
      const sync = (reg as ServiceWorkerRegistration & {
        sync?: { register(tag: string): Promise<void> };
      }).sync;
      if (sync) {
        await sync.register("edge-sync");
      } else {
        // Fallback: ask the SW directly via postMessage.
        reg.active?.postMessage({ type: "edge-sync:drain" });
      }
    } catch {
      // Background Sync not available — the heartbeat tick will retry.
    }
  }

  /** Recompute and broadcast the current status. */
  async publishStatus(): Promise<void> {
    const depth = await queueSize();
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    const next: SyncStatus = !online
      ? { kind: "offline", queueDepth: depth }
      : this.draining
      ? { kind: "syncing", queueDepth: depth, inFlight: depth }
      : { kind: "online", queueDepth: depth };

    // Avoid spurious re-renders.
    const prev = this.lastStatus;
    if (prev && shallowEqual(prev, next)) return;
    this.lastStatus = next;
    for (const sub of this.subscribers) sub(next);
  }
}

/* -------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** Exponential backoff with ±20 % jitter; capped at 60 s. */
export function backoffMs(retry: number): number {
  const base = Math.min(60_000, 500 * Math.pow(2, Math.max(0, retry - 1)));
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.min(60_000, Math.round(jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shallowEqual(a: SyncStatus, b: SyncStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "error" && b.kind === "error") return a.message === b.message;
  if (a.kind === "syncing" && b.kind === "syncing") {
    return a.queueDepth === b.queueDepth && a.inFlight === b.inFlight;
  }
  if (
    (a.kind === "online" || a.kind === "offline") &&
    (b.kind === "online" || b.kind === "offline")
  ) {
    return a.queueDepth === b.queueDepth;
  }
  return false;
}