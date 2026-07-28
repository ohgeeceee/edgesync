# EdgeSync sync lifecycle

A mutation travels through the same durable path whether the device is online or offline.

```text
Operator edits a manifest
        │
        ▼
Preact updates local form state
        │ debounced autosave / explicit Save
        ▼
Repository opens one IndexedDB transaction
        ├── writes entity with _pending = true
        └── inserts pending MutationEnvelope
        │
        ▼
Page refreshes optimistic UI immediately
        │
        ├── online: SyncEngine posts eligible envelopes
        └── offline: Background Sync is registered when available
                         │
                         ▼
                POST /api/mutations on the backend
                  │             │
             2xx success     409 conflict
                  │             │
       apply canonical row      ├── preserve server conflict payload
       clear _pending           ├── set local _hasConflict = true
       delete envelope          └── stop automatic retry
```

## Failure-mode contract

| Failure | EdgeSync behavior |
|---|---|
| Network unavailable before dispatch | Envelope remains `pending`; Background Sync is registered when supported. |
| Network drops mid-request | Envelope returns to `pending`, retry count increments, and `nextAttemptAt` receives jittered exponential backoff. |
| Server returns 5xx | Same transient retry path as a network error. |
| Server returns 409 | Envelope becomes `conflict`; server payload is preserved; local entity is marked for manual review. |
| Server returns another 4xx | Envelope becomes terminal `failed`; it is not automatically retried. |
| Server returns 401 | The Bearer token (if configured) was rejected; re-auth and retry. |
| Server returns 413 | The envelope body exceeded the 1 MB ceiling; usually means a signature that should be chunked into its own envelope. |
| Server returns 429 | Rate-limited; honor the `retryAfterMs` and reschedule the next attempt. |
| Server returns 200 with `replay: true` | Idempotent re-delivery; nothing to do. |
| Browser/tab closes | IndexedDB retains the entity and envelope. A later page launch or Background Sync event can resume delivery. |
| Duplicate delivery after a lost ACK | Server uses the envelope ID as an idempotency key and replays the original 200. |
| Background Sync is unavailable | The page-side engine retries during app use through online events and heartbeat dispatch. |

## Backend contract

The Node stdlib backend (`backend/server.mjs`) exposes:

- `POST /api/mutations` — the only mutating endpoint.
- `GET /api/health` — uptime + version.
- `GET /api/stats` — row counts and envelope index size.
- `GET /api/manifests/:id` — for tooling and tests.

Full request/response shapes, status codes, and idempotency semantics live in [`docs/api.md`](api.md).

## Retry schedule

The delay starts at 500 ms, doubles on each failure, adds ±20% jitter, and is capped at 60 seconds. An envelope is eligible only when `nextAttemptAt <= Date.now()`.

## Current boundary

The Page `SyncEngine` and the Service Worker both drain the queue. A `navigator.locks` mutex named `edgesync-drain` ensures only one context runs at a time. The Service Worker caps each `sync` event at 50 envelopes so the SW lifecycle isn't exhausted on huge queues. The backend applies whatever the first drainer sends; the second drainer sees a 200 `{replay: true}` and no-ops.

Until more sophisticated tooling exists, conflict resolution is manual — the UI surfaces `_hasConflict = true` but does not yet present a side-by-side editor. That is the next significant UX slice.

