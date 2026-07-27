# EdgeSync ops

Deployment recipes for the EdgeSync backend.

## Prerequisites

- Node 20.x or newer at `/usr/bin/node` (or wherever your distro installs it)
- systemd >= 245
- A reverse proxy (nginx recommended) for TLS termination and rate limiting
- A data directory the service user can write to (`/var/lib/edgesync/data`)

## Setup

```bash
# 1. Clone the repo to /opt/edgesync
git clone https://github.com/ohgeeceee/edgesync.git /opt/edgesync
cd /opt/edgesync
git checkout v0.2.0   # or main

# 2. Install production deps (skip dev/test).
npm ci --omit=dev

# 3. Build the SPA bundles.
npm run build

# 4. Create the data dir owned by the service user.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin edgesync
sudo install -d -o edgesync -g edgesync /var/lib/edgesync/data

# 5. Generate a bearer token and seed the systemd unit.
TOKEN=$(openssl rand -hex 32)
sudo sed -i "s|__REPLACE_WITH_RANDOM__|${TOKEN}|" /etc/systemd/system/edgesync.service

# 6. Install the unit and start it.
sudo install ops/edgesync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now edgesync.service
sudo systemctl status edgesync.service --no-pager

# 7. Wire nginx.
sudo install ops/edgesync-nginx.conf /etc/nginx/sites-available/edgesync
sudo ln -s /etc/nginx/sites-available/edgesync /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Updating

```bash
cd /opt/edgesync
sudo systemctl stop edgesync.service
git pull --ff-only
npm ci --omit=dev
npm run build
sudo systemctl start edgesync.service
sudo systemctl status edgesync.service --no-pager
```

The SHA bump is fast (< 5 s) so brief downtime is acceptable. For
zero-downtime deploys, run two ports behind nginx and reload-rotate the
upstream with `nginx -s reload` after the second instance boots.

## Backup

The data directory is the only thing that matters:

```bash
sudo systemctl stop edgesync.service   # quiesce writes
sudo tar --xz -C /var/lib/edgesync -cf /backup/edgesync-$(date +%F).tar.gz data
sudo systemctl start edgesync.service
```

Restore:

```bash
sudo systemctl stop edgesync.service
sudo rm -rf /var/lib/edgesync/data
sudo tar -xzf /backup/edgesync-YYYY-MM-DD.tar.gz -C /var/lib/edgesync
sudo systemctl start edgesync.service
```

## Observability

The `GET /api/health` endpoint returns uptime — point your monitoring at it.
`GET /api/stats` surfaces envelope + row counts and is the canonical source
for sync backlog alerts.

There is no logging config in v1; the server logs to stdout (json-line
format from Node's `console.error`/`console.log`). Point systemd's
`StandardOutput=journal` (the default) at your log shipper.

## Limits

- 1 MB body ceiling per envelope.
- 60 requests / 60 s per source IP (configurable via env / CLI flag).
- 10 000-entry envelope idempotency LRU; evicted on a rolling basis.

These are protocol-spec limits — see `docs/api.md`.
