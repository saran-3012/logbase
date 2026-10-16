# Logbase — DevOps scripts

Every operational task lives here as a script, so the same command works on a
developer machine and in CI. No task-runner, no Makefile — just bash and Node.

```
scripts/
├── lib/common.sh   shared helpers (sourced, never executed)
├── setup.sh        one-time environment setup
├── dev.sh          run the app locally
├── check.sh        static checks — no server, no network
├── test.sh         end-to-end tests against a throwaway server
├── ci.sh           check.sh + test.sh (what GitHub Actions runs)
├── db.sh           database status / backup / reset / console
├── docker.sh       Docker lifecycle (the deployment where UDP works)
├── deploy.sh       deployment preflight and release to Render
└── db-reset.js     low-level schema drop + recreate (called by db.sh reset)
```

---

## Quick start

```bash
git clone <repo> && cd logbase
npm run setup     # toolchain check, install, generate .env.local
npm run dev       # http://localhost:3000
```

`npm run setup` is optional — `npm run dev` runs it automatically when
`.env.local` is missing.

---

## npm aliases

Every script has an npm alias. Use whichever you prefer; they are identical.

| npm | Script | Purpose |
|---|---|---|
| `npm run setup` | `setup.sh` | Verify toolchain, install deps, create `.env.local` |
| `npm run dev` | `dev.sh --watch` | Run locally, restart on change |
| `npm run local` | `dev.sh` | Run locally, no watcher |
| `npm run local:fresh` | `dev.sh --fresh` | Wipe the local DB, then run |
| `npm run check` | `check.sh` | Static checks (fast, offline) |
| `npm test` | `test.sh` | End-to-end tests |
| `npm run ci` | `ci.sh` | Both stages, exactly as CI runs them |
| `npm run db:status` | `db.sh status` | Schema version and row counts |
| `npm run db:backup` | `db.sh backup` | Snapshot the local database |
| `npm run db:reset` | `db.sh reset` | **Destructive** — drop and recreate |
| `npm run db:console` | `db.sh console` | Open `sqlite3` |
| `npm run docker:up` | `docker.sh up` | Build and start in Docker |
| `npm run docker:down` | `docker.sh down` | Stop and remove |
| `npm run docker:logs` | `docker.sh logs` | Follow container output |
| `npm run deploy:check` | `deploy.sh` | Preflight only, nothing pushed |
| `npm run deploy` | `deploy.sh --push` | Preflight, then push (Render deploys) |

Pass flags through npm with `--`:

```bash
npm run local -- --port 4000
npm test -- --keep
```

---

## The scripts

### `setup.sh` — one-time setup

```bash
./scripts/setup.sh           # safe to re-run
./scripts/setup.sh --force   # regenerate .env.local (new JWT_SECRET)
```

Checks Node ≥ 20, installs dependencies, creates `data/`, generates a
git-ignored `.env.local` with a random `JWT_SECRET` pointing at
`file:./data/local.db`, and verifies the schema compiles.

> `--force` issues a new `JWT_SECRET`, which invalidates every existing session
> and OAuth access token.

### `dev.sh` — run locally

```bash
./scripts/dev.sh                 # local SQLite (safe default)
./scripts/dev.sh --watch         # restart on changes in src/ and public/
./scripts/dev.sh --fresh         # delete the local DB first
./scripts/dev.sh --port 4000     # different HTTP port
./scripts/dev.sh --turso         # ⚠ use .env — hits the CLOUD database
```

**Why the app never hits production by accident.** `src/server.js` calls
`dotenv.config()`, which reads `.env` — and `.env` points at cloud Turso. dotenv
never overwrites a variable that is already set, so `dev.sh` exports
`.env.local` first and those values win. Precedence, highest first:

```
--port flag  >  shell environment  >  .env.local  >  .env
```

`PORT=4000 npm run dev` therefore works, and so does `--turso` when you really
do want the cloud database.

`--fresh` and `--turso` cannot be combined; wiping the cloud database has to be
deliberate (`npm run db:reset -- --turso`).

### `check.sh` — static checks

```bash
./scripts/check.sh
./scripts/check.sh --quiet   # failures only
```

Offline and fast (~2s). Checks:

1. **Syntax** — every `.js` in `src/`, `scripts/`, `tools/`, `.github/`, `public/`
2. **Shell syntax** — `bash -n` on every script, plus `shellcheck` when installed
3. **JSON validity** — `package.json`, lockfile, the three schema files
4. **Schema compiles** — DDL and every migration
5. **Modules load** — each route, middleware and ingest module `require`s cleanly
6. **Environment drift** — every `process.env.X` read by `src/` must appear in `.env.example`
7. **Secrets** — tracked `.env`, GitHub PATs, JWTs, live Turso URLs, credentials in the git remote
8. **Hygiene** — no tracked `.db`/`.log`, all scripts executable

Check 6 is the one that earns its keep: a new deployment knob cannot ship
undocumented, which on Render means it cannot silently fall back to a default.

### `test.sh` — end-to-end tests

```bash
./scripts/test.sh
./scripts/test.sh --keep                          # keep the test DB
./scripts/test.sh --port 3999                     # different port
./scripts/test.sh --against http://localhost:3000 # test a running server
```

Boots the real server against `data/test-$$.db` and runs
`.github/workflows/smoke.js` — HTTP ingest in both formats, OAuth, real UDP
datagrams, listener lifecycle, port release, FTS search, static assets.

The server is started with `env -i`, so **nothing** is inherited from `.env` or
`.env.local` and a developer's local configuration cannot change the result. The
database is deleted on exit, including on failure or Ctrl-C.

> The suite asserts exact row counts, so it always needs an empty database.
> `--against` writes real data into whatever server you point it at.

### `ci.sh` — the pipeline

```bash
./scripts/ci.sh
```

`check.sh` then `test.sh`. GitHub Actions runs this exact script, so a local
pass and a CI pass mean the same thing.

### `db.sh` — database operations

```bash
./scripts/db.sh status            # schema version, row counts, file size
./scripts/db.sh backup            # VACUUM INTO data/backups/
./scripts/db.sh console           # sqlite3 shell
./scripts/db.sh reset             # DESTRUCTIVE — prompts first
./scripts/db.sh status --turso    # target the cloud database
```

Defaults to the **local** database. `--turso` is required to touch the cloud
one. `reset` always prompts unless `--yes` is passed, and prints an extra
warning when the target is remote.

`backup` uses `VACUUM INTO` so the snapshot is consistent even while the server
is running — a plain `cp` can capture a torn WAL.

### `docker.sh` — containers

```bash
./scripts/docker.sh up       # build + start, wait for health
./scripts/docker.sh logs
./scripts/docker.sh status
./scripts/docker.sh down
```

Generates `.env.docker` on first run. **This is the deployment where inbound UDP
works end to end** — compose publishes `10000-10010/udp` to the host, so a
datagram sent to `127.0.0.1:10000` reaches a collector.

### `deploy.sh` — release

```bash
./scripts/deploy.sh               # preflight only — nothing is pushed
./scripts/deploy.sh --push        # preflight, confirm, push
./scripts/deploy.sh --push --yes  # non-interactive
```

Render auto-deploys on push, so **the push is the deploy**. Preflight gates:

1. `check.sh` passes
2. `test.sh` passes (skip with `--skip-tests`)
3. `render.yaml` and `Dockerfile` present; `start` invokes `node` directly
4. **No `devDependency` is required from `src/`** — Render installs with
   `--omit=dev`, so this would crash only in production
5. Git state — dirty tree, ahead/behind upstream
6. **Destructive migrations are listed explicitly** before you confirm

Nothing is pushed unless every gate passes.

---

## CI

`.github/workflows/ci.yml` runs `./scripts/ci.sh` on push and PR to `master`.
It is a thin wrapper: all logic lives in the scripts.

Render deploys from the branch directly and is **not** gated on CI. To gate it,
turn off Auto-Deploy and call a Deploy Hook after the workflow succeeds.

---

## Conventions

- **bash 3.2** — the version macOS ships. No associative arrays, no `mapfile`,
  no `${var^^}`. Linux CI and a developer Mac behave identically.
- **`set -euo pipefail`** in every executable script; `lib/common.sh` is sourced
  and deliberately does not set it.
- **Exit 0 = success.** Scripts are composable and safe in CI.
- **Colour only on a TTY** — piped output and CI logs stay plain.
- **Prompts auto-decline when stdin is not a TTY**, so CI can never hang.
- **Destructive actions require an explicit flag** (`--turso`, `--yes`, `--force`).
- **`--help` on everything**, generated from the header comment.

### Adding a script

1. Start from this skeleton:

   ```bash
   #!/usr/bin/env bash
   #
   # Logbase — what it does.
   #
   #   ./scripts/thing.sh --flag   what the flag does
   #
   set -euo pipefail
   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"
   cd "$ROOT"
   ```

2. `chmod +x scripts/thing.sh` — `check.sh` fails if you forget.
3. Add an npm alias in `package.json`.
4. Document it here.

### Helpers in `lib/common.sh`

| Helper | Purpose |
|---|---|
| `info` `ok` `warn` `err` `die` | Consistent output; `die` exits 1 |
| `section` `header` | Headings |
| `pass_check` `fail_check` `exit_with_failures` | Accumulate failures, exit once |
| `require_node` `ensure_deps` | Toolchain and dependency guards |
| `need_cmd` `has_cmd` | Command presence |
| `load_env_file` | Load a `.env` file with dotenv precedence |
| `gen_secret` | 32-byte hex secret |
| `is_cloud_db` `db_label` | Distinguish local from cloud databases |
| `tcp_port_in_use` `udp_port_in_use` `port_owner` `require_free_tcp_port` | Port checks |
| `wait_for_http` | Poll an endpoint until healthy |
| `confirm` | Prompt; auto-declines when not a TTY |

---

## Environment files

| File | Tracked | Used by | Purpose |
|---|---|---|---|
| `.env.example` | ✅ | — | Documents every variable |
| `.env` | ❌ | `dev.sh --turso`, `db.sh --turso` | Cloud Turso credentials |
| `.env.local` | ❌ | `dev.sh`, `db.sh` | Local overrides (generated) |
| `.env.docker` | ❌ | `docker.sh` | Container config (generated) |

`check.sh` fails if `.env` is ever tracked.

---

## Troubleshooting

**`Port 3000 is already in use (by node)`**
`lsof -ti:3000 | xargs kill`, or `npm run local -- --port 4000`.

**`UDP port 10001 is in use`**
A previous server did not shut down cleanly:
`lsof -ti udp:10001 | xargs kill`.

**Tests fail with wrong counts**
The suite needs an empty database. It creates its own; if you used `--against`,
the target already had data.

**`Undocumented in .env.example: FOO`**
You added `process.env.FOO` to `src/` — add it to `.env.example`, and to
`render.yaml` if production needs a non-default value.

**`src/ requires a devDependency`**
Render installs with `--omit=dev`. Move the package into `dependencies`.
