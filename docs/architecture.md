# EdgeSync architecture

## Goal

EdgeSync keeps core business work available when the network is absent. User writes commit to local durable storage first; network synchronization is a secondary process that may happen immediately or much later.

## Runtime components

```text
Preact UI
  │ local reads/writes
  ▼
Repository layer ───────► IndexedDB
  │                       manifests
  │ dispatch              serviceRecords
  ▼                       syncQueue
SyncEngine                mediaBlobs / meta
  │ POST /api/mutations        ▲
  ▼                            │
Sync backend              Service Worker
                              │ cache shell + drain queue
                              ▼
                         Cache Storage
```

### UI

`src/ui/` contains the manifest workflow, global sync status, and signature capture. The form does not wait for a server response: it persists locally and renders the optimistic result.

### Repository

`src/db/repository.ts` is the only CRUD layer. An entity change and its `MutationEnvelope` are inserted in one IndexedDB transaction, preventing an entity without a matching queue record (or the reverse).

### Sync engine

`src/sync/SyncEngine.ts` drains eligible envelopes from the page, reports status, retries transient failures with exponential backoff, applies canonical rows returned by the server, and marks 409 conflicts for manual review.

### Service worker

`src/sw/service-worker.ts` precaches the application shell, caches read requests, and provides a Background Sync queue drainer. It allows the app to start offline after one successful online load.

## IndexedDB schema

Database: `edgesync`, version 1.

| Store | Key | Important indexes | Purpose |
|---|---|---|---|
| `manifests` | `id` | `by-updatedAt` | Booking/manifest records |
| `serviceRecords` | `id` | `by-manifest`, `by-updatedAt` | Work logs linked to manifests |
| `syncQueue` | `id` | `by-status`, `by-nextAt` | Durable mutation envelopes |
| `mediaBlobs` | `id` | — | Photos and other binary data |
| `meta` | `key` | — | Small application metadata |

## Synchronization contract

The client sends one `MutationEnvelope` per request to `POST /api/mutations`. The endpoint is not implemented in this repository yet.

Expected responses:

- **2xx**: JSON `{ "row": <canonical entity> }` for the page-side engine. The client applies that row and removes the envelope. A body without `row` is accepted as an acknowledgement and only removes the envelope.
- **409**: JSON `{ "serverVersion": number, "serverRow": object }`. The envelope becomes `conflict`, the local entity gets `_hasConflict = true`, and automatic retries stop.
- **5xx/network error**: the envelope returns to `pending` with a jittered exponential delay.
- **Other 4xx**: the envelope becomes `failed`; operator/admin intervention is required.

The server must treat the envelope `id` as an idempotency key so a response lost in transit cannot duplicate the mutation.

## Conflict policy

Server versions are monotonic per entity. EdgeSync does not merge free-form fields automatically. A version conflict is preserved locally and surfaced for a future manual-review interface. Until that interface exists, conflict state is visible but cannot be resolved inside the app.

## Deliberate boundaries

This foundation does **not** include:

- production authentication/authorization,
- the sync backend or its durable database,
- a manual conflict-resolution screen,
- service-record creation UI,
- production deployment configuration.
