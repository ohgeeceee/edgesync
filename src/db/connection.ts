/**
 * EdgeSync — IndexedDB connection & schema
 * ----------------------------------------------------------------------------
 * Thin wrapper around `idb` that owns:
 *   - the database connection,
 *   - schema upgrades,
 *   - object-store handle factories.
 *
 * Stores (all keyed by the entity's `id`, see types/domain.ts):
 *   manifests         keyPath: id            index: by-updatedAt -> updatedAt
 *   serviceRecords    keyPath: id            index: by-manifest   -> manifestId
 *                                                 by-updatedAt  -> updatedAt
 *   syncQueue         keyPath: id            index: by-status    -> status
 *                                                 by-nextAt    -> nextAttemptAt
 *   mediaBlobs        keyPath: id            (binary Blob payloads)
 *   meta              keyPath: key           (small kv: schema version, last sync, etc.)
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Manifest, ServiceRecord, MutationEnvelope } from "../types/domain";

export const DB_NAME = "edgesync";
export const DB_VERSION = 1;

export interface EdgeSyncSchema extends DBSchema {
  manifests: {
    key: string;
    value: Manifest;
    indexes: { "by-updatedAt": number };
  };
  serviceRecords: {
    key: string;
    value: ServiceRecord;
    indexes: {
      "by-manifest": string;
      "by-updatedAt": number;
    };
  };
  syncQueue: {
    key: string;
    value: MutationEnvelope;
    indexes: {
      "by-status": string;
      "by-nextAt": number;
    };
  };
  mediaBlobs: {
    key: string;
    value: { id: string; blob: Blob; mimeType: string; createdAt: string };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export type EdgeDB = IDBPDatabase<EdgeSyncSchema>;

let dbPromise: Promise<EdgeDB> | null = null;

/**
 * Returns (and lazily creates) the singleton DB connection.
 *
 * The schema is bumped by incrementing `DB_VERSION` and extending the
 * `upgrade` callback.  Because every code path that touches IndexedDB
 * goes through `getDB()`, schema drift is impossible.
 */
export function getDB(): Promise<EdgeDB> {
  if (dbPromise) return dbPromise;

  dbPromise = openDB<EdgeSyncSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // v0 → v1: initial schema.  Idempotent — re-running an upgrade is a no-op.
      if (oldVersion < 1) {
        const manifests = db.createObjectStore("manifests", { keyPath: "id" });
        manifests.createIndex("by-updatedAt", "updatedAt");

        const sr = db.createObjectStore("serviceRecords", { keyPath: "id" });
        sr.createIndex("by-manifest", "manifestId");
        sr.createIndex("by-updatedAt", "updatedAt");

        const q = db.createObjectStore("syncQueue", { keyPath: "id" });
        q.createIndex("by-status", "status");
        q.createIndex("by-nextAt", "nextAttemptAt");

        db.createObjectStore("mediaBlobs", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "key" });
      }
    },
    blocked() {
      // Another tab is holding an older connection open.  We log so an
      // operator can close the offending tab; the caller's promise simply
      // resolves once the lock is released.
      console.warn("[edgesync] IndexedDB upgrade blocked by another tab");
    },
    terminated() {
      // The connection was killed underneath us (quota, corruption, user
      // wiped site data).  Drop the cached promise so the next call
      // re-opens cleanly.
      dbPromise = null;
      console.error("[edgesync] IndexedDB connection terminated");
    },
  });

  return dbPromise;
}

/** Test-only escape hatch — closes the cached connection. */
export async function _resetDBForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}