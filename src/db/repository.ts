/**
 * EdgeSync — Repository layer (Phase 2)
 * ----------------------------------------------------------------------------
 * Typed CRUD wrappers around the IndexedDB connection defined in
 * `connection.ts`.  Every write path:
 *
 *   1. Stamps `updatedAt = Date.now()` and sets `_pending = true` on the
 *      entity so the UI can render the "saving" badge immediately.
 *   2. Performs the entity write AND the matching `MutationEnvelope`
 *      insert inside a single `readwrite` transaction — they commit
 *      atomically, so an entity and its queued mutation are never out of
 *      sync (no orphan rows, no orphan envelopes).
 *
 * The repository never talks to the network — it does not know whether
 * the user is online or offline.  It simply persists data durably; the
 * SyncEngine decides what to send to the server and when.
 *
 * Reads are done inside `readonly` transactions.  Cross-store consistency
 * is not required on reads since reads tolerate a millisecond of staleness.
 */

import { getDB } from "./connection";
import type {
  Manifest,
  ServiceRecord,
  MutationEnvelope,
  MutationAction,
  BaseEntity,
} from "../types/domain";

/* -------------------------------------------------------------------------
 * Internal helpers
 * ------------------------------------------------------------------------- */

/**
 * Crypto-quality UUID v4.  Falls back to `crypto.getRandomValues` (also
 * widely available in IDB-capable runtimes) before finally degrading to
 * `Math.random` — which is unsafe for an idempotency key but better than
 * throwing on ancient WebViews.
 */
export function uuid(): string {
  if (typeof crypto !== "undefined") {
    if ("randomUUID" in crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      // RFC 4122 v4 — set version (4) and variant (10xx) bits.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  // Final fallback: Math.random — acceptable only for non-security tokens.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Bump the local stamps: `updatedAt = Date.now()`, `_pending = true`.
 * Does NOT touch `version` (the server owns that).
 * Returns a new object — never mutates the input.
 */
function stampForWrite<T extends BaseEntity>(entity: T): T {
  return {
    ...entity,
    updatedAt: Date.now(),
    _pending: true,
  };
}

/** Build a fresh `pending` mutation envelope for an entity write. */
function envelopeFor<E extends BaseEntity>(
  entity: "manifest" | "service_record",
  action: MutationAction,
  payload: unknown,
): MutationEnvelope {
  return {
    id: uuid(),
    entity,
    action,
    payload,
    timestamp: Date.now(),
    status: "pending",
    retryCount: 0,
    nextAttemptAt: 0,
  };
}

/* -------------------------------------------------------------------------
 * Manifests
 * ------------------------------------------------------------------------- */

/** Fetch a single manifest by its client-generated id. */
export async function getManifest(id: string): Promise<Manifest | undefined> {
  const db = await getDB();
  return db.get("manifests", id);
}

/** Fetch every manifest, newest first. */
export async function getAllManifests(): Promise<Manifest[]> {
  const db = await getDB();
  const all = await db.getAll("manifests");
  // Newest first.  `updatedAt` is a number so plain subtraction works.
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Fetch only manifests that still have an unsynced mutation in flight. */
export async function getPendingManifests(): Promise<Manifest[]> {
  const all = await getAllManifests();
  return all.filter((m) => m._pending || m._hasConflict);
}

/**
 * Insert-or-update a manifest.  The returned object is the stamped copy
 * (with `_pending=true`).  Atomically also enqueues a mutation envelope.
 */
export async function upsertManifest(
  next: Manifest,
  action: MutationAction = "update",
): Promise<Manifest> {
  const stamped = stampForWrite(next);
  const envelope = envelopeFor<Manifest>("manifest", action, stamped);

  const db = await getDB();
  // Atomic: entity write and queue insert commit together or not at all.
  const tx = db.transaction(["manifests", "syncQueue"], "readwrite");
  await Promise.all([
    tx.objectStore("manifests").put(stamped),
    tx.objectStore("syncQueue").put(envelope),
  ]);
  await tx.done;

  return stamped;
}

/**
 * Delete a manifest.  Also enqueues a `delete` envelope for the server.
 *
 * Returns `true` if the row existed locally (and was removed), `false`
 * otherwise.  We always enqueue a delete envelope keyed by `id` so the
 * server can clean up any orphan row it may hold — even when the local
 * row was already deleted by another tab.  The existence check happens
 * *inside* the transaction so we never race with a concurrent write.
 */
export async function deleteManifest(id: string): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(["manifests", "syncQueue"], "readwrite");

  const existing = await tx.objectStore("manifests").get(id);
  const envelope: MutationEnvelope = envelopeFor<Manifest>(
    "manifest",
    "delete",
    { id, version: existing?.version ?? 0 },
  );

  await tx.objectStore("syncQueue").put(envelope);
  if (existing) {
    await tx.objectStore("manifests").delete(id);
  }
  await tx.done;
  return !!existing;
}

/* -------------------------------------------------------------------------
 * Service records
 * ------------------------------------------------------------------------- */

export async function getServiceRecord(id: string): Promise<ServiceRecord | undefined> {
  const db = await getDB();
  return db.get("serviceRecords", id);
}

export async function getAllServiceRecords(): Promise<ServiceRecord[]> {
  const db = await getDB();
  const all = await db.getAll("serviceRecords");
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listServiceRecordsForManifest(
  manifestId: string,
): Promise<ServiceRecord[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex("serviceRecords", "by-manifest", manifestId);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function upsertServiceRecord(
  next: ServiceRecord,
  action: MutationAction = "update",
): Promise<ServiceRecord> {
  const stamped = stampForWrite(next);
  const envelope = envelopeFor<ServiceRecord>("service_record", action, stamped);

  const db = await getDB();
  const tx = db.transaction(["serviceRecords", "syncQueue"], "readwrite");
  await Promise.all([
    tx.objectStore("serviceRecords").put(stamped),
    tx.objectStore("syncQueue").put(envelope),
  ]);
  await tx.done;

  return stamped;
}

/* -------------------------------------------------------------------------
 * Sync queue inspection & mutation (used by the SyncEngine in Phase 4)
 * ------------------------------------------------------------------------- */

/**
 * All envelopes whose status is `pending` AND whose `nextAttemptAt` is
 * in the past.  The SyncEngine grabs these and ships them.
 */
export async function getPendingMutations(): Promise<MutationEnvelope[]> {
  const db = await getDB();
  // Cheap scan: status index narrows to pending, then we filter on nextAttemptAt.
  const all = await db.getAllFromIndex("syncQueue", "by-status", "pending");
  const now = Date.now();
  return all
    .filter((e) => e.nextAttemptAt <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Envelopes the server returned a 409 for.  Shown as "Review" in the UI. */
export async function getConflictedMutations(): Promise<MutationEnvelope[]> {
  const db = await getDB();
  return db.getAllFromIndex("syncQueue", "by-status", "conflict");
}

/** How many envelopes are pending right now. */
export async function queueSize(): Promise<number> {
  const db = await getDB();
  return db.countFromIndex("syncQueue", "by-status", "pending");
}

/** Drop a terminal-state envelope after a successful sync. */
export async function deleteMutation(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("syncQueue", id);
}

/**
 * Acknowledge an envelope when the server returned no canonical row.
 * Clears `_pending` only when no newer mutation for the same entity remains.
 */
export async function acknowledgeMutation(envelope: MutationEnvelope): Promise<void> {
  const payloadId = (envelope.payload as { id?: unknown } | null)?.id;
  const db = await getDB();
  const tx = db.transaction(
    [envelope.entity === "manifest" ? "manifests" : "serviceRecords", "syncQueue"],
    "readwrite",
  );
  await tx.objectStore("syncQueue").delete(envelope.id);

  if (typeof payloadId === "string") {
    const queued = await tx.objectStore("syncQueue").getAll();
    const hasNewerMutation = queued.some((candidate) =>
      candidate.entity === envelope.entity &&
      (candidate.payload as { id?: unknown } | null)?.id === payloadId,
    );

    if (!hasNewerMutation) {
      if (envelope.entity === "manifest") {
        const store = tx.objectStore("manifests");
        const current = await store.get(payloadId);
        if (current) await store.put({ ...current, _pending: false });
      } else {
        const store = tx.objectStore("serviceRecords");
        const current = await store.get(payloadId);
        if (current) await store.put({ ...current, _pending: false });
      }
    }
  }

  await tx.done;
}

/**
 * Update an envelope in place.  Atomically bumps status / retryCount /
 * nextAttemptAt / lastError so the SyncEngine can race freely.
 */
export async function patchMutation(
  id: string,
  patch: Partial<MutationEnvelope>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("syncQueue", "readwrite");
  const cur = await tx.store.get(id);
  if (!cur) {
    await tx.done;
    return;
  }
  await tx.store.put({ ...cur, ...patch });
  await tx.done;
}

/** Mark or clear the local entity flag used by the manual conflict-review UI. */
export async function markEntityConflict(
  envelope: MutationEnvelope,
  hasConflict: boolean,
): Promise<void> {
  const payloadId = (envelope.payload as { id?: unknown } | null)?.id;
  if (typeof payloadId !== "string") return;

  const db = await getDB();
  if (envelope.entity === "manifest") {
    const tx = db.transaction("manifests", "readwrite");
    const current = await tx.store.get(payloadId);
    if (current) {
      await tx.store.put({
        ...current,
        _pending: hasConflict ? false : current._pending,
        _hasConflict: hasConflict,
      });
    }
    await tx.done;
    return;
  }

  const tx = db.transaction("serviceRecords", "readwrite");
  const current = await tx.store.get(payloadId);
  if (current) {
    await tx.store.put({
      ...current,
      _pending: hasConflict ? false : current._pending,
      _hasConflict: hasConflict,
    });
  }
  await tx.done;
}

/**
 * After the server ACKs a mutation, replace the local entity with the
 * canonical server row (server version, fresh `updatedAt`, `_pending=false`).
 * Atomically removes the envelope.
 *
 * Shape validation: the server row must be an object with `id`, `version`,
 * `kind` matching the envelope, and `updatedAt` — otherwise we reject the
 * row and surface the error rather than writing garbage to IDB.  This is
 * the trust boundary between the client and whatever responded to the
 * mutation POST.
 */
export async function applyServerRow(
  envelope: MutationEnvelope,
  serverRow: BaseEntity,
): Promise<void> {
  validateServerRow(envelope, serverRow);

  const db = await getDB();
  const storeName: "manifests" | "serviceRecords" =
    envelope.entity === "manifest" ? "manifests" : "serviceRecords";

  // Preserve local-only fields the server doesn't echo.  In particular
  // signature blobs may be stripped server-side (PII policy / size
  // limit); we MUST NOT silently drop them on the canonical replace.
  const tx = db.transaction([storeName, "syncQueue"], "readwrite");
  const existing = await tx.objectStore(storeName).get(serverRow.id);
  // The shape was just validated against the envelope's entity — the
  // local-only merge only adds fields, never removes required ones.
  const merged = mergePreservingLocalOnly(existing, serverRow) as unknown as
    | Manifest
    | ServiceRecord;

  await Promise.all([
    tx.objectStore(storeName).put(merged),
    tx.objectStore("syncQueue").delete(envelope.id),
  ]);
  await tx.done;
}

/**
 * Reject server rows whose shape doesn't match the envelope.  Returns
 * nothing on success; throws on mismatch.  The thrown Error carries
 * `code: "EDGE_BAD_SERVER_ROW"` so callers can branch without scraping
 * the message.
 */
function validateServerRow<T extends BaseEntity>(
  envelope: MutationEnvelope,
  serverRow: T,
): void {
  if (!serverRow || typeof serverRow !== "object") {
    throw makeBadRowError("server row is not an object", envelope);
  }
  const row = serverRow as Record<string, unknown>;

  if (typeof row.id !== "string" || row.id.length === 0) {
    throw makeBadRowError("server row missing string id", envelope);
  }
  if (typeof row.version !== "number" || !Number.isFinite(row.version)) {
    throw makeBadRowError("server row missing numeric version", envelope);
  }
  if (row.kind !== envelope.entity) {
    throw makeBadRowError(
      `server row kind "${String(row.kind)}" does not match envelope entity "${envelope.entity}"`,
      envelope,
    );
  }
  if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) {
    throw makeBadRowError("server row missing numeric updatedAt", envelope);
  }
  // The server should NEVER echo a `_pending` true — that flag is the
  // client's optimism.  Reset it explicitly in the put anyway.
}

function makeBadRowError(message: string, envelope: MutationEnvelope): Error {
  const err = new Error(`[edgesync] refusing server row: ${message}`);
  (err as Error & { code?: string; envelope?: MutationEnvelope }).code =
    "EDGE_BAD_SERVER_ROW";
  (err as Error & { code?: string; envelope?: MutationEnvelope }).envelope =
    envelope;
  return err;
}

/**
 * Carry over fields present on the local row but absent on the server
 * row (signature blobs, in-progress drafts, etc.).  Server-truth wins
 * for any field that exists on both sides.
 *
 * Generic intentionally unconstrained at the call site so it accepts
 * whatever shape the IDB store returned; both ends are widened to
 * `Record<string, unknown>` internally and the union type comes back.
 */
function mergePreservingLocalOnly(
  existing: unknown,
  serverRow: BaseEntity | Record<string, unknown>,
): Record<string, unknown> {
  if (!existing || typeof existing !== "object") {
    return { ...(serverRow as Record<string, unknown>), _pending: false };
  }
  const localOnlyKeys =
    (existing as { _localOnlyKeys?: ReadonlyArray<string> })._localOnlyKeys ?? [];
  const serverObj = serverRow as Record<string, unknown>;
  const localOnly: Record<string, unknown> = {};
  for (const key of localOnlyKeys) {
    const v = (existing as Record<string, unknown>)[key];
    if (v !== undefined && !(key in serverObj) && serverObj[key] === undefined) {
      localOnly[key] = v;
    }
  }
  return { ...localOnly, ...serverObj, _pending: false };
}

/* -------------------------------------------------------------------------
 * Media blobs (photos / signatures stored as Blobs)
 * ------------------------------------------------------------------------- */

export async function putMediaBlob(
  id: string,
  blob: Blob,
  mimeType: string,
): Promise<void> {
  const db = await getDB();
  await db.put("mediaBlobs", {
    id,
    blob,
    mimeType,
    createdAt: new Date().toISOString(),
  });
}

export async function getMediaBlob(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  const row = await db.get("mediaBlobs", id);
  return row?.blob;
}

/* -------------------------------------------------------------------------
 * Meta key/value (used for last-sync-time, schema version, etc.)
 * ------------------------------------------------------------------------- */

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("meta", { key, value });
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const row = await db.get("meta", key);
  return row?.value as T | undefined;
}

/* -------------------------------------------------------------------------
 * Convenience counter — surfaced by the StatusBar.
 * ------------------------------------------------------------------------- */

export async function pendingCountByEntity(): Promise<{
  manifest: number;
  service_record: number;
}> {
  const envelopes = await getPendingMutations();
  const out = { manifest: 0, service_record: 0 };
  for (const e of envelopes) out[e.entity]++;
  return out;
}