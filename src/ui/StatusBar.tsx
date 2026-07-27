/**
 * EdgeSync — Global Network & Sync Status Bar (Phase 5)
 * ----------------------------------------------------------------------------
 * Slim, dependency-free Preact component that renders one of four states:
 *   - online      — green dot, "Online · all synced" or "Online · N queued"
 *   - offline     — amber dot, "Offline" or "Offline · N queued — will sync when back"
 *   - syncing     — blue pulsing dot, "Syncing · N queued"
 *   - error       — red dot, "Sync error: <msg>"
 *
 * Visual states are driven by the parent's `status` prop.  This component
 * is purely presentational — no network awareness of its own.
 */

import { h } from "preact";
import type { SyncStatus } from "../sync/SyncEngine";

export interface StatusBarProps {
  status: SyncStatus;
}

const dotColor: Record<SyncStatus["kind"], string> = {
  online: "#16a34a",  // green
  offline: "#d97706", // amber
  syncing: "#2563eb", // blue
  error: "#dc2626",   // red
};

export function StatusBar({ status }: StatusBarProps) {
  const label = (() => {
    switch (status.kind) {
      case "online":
        return status.queueDepth === 0
          ? "Online · all synced"
          : `Online · ${status.queueDepth} queued`;
      case "offline":
        return status.queueDepth === 0
          ? "Offline"
          : `Offline · ${status.queueDepth} queued — will sync when back`;
      case "syncing":
        return `Syncing · ${status.queueDepth} queued`;
      case "error":
        return `Sync error: ${status.message}`;
    }
  })();

  return (
    <div class="es-statusbar" role="status" aria-live="polite">
      <span
        class={`es-dot es-dot--${status.kind}`}
        style={{ background: dotColor[status.kind] }}
      />
      <span class="es-status-label">{label}</span>
    </div>
  );
}