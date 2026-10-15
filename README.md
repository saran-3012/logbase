# Logbase

A self-hosted log ingestion and monitoring server with a web UI, full-text search, and a pluggable **collector** model for getting data in.

## Features

- **User accounts** — register and log in via a clean web UI
- **Collectors** — each ingestion endpoint is configured as a collector: pick a *transfer type* (HTTP / UDP), an *auth method*, and an *input format*. Enable or disable any collector at will.
- **Batch ingestion** — `json_array` (each array element is one event) or `ndjson` (each line is one event), up to 1000 events per batch
- **UDP listener** — dedicated-port, unauthenticated datagram ingestion with backpressure, micro-batched writes, and a loopback self-test
- **Full-text search** — SQLite FTS5 across `app`, `level`, `message`, and all metadata fields
- **Logs explorer** — level pills with live counts, a stacked event-volume histogram, time-range presets, app/collector filters, an event detail pane with the raw JSON, live tail, and NDJSON export
- **24-hour retention** — configurable automatic purge
- **OAuth 2.0** — Client Credentials grant with refresh token rotation and stolen-token detection
- **API tokens** — simple static tokens for lightweight integrations

---

## Collectors

A **collector** is one configured way for logs to reach Logbase.

| Transfer type | Auth methods | Input formats | Port | Limit |
|---|---|---|---|---|
| `http` | `api_token`, `oauth_client_credentials` | `json_array`, `ndjson` | — (shared HTTP port) | unlimited |
| `udp` | `none` | `json_array`, `ndjson` | dedicated, from `UDP_PORT_RANGE` | **1 per user**, `UDP_MAX_LISTENERS` active server-wide |

Create collectors in the dashboard under **Collectors**, or via `POST /collectors`. Credentials are shown **once** at creation (and on rotate) and are never recoverable afterwards.

### Input formats

Both formats support batching; the collector's `input_format` decides how a payload is read.

**`json_array`** — the payload must be a JSON array. Each element is one event.

```json
[
  {"app":"my-service","level":"info","message":"Started"},
  {"app":"my-service","level":"error","message":"Crashed","code":500}
]
```

**`ndjson`** — one JSON object per line. Blank lines are skipped, and a malformed
line is counted in `rejected` instead of failing the whole batch:

```
{"app":"my-service","level":"info","message":"Started"}
{"app":"my-service","level":"error","message":"Crashed","code":500}
```

Sending the wrong shape returns a precise `400`:

```json
{ "error": "Collector expects input_format \"json_array\" — payload must be a JSON array, received a JSON object" }
```

A successful ingest responds:

```json
{ "ok": true, "inserted": 2, "rejected": 0 }
```

---

## UDP ingestion

A UDP collector binds its own port and ingests every datagram that arrives.

```bash
# ndjson collector on port 10001
printf '{"app":"edge","level":"error","message":"timeout"}\n' | nc -u -w1 your-host 10001

# json_array collector
printf '[{"app":"edge","level":"warn","message":"retry"}]' | nc -u -w1 your-host 10001
```

**Behaviour and limits**

- **No authentication.** Anything that can reach `host:port` can write logs into that collector. Only expose it on a trusted network.
- **No response, no delivery guarantee.** Failures are visible only through the collector's `rejected_count` / server logs, never to the sender.
- **One datagram = one batch.** Keep payloads under ~1472 bytes (safe MTU); the hard cap is `UDP_MAX_PACKET_BYTES` (65507). An oversized `json_array` arrives truncated and fails to parse, whereas NDJSON only loses the clipped line — **NDJSON is the recommended UDP format.**
- **Backpressure.** Datagrams queue (`UDP_QUEUE_SIZE`) and are drained in micro-batches (`UDP_DRAIN_BATCH` events per transaction). Overflow is dropped and logged.
- **One UDP collector per user**, enforced by a partial unique index. `UDP_MAX_LISTENERS` (default `1`) caps how many may be *active* server-wide; the next one gets `409 capacity_exceeded`.
- Disabling a collector closes its socket immediately; enabling binds it synchronously, so a port conflict is reported as `409` with the OS error code rather than failing silently.

### ⚠️ UDP on Render

**Render web services route HTTP(S) to a single port and do not route inbound UDP on any service type.** On Render the socket binds inside the container and the full parse → store pipeline works — verify with `POST /collectors/:id/test`, which sends a loopback datagram — but external datagrams never arrive. The dashboard reports this honestly as *"Bound (no platform ingress)"*.

Two working options:

1. **Deploy where UDP is routable** — `docker compose up` publishes `10000-10010/udp`, as does any VPS/EC2 host.
2. **Use the bundled forwarder** — run [`tools/udp-forwarder`](tools/udp-forwarder/README.md) next to your log source. It accepts UDP locally and relays batches over HTTPS to an HTTP collector:

```bash
LISTEN_PORT=10000 \
LOGBASE_URL=https://your-app.onrender.com/logs \
LOGBASE_TOKEN=<api token of an http collector> \
INPUT_FORMAT=ndjson \
npm run udp-forwarder
```

---

## Getting Started

### Run with Docker (recommended for UDP)

```bash
# 1. Set your secret (required)
export JWT_SECRET=$(openssl rand -hex 32)
export TURSO_DATABASE_URL=libsql://your-db.turso.io
export TURSO_AUTH_TOKEN=...

# 2. Build and start — publishes 3000/tcp and 10000-10010/udp
docker compose up -d

docker compose logs -f
```

### Run without Docker

**Prerequisites:** Node.js **v18+** (v22 recommended)

```bash
git clone <repo-url> logbase
cd logbase
npm install
cp .env.example .env     # then set JWT_SECRET and TURSO_DATABASE_URL
npm start                # or: npm run dev
```

Open **http://localhost:3000**.

### Deploy to Render

`render.yaml` is included as a blueprint (web service, `/healthz` health check, env vars pre-declared).

#### Does a `git push` deploy automatically?

Yes — **if** your Render service already has Auto-Deploy enabled for the `master`
branch (this is the default for services created from a GitHub repo). Pushing to
`master` triggers a build and a rolling restart. Nothing else is required.

`.github/workflows/ci.yml` runs on the same push and verifies the build
independently (syntax, schema compilation, boot, and a live ingest smoke test
including a real UDP datagram). It does **not** gate the Render deploy — Render
watches the branch directly. To make CI a gate, switch the service to
*Deploy Hook* and call the hook from the workflow after `verify` succeeds.

#### Required before the first deploy of this release

1. **Add the new environment variables** (see the table below). They all have
   safe defaults except the pre-existing `JWT_SECRET` / `TURSO_*`, so the
   service boots without them — but set them explicitly if you want anything
   other than the defaults.
2. **The v2 migration is destructive and runs automatically on boot.** It drops
   `logs`, `logs_fts`, `api_tokens`, `oauth_clients` and `oauth_refresh_tokens`,
   then recreates the collector-era schema. All existing logs and credentials
   are permanently lost.
3. **Re-issue credentials.** Every integration needs a new API token or OAuth
   client, created under **Collectors** in the dashboard.

#### UDP on Render

Render web services route **HTTP(S) to a single port only** — inbound UDP is not
routed on any service type. A UDP collector created on Render binds inside the
container and the parse → store pipeline works (prove it with
`POST /collectors/:id/test`), but external datagrams never arrive. The dashboard
reports this honestly as *"Bound (no platform ingress)"*.

For real UDP ingestion either:

- deploy with `docker compose` / on a VPS where UDP ports are reachable, or
- run `tools/udp-forwarder` next to your log source — it accepts UDP locally and
  forwards over HTTPS to an HTTP collector on Render.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | *(required)* | Signs session and OAuth tokens |
| `JWT_EXPIRES_IN` | `7d` | Session token lifetime |
| `LOG_RETENTION_HOURS` | `24` | Hours before logs are purged |
| `DB_ADAPTER` | `libsql` | Database adapter |
| `TURSO_DATABASE_URL` | *(required)* | `libsql://…` or `file:./data/logs.db` |
| `TURSO_AUTH_TOKEN` | — | Required for Turso cloud |
| `INGEST_BODY_LIMIT` | `10mb` | Max HTTP body on `/logs` |
| `MAX_BATCH_SIZE` | `1000` | Max events per batch |
| `PUBLIC_INGEST_HOST` | — | Host shown in dashboard snippets |
| `UDP_ENABLED` | `true` | Master switch for UDP collectors |
| `UDP_BIND_HOST` | `0.0.0.0` | Listener bind address |
| `UDP_PORT_RANGE` | `10000-10010` | Allowed collector ports (must be >1024) |
| `UDP_MAX_LISTENERS` | `1` | Concurrently active UDP listeners |
| `UDP_MAX_PACKET_BYTES` | `65507` | Larger datagrams are dropped |
| `UDP_QUEUE_SIZE` | `5000` | Backpressure queue depth |
| `UDP_DRAIN_BATCH` | `200` | Events coalesced per DB transaction |
| `UDP_RECONCILE_INTERVAL_MS` | `60000` | DB ↔ socket reconciliation interval |

**New in this release:** every `INGEST_*`, `MAX_BATCH_SIZE`, `PUBLIC_INGEST_HOST`
and `UDP_*` variable above. All have working defaults — add them only to override.

> **Important:** Change `JWT_SECRET` to a long random string before running in production.

---

## Project Structure

```
logbase/
├── src/
│   ├── db/
│   │   ├── database.js              # Adapter wiring, schema init, migrations
│   │   ├── adapters/                # libsql adapter + base interface
│   │   ├── compilers/               # Query-object → SQL per dialect
│   │   ├── query/                   # Fluent query builders
│   │   └── schema/                  # tables.json, indexes.json, migrations.json
│   ├── ingest/
│   │   ├── registry.js              # Transfer × auth × format capability matrix
│   │   ├── formats.js               # json_array / ndjson parsers
│   │   ├── pipeline.js              # normaliseEntry + storeEvents (all transports)
│   │   ├── listenerManager.js       # DB ↔ socket reconciliation, queue, self-test
│   │   └── transports/udp.js        # dgram socket wrapper
│   ├── middleware/
│   │   ├── sessionAuth.js           # Dashboard JWT
│   │   └── collectorAuth.js         # Ingest auth → resolves req.collector
│   └── routes/
│       ├── auth.js                  # Register, login
│       ├── collectors.js            # Collector CRUD, enable/disable, rotate, test
│       ├── logs.js                  # Ingestion and retrieval
│       └── oauth.js                 # Token issuance + rotation
├── public/
│   ├── index.html                   # Sign in / create account
│   ├── dashboard.html               # Logs explorer, collectors, new-collector wizard
│   ├── css/app.css                  # Design tokens + all component styles
│   └── js/{auth,dashboard}.js       # Client logic (no build step, no framework)
├── scripts/db-reset.js              # Destructive schema reset
├── tools/udp-forwarder/             # UDP → HTTP relay for UDP-less platforms
├── render.yaml                      # Render blueprint
└── docker-compose.yml
```

---

## API Reference

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | None | Create a new account |
| `POST` | `/auth/login` | None | Login — returns a JWT session token |

### Collectors

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/collectors/capabilities` | Session JWT | Transfer/auth/format matrix + UDP runtime config |
| `GET` | `/collectors` | Session JWT | List collectors with live status and counters |
| `POST` | `/collectors` | Session JWT | Create a collector; returns secrets once |
| `PATCH` | `/collectors/:id` | Session JWT | Update `enabled`, `name`, `port`, `public_host`, `input_format` |
| `POST` | `/collectors/:id/rotate` | Session JWT | Issue new credentials, revoke the old ones |
| `POST` | `/collectors/:id/test` | Session JWT | Loopback self-test (UDP only) |
| `DELETE` | `/collectors/:id` | Session JWT | Stop the listener and delete the collector |

`transfer_type` and `auth_method` are immutable after creation — delete and recreate to change them.

### OAuth 2.0

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/oauth/token` | None | `client_credentials` / `refresh_token` grants |
| `POST` | `/oauth/revoke` | None | Revoke a refresh token (RFC 7009) |

OAuth clients are created as collectors with `auth_method: "oauth_client_credentials"`.

### Logs

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/logs` | API Token or OAuth Bearer | Push a batch (HTTP collectors) |
| `GET` | `/logs` | Session JWT | View and search logs |
| `GET` | `/logs/apps` | Session JWT | List distinct app names |
| `GET` | `/healthz` | None | Health check + listener count |

---

## Pushing Logs

### API token

```bash
# json_array collector
curl -X POST http://localhost:3000/logs \
  -H "X-API-Token: <token>" \
  -H "Content-Type: application/json" \
  --data-binary '[
    {"app":"my-service","level":"info","message":"Started"},
    {"app":"my-service","level":"error","message":"Crashed","code":500}
  ]'

# ndjson collector
curl -X POST http://localhost:3000/logs \
  -H "X-API-Token: <token>" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @events.ndjson
```

### OAuth 2.0 (Client Credentials)

```bash
# Step 1: access token (1h) + refresh token (30d)
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<id>&client_secret=<secret>"

# Step 2: push a batch
curl -X POST http://localhost:3000/logs \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  --data-binary '[{"app":"my-service","level":"info","message":"Deployed"}]'

# Step 3: refresh when it expires
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=<refresh_token>"
```

### Node.js

```js
const events = [{ app: 'my-service', level: 'warn', message: 'Low disk' }];

await fetch('http://localhost:3000/logs', {
  method: 'POST',
  headers: { 'X-API-Token': '<token>', 'Content-Type': 'application/json' },
  body: JSON.stringify(events)          // json_array collector
});
```

### Python

```python
import json, requests

events = [{'app': 'my-service', 'level': 'info', 'message': 'OK'}]

requests.post('http://localhost:3000/logs',
  headers={'X-API-Token': '<token>', 'Content-Type': 'application/x-ndjson'},
  data='\n'.join(json.dumps(e) for e in events)   # ndjson collector
)
```

---

## Log Object Fields

| Field | Aliases | Description |
|---|---|---|
| `app` | `app_name`, `source` | Application name |
| `level` | `severity` | Log level (`error`, `warn`, `info`, `debug`, `trace`) |
| `message` | `msg` | Log message |
| *any other fields* | — | Stored as searchable metadata |

---

## Searching Logs

`GET /logs` accepts:

| Parameter | Description |
|---|---|
| `search` | Full-text search across app, level, message, and all metadata |
| `app` | Filter by exact app name |
| `level` | One level (`error`) or several (`error,warn`) — the dashboard's level pills are multi-select |
| `collector` | Filter by collector id |
| `from` | Start timestamp (date string or ms epoch) |
| `to` | End timestamp |
| `page` | Page number (default: 1) |
| `limit` | Results per page (default: 50, max: 200) |

Each row includes `collector_id`, `collector_name`, `transfer_type`, parsed
`metadata`, and the original `raw` event (used by the detail pane).

### `GET /logs/stats`

Aggregates powering the dashboard's level pills and volume histogram. Accepts
**exactly the same filters** as `GET /logs`, plus `buckets` (12–120, default 60).

```json
{
  "levels": { "error": 7, "warn": 19, "info": 212, "debug": 31, "trace": 0 },
  "total": 269,
  "range": { "from": 1760000000000, "to": 1760003600000, "bucket_ms": 60000 },
  "buckets": [ { "from": 1760000000000, "to": 1760000060000, "total": 3, "levels": { "error": 1, "info": 2 } } ]
}
```

> The `levels` breakdown deliberately **ignores** the `level` filter so the pills
> keep showing how many events each level has, including ones currently filtered
> out. Everything else (search, app, collector, time range) is applied.

---

## Database Maintenance

Schema lives in `src/db/schema/` as dialect-neutral JSON and is applied on every boot. Migrations run in order and are tracked in `_schema_version`.

To wipe everything and recreate the current schema (**destructive** — all users, logs, and collectors are lost):

```bash
npm run db:reset -- --yes
```

---

## Security Notes

- Passwords and OAuth client secrets are hashed with **bcrypt** (cost factor 12)
- Refresh tokens are stored as **SHA-256 hashes** only — plain text is never persisted
- Refresh token **rotation** is enforced — every use issues a new token and revokes the old one
- Reuse of a revoked refresh token **revokes all tokens** for that collector (stolen-token detection)
- Session tokens cannot be used for log ingestion — only API tokens and OAuth Bearer tokens are accepted on `POST /logs`
- Disabling a collector immediately blocks HTTP ingestion (`403`) and closes any UDP socket
- **UDP collectors are unauthenticated and unencrypted by design** — restrict them to trusted networks
