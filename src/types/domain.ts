/**
 * EdgeSync — Domain types (Phase 1)
 * ---------------------------------------------------------------------------
 * Shared TS interfaces for the three core business entities plus the sync
 * mutation queue.  Every entity carries the same durability metadata
 * (`updatedAt`, `version`, `_status`) so a single storage layer can persist
 * them uniformly and the SyncEngine can reason about ordering/conflicts.
 *
 * Design principles:
 *   • Every entity has a string `id` (UUIDv4 on the client).  This stays
 *     stable across retries, replays, and offline replays so the server can
 *     treat the client `id` as an idempotency key.
 *   • `version` is an integer the *server* increments.  The client never
 *     bumps it on its own; it merely echoes the last known value.  This is
 *     how the conflict resolver compares concurrent updates.
 *   • `_status` and `_hasConflict` are client-side only — the server
 *     ignores them.  They power optimistic UI badges.
 */

/* -------------------------------------------------------------------- *
 * Shared mixins                                                       *
 * -------------------------------------------------------------------- */

/** Fields every persisted entity carries.  Mirrored in IndexedDB. */
export interface BaseEntity {
  /** Stable client-generated UUID.  Used as idempotency key on the server. */
  id: string;
  /** Epoch ms when this row was last modified locally. */
  updatedAt: number;
  /** Server-assigned monotonic version.  0 means "never synced yet". */
  version: number;
  /** True until the server has ACKed the create/update. */
  _pending?: boolean;
  /** Set when the SyncEngine received a 409 against this row. */
  _hasConflict?: boolean;
  /** Local-only blob references preserved across server canonical-row replaces. */
  _localOnlyKeys?: ReadonlyArray<string>;
}

/* -------------------------------------------------------------------- *
 * Manifest / Booking                                                   *
 * -------------------------------------------------------------------- */

/** Client contact details — minimal, deliberately no PII fields required. */
export interface ClientDetails {
  fullName: string;
  phone?: string;
  email?: string;
  company?: string;
  emergencyContact?: { name: string; phone: string };
}

/** A piece of equipment checked in/out for a manifest. */
export interface EquipmentItem {
  sku: string;
  label: string;
  /** ISO timestamp of pickup.  May be unset for outbound inventory. */
  pickedUpAt?: string;
  /** ISO timestamp of return. */
  returnedAt?: string;
  /** Free-form condition notes from the operator. */
  conditionNote?: string;
}

/** Captured signature — PNG data URL or raw base64.  Stored inline. */
export interface Signature {
  /** PNG data URL (e.g. "data:image/png;base64,iVBORw0K…"). */
  dataUrl: string;
  /** ISO timestamp the signature was captured. */
  signedAt: string;
  /** Display name printed beneath the signature line. */
  printedName: string;
}

/**
 * A Manifest groups a booking with its equipment and signatures.
 * In outdoor-guide terms: "the trip sheet for Mr. Smith on June 14".
 */
export interface Manifest extends BaseEntity {
  kind: "manifest";
  /** Short human-friendly code, e.g. "M-2026-06-14-001".  Optional. */
  code?: string;
  client: ClientDetails;
  /** ISO date strings (YYYY-MM-DD).  Stored as strings so they round-trip
   *  through JSON without timezone surprises. */
  startDate: string;
  endDate: string;
  equipment: EquipmentItem[];
  /** Client signature on pickup. */
  signatureOut?: Signature;
  /** Client signature on return. */
  signatureIn?: Signature;
  /** Total quoted price in minor units (cents). */
  totalCents?: number;
  notes?: string;
}

/* -------------------------------------------------------------------- *
 * Service Record (time log + geo + photos)                             *
 * -------------------------------------------------------------------- */

/** Geo fix attached to a service record entry. */
export interface GeoFix {
  lat: number;
  lon: number;
  /** GPS accuracy in meters, or null if unknown. */
  accuracyM: number | null;
  capturedAt: number;
}

/** A photo blob reference.  We store the Blob in IDB and only the metadata
 *  on the record so reads stay cheap. */
export interface PhotoRef {
  id: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Mime type, defaults to "image/jpeg". */
  mimeType: string;
  /** Byte length — for UI display without loading the blob. */
  byteSize: number;
}

/** One log entry inside a service record (a "shift" or "task"). */
export interface ServiceLogEntry {
  id: string;
  startedAt: number;
  endedAt?: number;
  description: string;
  geo?: GeoFix;
  photos: PhotoRef[];
}

/** A ServiceRecord is a chronological log of work done on a job. */
export interface ServiceRecord extends BaseEntity {
  kind: "service_record";
  /** Optional link back to the originating manifest. */
  manifestId?: string;
  title: string;
  entries: ServiceLogEntry[];
}

/* -------------------------------------------------------------------- *
 * Sync Queue                                                           *
 * -------------------------------------------------------------------- */

/** What the operator wants done. */
export type MutationAction = "create" | "update" | "delete";

/** Lifecycle states of a queued mutation envelope. */
export type SyncStatus =
  | "pending"     // queued, not yet sent
  | "in_flight"   // HTTP request is currently open
  | "failed"      // last attempt failed; will retry with backoff
  | "conflict"    // server returned 409; needs human review
  | "done";       // server ACKed

/**
 * One queued mutation.  This is what travels through the offline pipeline.
 * `payload` is the full entity (for create/update) or just the id (delete).
 */
export interface MutationEnvelope {
  /** Stable client UUID — idempotency key. */
  id: string;
  /** Which entity table this targets. */
  entity: "manifest" | "service_record";
  action: MutationAction;
  /** Snapshot of the entity at enqueue time.  For deletes, `{ id }`. */
  payload: unknown;
  /** Epoch ms when the envelope was created. */
  timestamp: number;
  status: SyncStatus;
  /** Number of failed send attempts.  Drives exponential backoff. */
  retryCount: number;
  /** Epoch ms of the next allowed attempt — server-side pacing. */
  nextAttemptAt: number;
  /** Last error message, surfaced in the UI for debugging. */
  lastError?: string;
  /** Server-returned canonical row (after a successful 2xx). */
  serverRow?: unknown;
  /** Echoed by server when status === "conflict". */
  conflict?: {
    serverVersion: number;
    serverRow: unknown;
  };
}

/** Convenience type-guard: is this a Manifest row? */
export function isManifest(e: unknown): e is Manifest {
  return !!e && typeof e === "object" && (e as { kind?: string }).kind === "manifest";
}

/** Convenience type-guard: is this a ServiceRecord row? */
export function isServiceRecord(e: unknown): e is ServiceRecord {
  return !!e && typeof e === "object" && (e as { kind?: string }).kind === "service_record";
}