import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "../types/domain";

const repository = vi.hoisted(() => ({
  getManifest: vi.fn(),
  upsertManifest: vi.fn(),
  uuid: vi.fn(() => "manifest-1"),
}));

vi.mock("../db/repository", () => repository);

import { ManifestForm } from "./ManifestForm";

describe("ManifestForm", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        clearRect: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: vi.fn(() => "data:image/png;base64,test"),
    });
    repository.getManifest.mockReset();
    repository.upsertManifest.mockReset();
    repository.uuid.mockClear();
    repository.upsertManifest.mockImplementation(async (manifest: Manifest) => ({
      ...manifest,
      updatedAt: Date.now(),
      _pending: true,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("autosaves the latest field value rather than the previous render", async () => {
    const onSaved = vi.fn();
    const screen = render(<ManifestForm onSaved={onSaved} />);
    const name = await screen.findByLabelText("Full name");

    fireEvent.input(name, { target: { value: "Ada Lovelace" } });

    await waitFor(
      () => expect(repository.upsertManifest).toHaveBeenCalledTimes(1),
      { timeout: 1_500 },
    );

    const saved = repository.upsertManifest.mock.calls[0][0] as Manifest;
    expect(saved.client.fullName).toBe("Ada Lovelace");
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ fullName: "Ada Lovelace" }) }),
    );
  });
});
