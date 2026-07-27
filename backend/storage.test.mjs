/**
 * Backend storage tests — covers the durable row layer.
 *  - happy create / update / delete
 *  - 409 path when incoming version is not strictly greater
 *  - envelope-id idempotency: lookup vs remember
 *
 * Uses Node's built-in test runner so the backend stays zero-dep.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Storage, BadShapeError } from "./storage.mjs";

function freshDir(name = "edgesync-storage-") {
  return mkdtempSync(join(tmpdir(), name));
}

function baseManifest(id, overrides = {}) {
  return {
    id,
    kind: "manifest",
    version: 0,
    updatedAt: 1700000000000,
    client: { fullName: "Ada" },
    startDate: "2026-07-01",
    endDate: "2026-07-03",
    equipment: [],
    ...overrides,
  };
}

test("create then update round-trip bumps the server version", async () => {
  const dir = freshDir();
  const storage = new Storage(dir);
  await storage.ready();

  const created = await storage.applyRow("manifest", baseManifest("M-1"));
  assert.equal(created.status, "created");
  assert.equal(created.row.version, 1);
  assert.equal(created.row.id, "M-1");

  const updated = await storage.applyRow("manifest", {
    ...created.row,
    client: { fullName: "Bob" },
    version: created.row.version,
  });
  assert.equal(updated.status, "updated");
  assert.equal(updated.row.version, 2);
  assert.equal(updated.row.client.fullName, "Bob");
});

test("an incoming update with version <= stored version is a conflict", async () => {
  const dir = freshDir();
  const storage = new Storage(dir);
  await storage.ready();
  const created = await storage.applyRow("manifest", baseManifest("M-2"));
  const fresh = await storage.applyRow("manifest", {
    ...created.row,
    version: created.row.version,
    client: { fullName: "Bob" },
  });
  assert.equal(fresh.status, "updated");
  // A fresh envelope from another client replaying the older version must NOT win.
  const stale = await storage.applyRow("manifest", {
    ...fresh.row,
    version: created.row.version, // <server
    client: { fullName: "Carol" },
  });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.stored.client.fullName, "Bob"); // server row unchanged
});

test("delete is idempotent: second delete reports missing", async () => {
  const dir = freshDir();
  const storage = new Storage(dir);
  await storage.ready();
  await storage.applyRow("manifest", baseManifest("M-3"));
  const first = await storage.deleteRow("manifest", "M-3");
  assert.equal(first.status, "deleted");
  const second = await storage.deleteRow("manifest", "M-3");
  assert.equal(second.status, "missing");
});

test("envelope idempotency: lookup before remember returns null; remember writes; second lookup sees the row", async () => {
  const dir = freshDir();
  const storage = new Storage(dir);
  await storage.ready();

  assert.equal(await storage.lookupEnvelope("env-A"), null);
  await storage.rememberEnvelope("env-A", { id: "row-A", version: 3 });
  const row = await storage.lookupEnvelope("env-A");
  assert.equal(row.id, "row-A");
  assert.equal(row.version, 3);
});

test("create with a non-zero version is a BadShapeError", async () => {
  const dir = freshDir();
  const storage = new Storage(dir);
  await storage.ready();
  await assert.rejects(
    () => storage.applyRow("manifest", baseManifest("M-4", { version: 5 })),
    (err) => err instanceof BadShapeError,
  );
});

test("stats counts per-entity rows + envelope index size", async () => {
  const dir = freshDir();
  const storage = new Storage(dir);
  await storage.ready();
  await storage.applyRow("manifest", baseManifest("M-a"));
  await storage.applyRow("service_record", { id: "S-a", kind: "service_record", version: 0, updatedAt: 1, title: "x", entries: [] });
  await storage.rememberEnvelope("env-x", { id: "M-a", version: 1 });

  const stats = await storage.stats();
  assert.equal(stats.rows, 2);
  assert.equal(stats.byEntity.manifest, 1);
  assert.equal(stats.byEntity.service_record, 1);
  assert.equal(stats.envelopes, 1);
});
