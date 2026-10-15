# UDP → HTTP forwarder

A standalone relay for deployments where the platform does not route inbound UDP
(Render web services, most PaaS offerings).

Run it **next to your log source**. It binds a local UDP port, batches the
datagrams it receives, and forwards them to a Logbase **HTTP collector** over
HTTPS — so your applications keep speaking UDP while Logbase stays reachable
over its single HTTP port.

```
your app ──UDP──▶ udp-forwarder ──HTTPS──▶ Logbase /logs (http collector)
```

## Setup

1. In the Logbase dashboard create an **HTTP** collector with
   `auth_method = api_token` and `input_format = ndjson`.
2. Copy the API token shown once at creation.
3. Run the forwarder:

```bash
LISTEN_PORT=10000 \
LOGBASE_URL=https://your-app.onrender.com/logs \
LOGBASE_TOKEN=<api token> \
INPUT_FORMAT=ndjson \
node tools/udp-forwarder/index.js
```

4. Point your application at `udp://localhost:10000`:

```bash
echo '{"app":"my-service","level":"info","message":"hello"}' | nc -u -w1 localhost 10000
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LISTEN_PORT` | `10000` | Local UDP port to bind |
| `LISTEN_HOST` | `0.0.0.0` | Local bind address |
| `LOGBASE_URL` | `http://localhost:3000/logs` | Target ingest URL |
| `LOGBASE_TOKEN` | *(required)* | API token of an HTTP collector |
| `INPUT_FORMAT` | `ndjson` | Must match the collector: `ndjson` or `json_array` |
| `FLUSH_INTERVAL_MS` | `1000` | How often buffered events are sent |
| `MAX_BATCH` | `200` | Events per HTTP request |

## Notes

- Requires Node 18+ (uses the built-in `fetch`). No npm dependencies.
- Non-JSON datagrams are forwarded as `{ "message": "<raw line>" }` so nothing
  is silently dropped.
- Buffered events are flushed on `SIGINT` / `SIGTERM`.
