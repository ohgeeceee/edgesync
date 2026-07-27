/**
 * EdgeSync — App entry point (Phase 5)
 * ----------------------------------------------------------------------------
 * Boots the SyncEngine, mounts the Preact tree, registers the service
 * worker, and wires the StatusBar to engine events.
 *
 * Bundle target: under 30 KB gzipped including Preact + idb.
 */

import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { SyncEngine, type SyncStatus } from "../sync/SyncEngine";
import { StatusBar } from "./StatusBar";
import { ManifestForm } from "./ManifestForm";
import { getAllManifests, queueSize } from "../db/repository";
import type { Manifest } from "../types/domain";

/**
 * The single SyncEngine instance.  We keep its status in a small
 * subscriber registry (set in the constructor's `onStatus`) so any
 * component can read it without prop-drilling the engine object.
 */
export const engine = new SyncEngine({
  onStatus: (s) => console.debug("[edgesync] status", s),
});

/**
 * Tiny SW-update toast — audit M5.  Listens for `controllerchange` and
 * `updatefound`, shows a "Reload for new version" button once the new
 * SW is installed and waiting.  Defensive guards keep this no-op in
 * dev / when no SW is registered.
 */
function useSwUpdatePrompt(): { pending: boolean; reload: () => void } {
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const showUpdate = (sw: ServiceWorker) => {
      setWaiting(sw);
      setPending(true);
    };

    const onUpdateFound = () => {
      const reg = navigator.serviceWorker.controller
        ? null
        : null; /* placeholder */
      void navigator.serviceWorker.ready.then((r) => {
        const sw = r.waiting;
        if (sw) showUpdate(sw);
      });
    };

    navigator.serviceWorker.addEventListener("updatefound", onUpdateFound);
    const onControllerChange = () => {
      // New SW took control — silently reload so we boot against it.
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      navigator.serviceWorker.removeEventListener("updatefound", onUpdateFound);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  return {
    pending,
    reload: () => {
      waiting?.postMessage({ type: "SKIP_WAITING" });
    },
  };
}

function App() {
  const { pending: swUpdate, reload: applySwUpdate } = useSwUpdatePrompt();
  // We hold the current SyncStatus in local state and update it via a
  // custom event the engine emits to the page.
  const [status, setStatus] = useState<SyncStatus>({
    kind: typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "online",
    queueDepth: 0,
  });
  const [manifests, setManifests] = useState<Manifest[]>([]);

  // Boot the engine, refresh the list, then poll every 5 s.
  useEffect(() => {
    engine.start();
    const refresh = async () => {
      setManifests(await getAllManifests());
      const depth = await queueSize();
      setStatus((cur) => {
        const next: SyncStatus = cur.kind === "syncing"
          ? { kind: "syncing", queueDepth: depth, inFlight: depth }
          : typeof navigator !== "undefined" && !navigator.onLine
          ? { kind: "offline", queueDepth: depth }
          : { kind: "online", queueDepth: depth };
        return next;
      });
    };
    void refresh();
    const tick = setInterval(refresh, 5_000);

    // Audit B8: when the SW drains (tab closed, background sync), it
    // posts `{ type: "edge-sync:ack" | "edge-sync:conflict" }` to every
    // open client.  We refresh the entity list so the UI reflects the
    // server canonical row the SW applied — without this the page would
    // still show the optimistic `_pending` state.
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | undefined;
      if (
        data?.type === "edge-sync:ack" ||
        data?.type === "edge-sync:conflict" ||
        data?.type === "edge-sync:failed"
      ) {
        void refresh();
      }
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onMessage);
    }

    return () => {
      clearInterval(tick);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onMessage);
      }
    };
  }, []);

  // Subscribe StatusBar updates via the engine's public subscribe API.
  useEffect(() => engine.subscribe(setStatus), []);

  return (
    <div class="es-app">
      <StatusBar status={status} />
      <main class="es-main">
        <h1>EdgeSync</h1>
        <p class="es-tagline">
          Ultra-lightweight offline-first portal for remote operators.
        </p>

        <section>
          <h2>New / current manifest</h2>
          <ManifestForm onSaved={() => void getAllManifests().then(setManifests)} />
        </section>

        <section>
          <h2>All manifests</h2>
          {manifests.length === 0 ? (
            <p>No manifests yet — fill out the form above.</p>
          ) : (
            <ul class="es-manifests">
              {manifests.map((m) => (
                <li key={m.id} class={m._pending ? "is-pending" : ""}>
                  <strong>{m.client.fullName || "(unnamed)"}</strong>
                  {" — "}
                  {m.startDate} → {m.endDate}
                  {m._pending && <span class="es-badge">queued</span>}
                  {m._hasConflict && (
                    <span class="es-badge es-badge--warn">conflict</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      {swUpdate && (
        <div class="es-sw-update" role="status">
          A new version is ready.
          <button type="button" onClick={applySwUpdate}>Reload</button>
        </div>
      )}
    </div>
  );
}

// Mount.
const root = document.getElementById("root");
if (root) render(<App />, root);

// Register the service worker (production only — guard for dev tools).
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => console.warn("[edgesync] SW registration failed", err));
  });
}