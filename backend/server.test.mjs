/**
 * Backend HTTP tests — drives a real server on a random port and asserts
 * the protocol documented in docs/api.md.
 *
 *   POST /api/mutations                — happy path 200, 409 conflict,
 *                                          400 shape, 401 auth, 413 too large,
 *                                          429 rate limited, 200 idempotent replay,
 *                                          404 unknown delete
 *   GET  /api/health                    — 200 with ok + version
 *   GET  /api/stats                     — counts + ts
 *   GET  /api/manifests/:id             — 200 / 404
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startServer } from "./server.mjs";

function freshDataDir() {
  return mkdtempSync(join(tmpdir(), "edgesync-srv-"));
}

async function withServer(opts, run) {
  const server = await startServer({ ...opts });
  try { return await run(server); } finally { await server.close(); }
}

function envelope(overrides = {}) {
  return {
    id: "env-default",
    entity: "manifest",
    action: "create",
    payload: {
      id: "M-default",
      kind: "manifest",
      version: 0,
      updatedAt: 1700000000000,
      client: { fullName: "Ada" },
      startDate: "2026-07-01",
      endDate: "2026-07-03",
      equipment: [],
    },
    timestamp: 1700000000000,
    status: "pending",
    retryCount: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function postEnv(url, env, headers) {
  return postJson(url, env, headers);
}

const URL_BASE = (port) => `http://127.0.0.1:${port}`;

test("POST /api/mutations: happy path applies create and returns canonical row", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, envelope());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.row.id, "M-default");
    assert.equal(body.row.version, 1); // server bumps 0 -> 1 on create
  });
});

test("POST /api/mutations: replay returns the same row", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const env = envelope({ id: "env-replay-1", payload: { ...envelope().payload, id: "M-rp" } });
    const first = await postEnv(`${URL_BASE(port)}/api/mutations`, env);
    const second = await postEnv(`${URL_BASE(port)}/api/mutations`, env);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json();
    const b = await second.json();
    assert.equal(b.replay, true);
    assert.deepEqual(b.row, a.row);
  });
});

test("POST /api/mutations: 409 conflict when version is not strictly greater", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const create = envelope({ id: "env-c-1", payload: { ...envelope().payload, id: "M-409" } });
    await postEnv(`${URL_BASE(port)}/api/mutations`, create);

    const stale = envelope({
      id: "env-c-2",
      action: "update",
      payload: { ...create.payload, id: "M-409", version: 0, client: { fullName: "Eve" } },
    });
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, stale);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.serverRow.client.fullName, "Ada"); // unchanged
    assert.equal(body.serverVersion, 1);
  });
});

test("POST /api/mutations: 400 on malformed envelope", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const res = await postJson(`${URL_BASE(port)}/api/mutations`, { id: "x" });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "shape");
  });
});

test("POST /api/mutations: 401 when bearer required and missing", async () => {
  await withServer({ dataDir: freshDataDir(), authToken: "s3cret" }, async ({ port }) => {
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, envelope());
    assert.equal(res.status, 401);
  });
});

test("POST /api/mutations: 401 when bearer wrong", async () => {
  await withServer({ dataDir: freshDataDir(), authToken: "s3cret" }, async ({ port }) => {
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, envelope(), {
      Authorization: "Bearer wrong",
    });
    assert.equal(res.status, 401);
  });
});

test("POST /api/mutations: bearer accepted", async () => {
  await withServer({ dataDir: freshDataDir(), authToken: "s3cret" }, async ({ port }) => {
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, envelope(), {
      Authorization: "Bearer s3cret",
    });
    assert.equal(res.status, 200);
  });
});

test("POST /api/mutations: 404 on delete of unknown id", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const env = envelope({
      id: "env-del-1",
      action: "delete",
      payload: { id: "M-nope", version: 1 },
    });
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, env);
    assert.equal(res.status, 404);
  });
});

test("POST /api/mutations: 413 when body exceeds the 1 MB ceiling", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const huge = {
      id: "env-too-big",
      entity: "manifest",
      action: "create",
      payload: {
        id: "M-huge",
        kind: "manifest",
        version: 0,
        updatedAt: 1,
        client: { fullName: "X".repeat(1024 * 1024) },
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        equipment: [],
      },
      timestamp: 1,
      status: "pending",
      retryCount: 0,
      nextAttemptAt: 0,
    };
    const res = await postEnv(`${URL_BASE(port)}/api/mutations`, huge);
    assert.equal(res.status, 413);
  });
});

test("GET /api/health: returns ok + version", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    const res = await fetch(`${URL_BASE(port)}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.equal(typeof body.uptimeMs, "number");
  });
});

test("GET /api/stats: empty at start, grows with writes", async () => {
  const dir = freshDataDir();
  await withServer({ dataDir: dir }, async ({ port }) => {
    const empty = await (await fetch(`${URL_BASE(port)}/api/stats`)).json();
    assert.equal(empty.rows, 0);
    assert.equal(empty.envelopes, 0);

    await postEnv(`${URL_BASE(port)}/api/mutations`, envelope());

    const filled = await (await fetch(`${URL_BASE(port)}/api/stats`)).json();
    assert.equal(filled.rows, 1);
    assert.equal(filled.byEntity.manifest, 1);
    assert.equal(filled.envelopes, 1);
  });
});

test("GET /api/manifests/:id: returns row or 404", async () => {
  await withServer({ dataDir: freshDataDir() }, async ({ port }) => {
    await postEnv(`${URL_BASE(port)}/api/mutations`, envelope());
    const ok = await fetch(`${URL_BASE(port)}/api/manifests/M-default`);
    assert.equal(ok.status, 200);
    const missing = await fetch(`${URL_BASE(port)}/api/manifests/never`);
    assert.equal(missing.status, 404);
  });
});

test("rate limiter caps at the configured window", async () => {
  await withServer(
    { dataDir: freshDataDir(), rateLimit: { max: 3, windowMs: 60_000 } },
    async ({ port }) => {
      const u = `${URL_BASE(port)}/api/mutations`;
      const env = envelope({ id: "rate-1", payload: { ...envelope().payload, id: "M-rate-1" } });
      assert.equal((await postEnv(u, env)).status, 200);
      // Same envelope-id replays return 200 (idempotency) and don't burn rate.
      // So we need *different* envelopes to test the cap.
      assert.equal(
        (await postEnv(u, envelope({ id: "rate-2", payload: { ...envelope().payload, id: "M-rate-2" } }))).status,
        200,
      );
      assert.equal(
        (await postEnv(u, envelope({ id: "rate-3", payload: { ...envelope().payload, id: "M-rate-3" } }))).status,
        200,
      );
      const fourth = await postEnv(u, envelope({ id: "rate-4", payload: { ...envelope().payload, id: "M-rate-4" } }));
      assert.equal(fourth.status, 429);
      const body = await fourth.json();
      assert.equal(body.error, "rate_limited");
    },
  );
});
