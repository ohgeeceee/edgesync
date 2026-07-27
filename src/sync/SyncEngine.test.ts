import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationEnvelope } from "../types/domain";

const repository = vi.hoisted(() => ({
  acknowledgeMutation: vi.fn(),
  applyServerRow: vi.fn(),
  getPendingMutations: vi.fn(),
  markEntityConflict: vi.fn(),
  patchMutation: vi.fn(),
  queueSize: vi.fn(),
}));

vi.mock("../db/repository", () => repository);

import { SyncEngine, backoffMs } from "./SyncEngine";

function envelope(): MutationEnvelope {
  return {
    id: "mutation-1",
    entity: "manifest",
    action: "update",
    payload: { id: "manifest-1", version: 1 },
    timestamp: 1,
    status: "pending",
    retryCount: 0,
    nextAttemptAt: 0,
  };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    repository.acknowledgeMutation.mockReset();
    repository.applyServerRow.mockReset();
    repository.getPendingMutations.mockReset();
    repository.markEntityConflict.mockReset();
    repository.patchMutation.mockReset();
    repository.queueSize.mockReset();
    repository.getPendingMutations.mockResolvedValue([]);
    repository.queueSize.mockResolvedValue(0);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the canonical row returned by a successful mutation", async () => {
    const env = envelope();
    const row = { id: "manifest-1", version: 2, updatedAt: 2 };
    repository.getPendingMutations.mockResolvedValue([env]);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ row }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await new SyncEngine().dispatch();

    expect(repository.patchMutation).toHaveBeenCalledWith(env.id, { status: "in_flight" });
    expect(repository.applyServerRow).toHaveBeenCalledWith(env, row);
  });

  it("acknowledges a successful response that omits a canonical row", async () => {
    const env = envelope();
    repository.getPendingMutations.mockResolvedValue([env]);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await new SyncEngine().dispatch();

    expect(repository.acknowledgeMutation).toHaveBeenCalledWith(env);
    expect(repository.applyServerRow).not.toHaveBeenCalled();
  });

  it("persists a 409 and marks the entity for manual review", async () => {
    const env = envelope();
    const onConflict = vi.fn();
    const serverRow = { id: "manifest-1", version: 3 };
    repository.getPendingMutations.mockResolvedValue([env]);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ serverVersion: 3, serverRow }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await new SyncEngine({ onConflict }).dispatch();

    expect(repository.patchMutation).toHaveBeenCalledWith(
      env.id,
      expect.objectContaining({ status: "conflict", lastError: "conflict" }),
    );
    expect(repository.markEntityConflict).toHaveBeenCalledWith(env, true);
    expect(onConflict).toHaveBeenCalledWith("manifest", "manifest-1", serverRow);
  });

  it("leaves a network failure pending with a future retry", async () => {
    const env = envelope();
    repository.getPendingMutations.mockResolvedValue([env]);
    vi.mocked(fetch).mockRejectedValue(new Error("radio unavailable"));

    await new SyncEngine().dispatch();

    expect(repository.patchMutation).toHaveBeenLastCalledWith(
      env.id,
      expect.objectContaining({
        status: "pending",
        retryCount: 1,
        lastError: "radio unavailable",
        nextAttemptAt: expect.any(Number),
      }),
    );
  });
});

describe("backoffMs", () => {
  it("stays within the jitter envelope and caps at one minute", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0);
    expect(backoffMs(1)).toBe(400);
    expect(backoffMs(20)).toBe(48_000);
    random.mockReturnValue(1);
    expect(backoffMs(1)).toBe(600);
    expect(backoffMs(20)).toBe(60_000);
  });
});
