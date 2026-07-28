# EdgeSync

EdgeSync is an ultra-lightweight, offline-first business portal for operators who work where connectivity is intermittent or unavailable. The current foundation supports durable local manifests, optimistic saves, queued synchronization, conflict flags, signatures, and a service-worker app shell.

## What's in the repo

| Path | Purpose |
|---|---|
| `public/` | App shell (index.html, manifest, icons, CSS). Built bundles land here. |
| `src/` | Preact + TypeScript SPA: IndexedDB repository, sync engine, service worker, UI. |
| `backend/` | Node stdlib sync server (zero runtime deps). Stores envelopes + rows under `data/`. |
| `docs/` | Architecture, sync lifecycle, and the wire protocol. |
| `ops/` | systemd unit + nginx snippet for production deploy. |
| `scripts/` | Dev server, icon builder, payload meter, full-suite test runner. |
| `.github/workflows/ci.yml` | Lint + test + build + payload budget on every PR. |

## Run locally

```bash
npm ci
npm run build
npm run test:all          # vitest (frontend) + node --test (backend)
npm run serve             # public/ on http://127.0.0.1:8080
npm run --silent -- backend/server.mjs --port 8787 --datadir ./data
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Type-check and produce minified app/SW bundles |
| `npm test` | Vitest suite in jsdom with fake IndexedDB |
| `npm run test:backend` | Node's built-in test runner over `backend/*.test.mjs` |
| `npm run test:all` | Frontend + backend sequentially, abort on first failure |
| `npm run lint` | `tsc --noEmit` (strict, ES2020 target) |
| `npm run serve` | Serve `public/` on `http://127.0.0.1:8080` |
| `node backend/server.mjs --port 8787 --datadir ./data` | Run the backend |
| `python scripts/measure_payload.py` | Verify the <150 KB gzipped budget |

## Architecture

- [`docs/architecture.md`](docs/architecture.md) — components, storage schema, boundaries.
- [`docs/sync-lifecycle.md`](docs/sync-lifecycle.md) — mutation lifecycle and failure handling.
- [`docs/api.md`](docs/api.md) — backend wire protocol (envelopes, conflicts, idempotency).

## Bandwidth target

The complete first-load shell must remain below **150 KB gzipped**. No runtime CDN assets or heavy UI framework are required. The CI workflow enforces this on every PR via `scripts/measure_payload.py`.

## Status

| Layer | State | Tests |
|---|---|---|
| SPA (`src/`) | Stable | 12 vitest (jsdom) |
| Backend (`backend/`) | Stable | 19 node:test |
| CI | Configured | Lint + test + build + payload on every PR |

