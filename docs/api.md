# EdgeSync backend protocol (v1)

Wire contract between the EdgeSync client and the Node stdlib sync backend. Both sides MUST implement this contract; everything else in the system is local.

## Endpoints

### `POST /api/mutations`

Apply one envelope to the durable store.

**Headers**

| Header | Required | Notes |
|---|---|---|
| `Authorization: Bearer <token>` | Yes when `EDGESYNC_REQUIRE_AUTH=1`; otherwise optional | Audit B9 — the bearer is the only anti-envelope-spoofing control we have. |
| `Content-Type: application/json` | Yes | |

**Request body** — a `MutationEnvelope` from `src/types/domain.ts`:

```ts
{
  id: string;           // envelope UUID — client-generated, idempotency key
  entity: "manifest" | "service_record";
  action: "create" | "update" | "delete";
  payload: unknown;     // full entity (create/update) or { id, version } (delete)
  timestamp: number;    // epoch ms
  status: SyncStatus;
  retryCount: number;
  nextAttemptAt: number;
  lastError?: string;
}
```

**Responses**

| Status | Body | When |
|---|---|---|
| `200 OK` | `{ "row": <canonical entity> }` | Applied. `row.version` is the server-assigned monotonic version. |
| `200 OK` | `{}` | Applied (degenerate ack when no canonical row was produced — the server simply bumps `lastSeenAt`). |
| `200 OK` | `{ "replay": true, "row": <canonical entity> }` | Idempotent replay — the envelope `id` was already applied; the canonical row is the same one returned originally. The client MUST treat this identically to the success path. |
| `400 Bad Request` | `{ "error": "shape" }` | Envelope shape didn't validate. Client MUST mark the envelope `failed`. |
| `401 Unauthorized` | `{ "error": "auth" }` | Missing/invalid Bearer when auth is required. |
| `404 Not Found` | `{ "error": "unknown_envelope_id" }` | `action === "delete"` and the entity id is unknown to the server (no-op is OK, but we surface it for the UI). |
| `409 Conflict` | `{ "serverVersion": number, "serverRow": <canonical> }` | The incoming version is not strictly greater than the stored version. Client MUST mark the envelope `conflict` and the entity `_hasConflict=true`. |
| `413 Payload Too Large` | `{ "error": "too_large" }` | Body exceeded `MAX_BODY_BYTES` (default 1 MB). Client MUST keep the envelope pending and retry; usually it means signature data is too big for the transport. |
| `429 Too Many Requests` | `{ "error": "rate_limited", "retryAfterMs": number }` | Per-IP rate limit exceeded. Client SHOULD schedule the next attempt at `Date.now() + retryAfterMs`. |
| `5xx` | `{ "error": "transient" }` | Transient — exponential backoff. |

### `GET /api/health`

`{ "ok": true, "version": "0.1.0", "uptimeMs": number }`.

### `GET /api/stats`

`{ "rows": number, "envelopes": number, "byEntity": { "manifest": n, "service_record": n }, "ts": iso }`.

### `GET /api/manifests/:id` (v1 optional, used by tests)

Returns the stored canonical row or 404. Tests use this to assert the server actually wrote.

## Conflict semantics

Server `version` is **strictly monotonic per entity**. For `update` and `delete`:

```text
incoming.version > stored.version    → apply
incoming.version === stored.version  → 409 (idempotent replay handled separately by envelope id)
incoming.version < stored.version    → 409
```

For `create` (envelope `action === "create"`), the version of the payload is expected to be `0`. The server:

- creates a new row with `version = 1` if no row exists at that id;
- treats `create` of an existing id as a 409 (something else got there first).

## Idempotency

The server remembers envelope ids it has already applied. On replay (the same `id` seen twice):

1. Looks up the stored canonical row that resulted.
2. Returns `200 OK` with `{ "replay": true, "row": ... }` so the client converges to the same row.
3. Does NOT mutate the stored version a second time.

Envelope ids are remembered in a sidecar index (`data/_envelopes.json`) pruned to the last 10 000.

## Versioning

A response always carries the canonical row. Clients MUST use `applyServerRow` (or the SW equivalent) to merge it. Server-truth wins for any field present in both. Local-only fields named in the entity's `_localOnlyKeys` are preserved across the merge.

## Auth

- `Authorization: Bearer <token>` is enforced when env var `EDGESYNC_REQUIRE_AUTH=1` is set.
- Tokens are compared in constant time (`crypto.timingSafeEqual`).
- When auth is not required, anonymous access is granted. Set `EDGESYNC_REQUIRE_AUTH=1` for any internet-facing deployment.

## Body size

A 1 MB ceiling protects the server from runaway signatures and oversized media. Clients should chunk large media into separate envelopes (a follow-up issue; not part of v1).

## Limits

- 60 requests / 60 s per source IP, sliding window.
- 10 000 envelopes retained in the idempotency index before LRU pruning.

## Examples

```bash
# Happy path (no auth required)
curl -X POST http://localhost:8787/api/mutations \
  -H 'Content-Type: application/json' \
  -d '{"id":"m1","entity":"manifest","action":"create","payload":{"id":"manifest-A","kind":"manifest","version":0,"updatedAt":1700000000000,"client":{"fullName":"Ada"},"startDate":"2026-07-01","endDate":"2026-07-03","equipment":[]},"timestamp":1700000000000,"status":"pending","retryCount":0,"nextAttemptAt":0}'

# 409 path
curl -i -X POST http://localhost:8787/api/mutations \
  -H 'Content-Type: application/json' \
  -d '{"id":"m2","entity":"manifest","action":"update","payload":{"id":"manifest-A","kind":"manifest","version":0,"updatedAt":1700000010000,"client":{"fullName":"Bob"},"startDate":"2026-07-01","endDate":"2026-07-03","equipment":[]},"timestamp":1700000010000,"status":"pending","retryCount":0,"nextAttemptAt":0}'

# With auth
curl -X POST http://localhost:8787/api/mutations \
  -H 'Authorization: Bearer secret-token' \
  -H 'Content-Type: application/json' \
  -d @envelope.json
```

## What v1 deliberately does NOT include

- Authentication (a real user store, OAuth, refresh tokens). Bearer is a stopgap.
- An admin UI. Operators inspect via the JSON files in `data/` directly.
- Streaming / chunked upload. 1 MB ceiling applies.
- A real database. Storage is per-row JSON on disk with atomic renames.
- Multi-region replication.

These are tracked as follow-ups; v1 is the smallest thing that satisfies the foundation's contract.
