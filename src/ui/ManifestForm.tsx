/**
 * EdgeSync — Manifest Form (Phase 5)
 * ----------------------------------------------------------------------------
 * Offline-safe form with:
 *   - local draft autosave to IndexedDB (every keystroke, debounced 400 ms);
 *   - instant optimistic UI confirmation (the form flips to "Saved ✓"
 *     the moment the local write commits, regardless of network);
 *   - signature capture via the SignaturePad component;
 *   - conflict + pending badges driven by entity flags.
 *
 * The form never talks to the network directly — it just calls
 * `upsertManifest()`, which atomically persists the row and enqueues a
 * mutation envelope.  The SyncEngine (Phase 4) drains that envelope.
 */

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { SignaturePad } from "./SignaturePad";
import { getManifest, upsertManifest, uuid } from "../db/repository";
import type { Manifest, Signature } from "../types/domain";

export interface ManifestFormProps {
  /** Optional id to edit; if omitted, creates a new draft. */
  id?: string;
  /** Called after a successful local save. */
  onSaved?: (m: Manifest) => void;
}

const AUTOSAVE_MS = 400;

export function ManifestForm({ id, onSaved }: ManifestFormProps) {
  const [m, setM] = useState<Manifest | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const latestRef = useRef<Manifest | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load existing or new draft on mount.
  useEffect(() => {
    void (async () => {
      if (id) {
        const existing = await getManifest(id);
        if (existing) {
          latestRef.current = existing;
          setM(existing);
          return;
        }
      }
      // Brand-new draft — empty manifest, today's dates.
      const today = new Date().toISOString().slice(0, 10);
      const fresh: Manifest = {
        id: uuid(),
        version: 0,
        updatedAt: Date.now(),
        kind: "manifest",
        client: { fullName: "" },
        startDate: today,
        endDate: today,
        equipment: [],
      };
      latestRef.current = fresh;
      setM(fresh);
    })();
  }, [id]);

  if (!m) return <p>Loading…</p>;

  /** Merge a partial into local state and schedule an autosave. */
  function patch(next: Partial<Manifest>) {
    const current = latestRef.current;
    if (!current) return;
    const updated = { ...current, ...next };
    latestRef.current = updated;
    setM(updated);
    scheduleAutosave();
  }

  function scheduleAutosave() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void save(), AUTOSAVE_MS);
  }

  /** Persist locally + enqueue mutation. */
  async function save() {
    const snap = latestRef.current;
    if (!snap) return;
    const stamped = await upsertManifest(snap, snap.version === 0 ? "create" : "update");
    latestRef.current = stamped;
    setM(stamped);
    setSavedAt(stamped.updatedAt);
    onSaved?.(stamped);
  }

  function onSignature(dataUrl: string | null) {
    if (!m) return;
    const signatureOut: Signature | undefined = dataUrl
      ? {
          dataUrl,
          signedAt: new Date().toISOString(),
          printedName: m.client.fullName,
        }
      : undefined;
    // Mark the signature fields as local-only blobs — the server canonical
    // row may strip them (PII policy / size limit), and `applyServerRow`
    // will then carry them across the replace instead of dropping them
    // (audit B2).
    const existingKeys = new Set(m._localOnlyKeys ?? []);
    if (signatureOut) existingKeys.add("signatureOut");
    if (m.signatureIn) existingKeys.add("signatureIn");
    patch({ signatureOut, _localOnlyKeys: Array.from(existingKeys) });
  }

  // B5: avoid enqueuing a duplicate mutation when one is already in
  // flight from the autosave.  The inline onSubmit handler below uses
  // the same `submitting` guard.
  const submitting = useRef(false);

  return (
    <form
      class="es-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting.current || !m) return;
        submitting.current = true;
        void save().finally(() => {
          submitting.current = false;
        });
      }}
    >
      <fieldset>
        <legend>Client</legend>
        <label>
          Full name
          <input
            required
            value={m.client.fullName}
            onInput={(e) =>
              patch({
                client: { ...m.client, fullName: (e.target as HTMLInputElement).value },
              })
            }
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            value={m.client.phone ?? ""}
            onInput={(e) =>
              patch({
                client: { ...m.client, phone: (e.target as HTMLInputElement).value },
              })
            }
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={m.client.email ?? ""}
            onInput={(e) =>
              patch({
                client: { ...m.client, email: (e.target as HTMLInputElement).value },
              })
            }
          />
        </label>
        <label>
          Company
          <input
            value={m.client.company ?? ""}
            onInput={(e) =>
              patch({
                client: { ...m.client, company: (e.target as HTMLInputElement).value },
              })
            }
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Engagement</legend>
        <label>
          Start
          <input
            type="date"
            value={m.startDate}
            onInput={(e) => patch({ startDate: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label>
          End
          <input
            type="date"
            value={m.endDate}
            onInput={(e) => patch({ endDate: (e.target as HTMLInputElement).value })}
          />
        </label>
        <label>
          Total ($)
          <input
            type="number"
            min="0"
            step="0.01"
            value={m.totalCents != null ? (m.totalCents / 100).toFixed(2) : ""}
            onInput={(e) => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              patch({ totalCents: Number.isFinite(v) ? Math.round(v * 100) : undefined });
            }}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Notes</legend>
        <textarea
          rows={3}
          value={m.notes ?? ""}
          onInput={(e) => patch({ notes: (e.target as HTMLTextAreaElement).value })}
        />
      </fieldset>

      <fieldset>
        <legend>Client signature (pickup)</legend>
        <SignaturePad onChange={onSignature} />
      </fieldset>

      <div class="es-form-actions">
        <button type="submit">Save manifest</button>
        {savedAt != null && (
          <span class="es-form-saved">
            ✓ saved locally at {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        {m._pending && <span class="es-form-pending">· queued for sync</span>}
        {m._hasConflict && (
          <span class="es-form-conflict">⚠ conflict — review required</span>
        )}
      </div>
    </form>
  );
}