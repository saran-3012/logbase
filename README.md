# Logbase

A self-hosted log ingestion and monitoring server with a web UI, full-text search, and multiple integration methods.

## Features

- **User accounts** — register and log in via a clean web UI
- **Log ingestion** — push logs from any app via API token or OAuth 2.0
- **Batch support** — send a single JSON object or an array of up to 1000 entries in one request
- **Full-text search** — powered by SQLite FTS5; searches across `app`, `level`, `message`, and all metadata fields simultaneously
- **Log viewer** — filterable table with expandable rows (full JSON), relative timestamps, level badges, and auto-refresh
- **24-hour retention** — logs older than 24 hours are automatically purged (configurable)
- **OAuth 2.0** — Client Credentials grant with refresh token rotation and stolen-token detection
- **API tokens** — simple static tokens for lightweight integrations

---

## Getting Started

### Prerequisites

- Node.js **v18+** (v22 recommended)

### Install

```bash
git clone <repo-url> logbase
cd logbase
npm install
```

### Configure

Copy the example environment file and set a strong secret:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | *(required)* | Secret used to sign session and OAuth tokens |
| `JWT_EXPIRES_IN` | `7d` | Session token lifetime |
| `LOG_RETENTION_HOURS` | `24` | Hours before logs are purged |

> **Important:** Change `JWT_SECRET` to a long random string before running in production.

### Run

```bash
npm start          # production
npm run dev        # development (auto-reload via nodemon)
```

Open **http://localhost:3000** in your browser.

---

## Project Structure

```
logbase/
├── src/
│   ├── db/
│   │   └── database.js          # SQLite schema, FTS5 setup, migrations
│   ├── middleware/
│   │   ├── sessionAuth.js       # JWT session token middleware
│   │   ├── apiTokenAuth.js      # X-API-Token middleware
│   │   └── logIngestAuth.js     # Combined auth (API token OR OAuth Bearer)
│   └── routes/
│       ├── auth.js              # Register, login, API token CRUD
│       ├── logs.js              # Log ingestion and retrieval
│       └── oauth.js             # OAuth 2.0 client credentials + token rotation
├── public/
│   ├── index.html               # Login / register page
│   ├── dashboard.html           # Main dashboard
│   ├── favicon.svg
│   └── js/
│       ├── auth.js
│       └── dashboard.js
├── data/                        # SQLite database (git-ignored, created at runtime)
├── .env                         # Secrets (git-ignored)
└── package.json
```

---

## API Reference

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | None | Create a new account |
| `POST` | `/auth/login` | None | Login — returns a JWT session token |
| `POST` | `/auth/tokens` | Session JWT | Create a named API token |
| `GET` | `/auth/tokens` | Session JWT | List your API tokens |
| `DELETE` | `/auth/tokens/:id` | Session JWT | Revoke an API token |

### OAuth 2.0

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/oauth/clients` | Session JWT | Create an OAuth client |
| `GET` | `/oauth/clients` | Session JWT | List OAuth clients |
| `DELETE` | `/oauth/clients/:id` | Session JWT | Revoke an OAuth client |
| `POST` | `/oauth/token` | None | Exchange credentials for tokens |
| `POST` | `/oauth/revoke` | None | Revoke a refresh token (RFC 7009) |

### Logs

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/logs` | API Token or OAuth Bearer | Push one or many log entries |
| `GET` | `/logs` | Session JWT | View and search logs |
| `GET` | `/logs/apps` | Session JWT | List distinct app names |

---

## Pushing Logs

### Via API Token

```bash
# Single log
curl -X POST http://localhost:3000/logs \
  -H "X-API-Token: <your-api-token>" \
  -H "Content-Type: application/json" \
  -d '{"app":"my-service","level":"error","message":"Something failed","code":500}'

# Batch (array)
curl -X POST http://localhost:3000/logs \
  -H "X-API-Token: <your-api-token>" \
  -H "Content-Type: application/json" \
  -d '[
    {"app":"my-service","level":"info","message":"Started"},
    {"app":"my-service","level":"error","message":"Crashed","code":500}
  ]'
```

### Via OAuth 2.0 (Client Credentials)

```bash
# Step 1: Get an access token
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<id>&client_secret=<secret>"

# Response includes access_token (1h) and refresh_token (30d)

# Step 2: Push logs
curl -X POST http://localhost:3000/logs \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"app":"my-service","level":"info","message":"Deployed"}'

# Step 3: Refresh when the access token expires
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=<refresh_token>"
```

### Node.js

```js
await fetch('http://localhost:3000/logs', {
  method: 'POST',
  headers: { 'X-API-Token': '<token>', 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: 'my-service', level: 'warn', message: 'Low disk' })
});
```

### Python

```python
import requests
requests.post('http://localhost:3000/logs',
  headers={'X-API-Token': '<token>'},
  json={'app': 'my-service', 'level': 'info', 'message': 'OK'}
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

The `GET /logs` endpoint accepts these query parameters:

| Parameter | Description |
|---|---|
| `search` | Full-text search across app, level, message, and all metadata |
| `app` | Filter by exact app name |
| `level` | Filter by log level |
| `from` | Start timestamp (date string or ms epoch) |
| `to` | End timestamp |
| `page` | Page number (default: 1) |
| `limit` | Results per page (default: 50, max: 200) |

---

## Security Notes

- Passwords are hashed with **bcrypt** (cost factor 12)
- Refresh tokens are stored as **SHA-256 hashes** only — plain text is never persisted
- Refresh token **rotation** is enforced — every use issues a new token and revokes the old one
- Reuse of a revoked refresh token triggers **automatic revocation** of all tokens for that client (stolen-token detection)
- Session tokens cannot be used for log ingestion — only API tokens and OAuth Bearer tokens are accepted on `POST /logs`
