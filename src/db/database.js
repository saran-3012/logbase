'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'logs.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    token        TEXT    UNIQUE NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    last_used_at INTEGER,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id  INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL,
    app_name  TEXT    NOT NULL DEFAULT 'unknown',
    level     TEXT    NOT NULL DEFAULT 'info',
    message   TEXT    NOT NULL DEFAULT '',
    metadata  TEXT    NOT NULL DEFAULT '{}',
    raw       TEXT    NOT NULL DEFAULT '{}',
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_logs_user_ts  ON logs(user_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_level    ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_app_name ON logs(app_name);

  -- FTS5 virtual table: indexes app_name, level, message, and metadata JSON string
  CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
    app_name,
    level,
    message,
    metadata,
    content=logs,
    content_rowid=id
  );

  -- Keep FTS5 in sync with the logs table
  CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
    INSERT INTO logs_fts(rowid, app_name, level, message, metadata)
    VALUES (new.id, new.app_name, new.level, new.message, new.metadata);
  END;

  CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
    INSERT INTO logs_fts(logs_fts, rowid, app_name, level, message, metadata)
    VALUES ('delete', old.id, old.app_name, old.level, old.message, old.metadata);
  END;

  CREATE TRIGGER IF NOT EXISTS logs_au AFTER UPDATE ON logs BEGIN
    INSERT INTO logs_fts(logs_fts, rowid, app_name, level, message, metadata)
    VALUES ('delete', old.id, old.app_name, old.level, old.message, old.metadata);
    INSERT INTO logs_fts(rowid, app_name, level, message, metadata)
    VALUES (new.id, new.app_name, new.level, new.message, new.metadata);
  END;

  CREATE TABLE IF NOT EXISTS oauth_clients (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT    NOT NULL,
    client_id          TEXT    UNIQUE NOT NULL,
    client_secret_hash TEXT    NOT NULL,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, name)
  );

  -- SHA-256 of the actual refresh token is stored — never the token itself.
  -- reuse_count: if a rotated (already used) token is presented again it
  -- means the token family was likely stolen; we revoke all tokens for that client.
  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_db_id INTEGER NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT    UNIQUE NOT NULL,
    issued_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at   INTEGER NOT NULL,
    revoked      INTEGER NOT NULL DEFAULT 0,
    reuse_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_rt_client ON oauth_refresh_tokens(client_db_id);
`);

/* ── Migrations ─────────────────────────────────────────────────────────────────
 * Each entry runs exactly once, in order, tracked by PRAGMA user_version.
 * ONLY append to this array — never edit or remove existing entries.
 * ─────────────────────────────────────────────────────────────────────────────*/
const migrations = [
  // v1: baseline schema already created above via CREATE TABLE IF NOT EXISTS
];

const currentVersion = db.pragma('user_version', { simple: true });
for (let i = currentVersion; i < migrations.length; i++) {
  db.transaction(() => {
    db.exec(migrations[i]);
    db.pragma(`user_version = ${i + 1}`);
  })();
  console.log(`[db] Applied migration ${i + 1}`);
}

module.exports = db;
