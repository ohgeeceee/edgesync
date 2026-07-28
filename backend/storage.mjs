/**
 * EdgeSync backend — durable storage layer (Phase 1 of the sync backend).
 * ------------------------------------------------------------------------
 * Per-row JSON on disk, atomic `write tmp -> rename`, plus an envelope-id
 * idempotency index.  Zero npm dependencies — only Node stdlib.
 *
 *   data/
 *     manifests/<id>.json
 *     service_records/<id>.json
 *     _envelopes.json   # rolling LRU of recent envelope ids
 *
 * Every public method returns a plain JSON-serializable object so the
 * HTTP layer can pipe the value straight to JSON.stringify.
 *
 * Layout decisions:
 *   - Per-row files keep the floor-simple: `cat data/manifests/foo.json`
 *     for ops eyeballs; copy them straight into a backup tarball.
 *   - Atomic renames guarantee we never observe a partially-written row.
 *   - The envelope LRU is bounded to MAX_ENVELOPES so it cannot grow
 *     unbounded over the lifetime of the server.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdir, readFile, rename, writeFile, stat, readdir, unlink } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

export const MAX_ENVELOPES = 10_000;

/* -------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

export class BadShapeError extends Error {
  constructor(message) {
    super(`[edgesync] bad shape: ${message}`);
    this.name = "BadShapeError";
    this.code = "BAD_SHAPE";
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(`[edgesync] auth: ${message}`);
    this.name = "AuthError";
    this.code = "AUTH";
  }
}

/* -------------------------------------------------------------------------
 * Storage class
 * ------------------------------------------------------------------------- */

export class Storage {
  /**
   * @param {string} dataDir  Root directory; created on demand.
   */
  constructor(dataDir) {
    if (!dataDir) throw new Error("Storage requires a dataDir");
    this.dataDir = dataDir;
    this.manifestsDir = join(dataDir, "manifests");
    this.recordsDir = join(dataDir, "service_records");
    this.indexFile = join(dataDir, "_envelopes.json");
    this._ready = this._ensureDirs();
  }

  async _ensureDirs() {
    for (const d of [this.dataDir, this.manifestsDir, this.recordsDir]) {
      if (!existsSync(d)) await mkdir(d, { recursive: true });
    }
    if (!existsSync(this.indexFile)) {
      await atomicWriteJson(this.indexFile, { envelopes: {} });
    }
  }

  ready() {
    return this._ready;
  }

  /* ---------------- row CRUD ---------------- */

  storeDirFor(entity) {
    return entity === "manifest" ? this.manifestsDir : this.recordsDir;
  }

  async getRow(entity, id) {
    await this.ready();
    return readJsonIfExists(join(this.storeDirFor(entity), `${id}.json`));
  }

  /**
   * Apply a write.  Returns:
   *   { status: "created" | "updated", row }
   *   { status: "conflict", stored: <existing> }   when versions disagree
   */
  async applyRow(entity, payload) {
    await this.ready();
    if (!payload || typeof payload !== "object") throw new BadShapeError("payload must be an object");
    if (typeof payload.id !== "string" || payload.id.length === 0)
      throw new BadShapeError("payload.id must be a non-empty string");
    if (typeof payload.version !== "number" || !Number.isFinite(payload.version))
      throw new BadShapeError("payload.version must be a finite number");

    const dir = this.storeDirFor(entity);
    const path = join(dir, `${payload.id}.json`);
    const existing = (await readJsonIfExists(path)) ?? null;

    // Create-time rules: a brand-new id yields version=1; a duplicate id
    // at version=0 is a 409 against something we already have, regardless
    // of the incoming version.
    if (!existing) {
      if (payload.version !== 0) throw new BadShapeError("create payload must be version 0");
      const next = { ...payload, version: 1, _storedAt: nowIso() };
      await atomicWriteJson(path, next);
      return { status: "created", row: next };
    }

    if (typeof existing.version !== "number") throw new BadShapeError("stored row missing numeric version");

    // Strict equal/version semantics: client must echo the version it
    // last saw; server bumps stored.version by 1 (so a client that
    // replayed v=0 against a stored v=2 is correctly rejected as stale).
    if (payload.version !== existing.version) {
      return { status: "conflict", stored: existing };
    }

    // Preserve server-only fields, merge client fields into the stored row.
    const merged = { ...existing, ...payload, version: existing.version + 1, _storedAt: nowIso() };
    await atomicWriteJson(path, merged);
    return { status: "updated", row: merged };
  }

  async deleteRow(entity, id) {
    await this.ready();
    const path = join(this.storeDirFor(entity), `${id}.json`);
    const existing = await readJsonIfExists(path);
    if (!existing) return { status: "missing", row: null };
    await unlink(path);
    return { status: "deleted", row: existing };
  }

  async listEntity(entity) {
    await this.ready();
    const dir = this.storeDirFor(entity);
    const files = await readdir(dir).catch(() => []);
    const rows = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const r = await readJsonIfExists(join(dir, f));
      if (r) rows.push(r);
    }
    return rows;
  }

  /* ---------------- envelope idempotency ---------------- */

  async _readIndex() {
    await this.ready();
    const raw = await readJsonIfExists(this.indexFile);
    if (!raw || typeof raw !== "object") return { envelopes: {} };
    if (!raw.envelopes || typeof raw.envelopes !== "object") raw.envelopes = {};
    return raw;
  }

  async _writeIndex(idx) {
    await atomicWriteJson(this.indexFile, idx);
  }

  /**
   * Look up an envelope id without mutating the index.  Returns the
   * stored canonical row if the id is present, else `null`.
   */
  async lookupEnvelope(envelopeId) {
    if (typeof envelopeId !== "string" || envelopeId.length === 0) {
      throw new BadShapeError("envelope id must be a non-empty string");
    }
    const idx = await this._readIndex();
    return idx.envelopes[envelopeId] ?? null;
  }

  /**
   * Record that `envelopeId` was applied and produced `rowForReplay`.
   * Bounded by MAX_ENVELOPES via LRU prune.
   */
  async rememberEnvelope(envelopeId, rowForReplay) {
    if (typeof envelopeId !== "string" || envelopeId.length === 0) {
      throw new BadShapeError("envelope id must be a non-empty string");
    }
    const idx = await this._readIndex();
    idx.envelopes[envelopeId] = rowForReplay;
    const ids = Object.keys(idx.envelopes);
    if (ids.length > MAX_ENVELOPES) {
      const drop = ids.slice(0, ids.length - MAX_ENVELOPES);
      for (const k of drop) delete idx.envelopes[k];
    }
    await this._writeIndex(idx);
    return { status: "recorded" };
  }

  async stats() {
    const manifests = (await this.listEntity("manifest")).length;
    const records = (await this.listEntity("service_record")).length;
    const idx = await this._readIndex();
    return {
      rows: manifests + records,
      envelopes: Object.keys(idx.envelopes).length,
      byEntity: { manifest: manifests, service_record: records },
      ts: nowIso(),
    };
  }
}

/* -------------------------------------------------------------------------
 * Internal helpers
 * ------------------------------------------------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Atomic JSON write.  Writes to `<file>.tmp`, then renames.  `rename` is
 * atomic on POSIX; on Windows the same path produces an atomic move via
 * NTFS MoveFileEx semantics inside `fs.rename` — not perfect, but for
 * the lone-writer server we run, it's safe.
 */
async function atomicWriteJson(path, value) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

async function readJsonIfExists(path) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    // Malformed JSON — re-throw so the caller can decide.
    throw err;
  }
}

/* -------------------------------------------------------------------------
 * Public helpers (used by the HTTP layer and by tests)
 * ------------------------------------------------------------------------- */

export function isMutableEnvelopeAction(action) {
  return action === "create" || action === "update" || action === "delete";
}
