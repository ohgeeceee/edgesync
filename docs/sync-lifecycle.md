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
                POST /api/mutations
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
| Browser/tab closes | IndexedDB retains the entity and envelope. A later page launch or Background Sync event can resume delivery. |
| Duplicate delivery after a lost ACK | The server must use the envelope ID as an idempotency key and return the original outcome. |
| Background Sync is unavailable | The page-side engine retries during app use through online events and heartbeat dispatch. |

## Retry schedule

The delay starts at 500 ms, doubles on each failure, adds ±20% jitter, and is capped at 60 seconds. An envelope is eligible only when `nextAttemptAt <= Date.now()`.

## Current boundary

The production `/api/mutations` server and manual conflict-resolution screen are not part of this foundation. Until the backend exists, local writes remain queued and are never falsely presented as server-synced.
