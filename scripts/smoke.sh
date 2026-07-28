#!/bin/sh
# Blackbox smoke test for the sync backend.
# Boots the server in the background, hits each public endpoint,
# kills the server, and prints the bytes from the data directory.

set -e
mkdir -p backend/data
node backend/server.mjs --port 8787 --host 127.0.0.1 --datadir backend/data > /tmp/edgesync-srv.log 2>&1 &
SERVER_PID=$!
sleep 1

echo ">>> GET /api/health"
curl -s -i http://127.0.0.1:8787/api/health | head -5
echo

echo ">>> GET /api/stats (empty)"
curl -s http://127.0.0.1:8787/api/stats
echo

echo ">>> POST /api/mutations (create)"
curl -s -X POST -H "Content-Type: application/json" -d '{
  "id": "smoke-1",
  "entity": "manifest",
  "action": "create",
  "payload": {
    "id": "M-smoke",
    "kind": "manifest",
    "version": 0,
    "updatedAt": 1700000000000,
    "client": { "fullName": "Smoke" },
    "startDate": "2026-07-01",
    "endDate": "2026-07-01",
    "equipment": []
  },
  "timestamp": 1700000000000,
  "status": "pending",
  "retryCount": 0,
  "nextAttemptAt": 0
}' http://127.0.0.1:8787/api/mutations
echo

echo ">>> POST /api/mutations (idempotent replay)"
curl -s -i -X POST -H "Content-Type: application/json" -d '{
  "id": "smoke-1",
  "entity": "manifest",
  "action": "create",
  "payload": {
    "id": "M-smoke",
    "kind": "manifest",
    "version": 0,
    "updatedAt": 1700000000000,
    "client": { "fullName": "Smoke" },
    "startDate": "2026-07-01",
    "endDate": "2026-07-01",
    "equipment": []
  },
  "timestamp": 1700000000000,
  "status": "pending",
  "retryCount": 0,
  "nextAttemptAt": 0
}' http://127.0.0.1:8787/api/mutations | head -8
echo

echo ">>> GET /api/manifests/M-smoke"
curl -s http://127.0.0.1:8787/api/manifests/M-smoke | head -c 200
echo
echo

echo ">>> GET /api/stats (after)"
curl -s http://127.0.0.1:8787/api/stats
echo

# Tear down
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

echo ">>> data tree"
find backend/data -type f | sort
echo

echo ">>> server log"
tail -5 /tmp/edgesync-srv.log
