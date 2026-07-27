import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, _resetDBForTests } from "./connection";
import {
  acknowledgeMutation,
  applyServerRow,
  getManifest,
  getPendingMutations,
  markEntityConflict,
  queueSize,
  upsertManifest,
} from "./repository";
import type { Manifest } from "../types/domain";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "manifest-1",
    kind: "manifest",
    updatedAt: 1,
    version: 0,
    client: { fullName: "Ada Lovelace" },
    startDate: "2026-07-24",
    endDate: "2026-07-25",
    equipment: [],
    ...overrides,
  };
}

async function deleteDatabase(): Promise<void> {
  await _resetDBForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion blocked"));
  });
}

describe("repository", () => {
  beforeEach(deleteDatabase);
  afterEach(deleteDatabase);

  it("persists an optimistic manifest and its mutation atomically", async () => {
    const saved = await upsertManifest(manifest(), "create");
    const envelopes = await getPendingMutations();

    expect(saved._pending).toBe(true);
    expect(await getManifest(saved.id)).toEqual(saved);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      entity: "manifest",
      action: "create",
      payload: saved,
      status: "pending",
      retryCount: 0,
    });
    expect(await queueSize()).toBe(1);
  });

  it("applies the canonical server row and removes the acknowledged envelope", async () => {
    const saved = await upsertManifest(manifest(), "create");
    const [envelope] = await getPendingMutations();
    const canonical = { ...saved, version: 1, _pending: true };

    await applyServerRow(envelope, canonical);

    expect(await getManifest(saved.id)).toEqual({ ...canonical, _pending: false });
    expect(await queueSize()).toBe(0);
  });

  it("rejects server rows that fail shape validation", async () => {
    const saved = await upsertManifest(manifest(), "create");
    const [envelope] = await getPendingMutations();

    // Mismatched `kind` — envelope targets a manifest but the row says service_record.
    const bogus = { ...saved, kind: "service_record", version: 1, updatedAt: 1 };

    await expect(applyServerRow(envelope, bogus)).rejects.toMatchObject({
      code: "EDGE_BAD_SERVER_ROW",
    });

    // The local row is untouched.
    expect(await getManifest(saved.id)).toEqual(saved);
    expect(await queueSize()).toBe(1);
  });

  it("preserves locally-stamped fields the server canonical row drops", async () => {
    // The local row carries a signature blob and a note that the server
    // strips for PII.  After applyServerRow both should survive.
    const saved = await upsertManifest(
      manifest({
        notes: "private op note",
        signatureOut: {
          dataUrl: "data:image/png;base64,SIG",
          signedAt: "2026-07-24T10:00:00.000Z",
          printedName: "Ada",
        },
        _localOnlyKeys: ["notes", "signatureOut"],
      }),
      "create",
    );
    const [envelope] = await getPendingMutations();
    // Server echo omits `notes` and `signatureOut`.
    const canonical = {
      id: saved.id,
      kind: "manifest",
      version: 1,
      updatedAt: 2,
      client: { fullName: "Ada Lovelace" },
      startDate: "2026-07-24",
      endDate: "2026-07-25",
      equipment: [],
    } as Manifest;

    await applyServerRow(envelope, canonical);

    expect(await getManifest(saved.id)).toMatchObject({
      ...canonical,
      notes: "private op note",
      signatureOut: saved.signatureOut,
      _pending: false,
    });
  });

  it("acknowledges a response without a canonical row without losing a newer queued edit", async () => {
    const first = await upsertManifest(manifest({ notes: "first" }), "create");
    const [firstEnvelope] = await getPendingMutations();
    const second = await upsertManifest({ ...first, notes: "second" }, "update");

    await acknowledgeMutation(firstEnvelope);

    expect(await getManifest(second.id)).toMatchObject({ notes: "second", _pending: true });
    expect(await queueSize()).toBe(1);
  });

  it("marks the local entity when a server conflict needs manual review", async () => {
    const saved = await upsertManifest(manifest(), "create");
    const [envelope] = await getPendingMutations();

    await markEntityConflict(envelope, true);

    expect(await getManifest(saved.id)).toMatchObject({
      _pending: false,
      _hasConflict: true,
    });
  });
});
