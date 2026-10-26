'use strict';

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
const BaseAdapter = require('./base');

/**
 * SQLite opens an existing file or creates a new one, but it will not create a
 * missing parent directory — it fails with SQLITE_CANTOPEN (14). A fresh
 * checkout, a CI runner and the Docker image all start without `data/`, so
 * `file:./data/logs.db` would fail there while working fine on a developer
 * machine that happens to have the directory already.
 *
 * Creating the directory here (rather than in each caller) means every entry
 * point — server, scripts, tests, Docker — behaves the same way.
 *
 * Remote URLs (libsql://, https://, wss://) and in-memory databases have no
 * filesystem path and are left untouched.
 */
function ensureLocalDbDirectory(url) {
  if (!url.startsWith('file:')) return;

  let filePath = url.slice('file:'.length);
  if (filePath.startsWith('//')) filePath = filePath.slice(2); // file:///abs/path
  // file::memory: and file::memory:?cache=shared have no directory.
  if (filePath === '' || filePath.startsWith(':memory:')) return;

  const dir = path.dirname(path.resolve(filePath));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // A read-only or permission-denied mount is the operator's call to fix;
    // surface SQLite's own error rather than masking it with an mkdir failure.
    if (err.code !== 'EEXIST') {
      throw new Error(`Cannot create database directory "${dir}": ${err.message}`);
    }
  }
}

/**
 * LibSQL / Turso adapter.
 *
 * @param {object} config
 * @param {string} config.url       — libsql://… for Turso cloud, or file:./data/logs.db for local
 * @param {string} [config.authToken] — required for Turso cloud; omit for local file
 */
class LibSQLAdapter extends BaseAdapter {
  constructor({ url, authToken } = {}) {
    super();
    if (!url) {
      throw new Error('LibSQLAdapter requires a url (e.g. set TURSO_DATABASE_URL in your environment)');
    }
    ensureLocalDbDirectory(url);
    this.client = createClient({ url, authToken });
  }

  /**
   * Reads the env vars this adapter needs.
   * database.js calls this generically — no adapter-specific names leak there.
   * When adding a new adapter, implement the same static method:
   *   static configFromEnv() { return { connectionString: process.env.DATABASE_URL }; }
   */
  static configFromEnv() {
    return {
      url:       process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    };
  }

  // ── Query methods ────────────────────────────────────────────────────────────

  async get(sql, params = []) {
    const result = await this.client.execute({ sql, args: params });
    return result.rows[0] ?? null;
  }

  async all(sql, params = []) {
    const result = await this.client.execute({ sql, args: params });
    return result.rows;
  }

  async run(sql, params = []) {
    const result = await this.client.execute({ sql, args: params });
    return {
      changes:         result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
    };
  }

  async exec(statements) {
    const list = (Array.isArray(statements) ? statements : [statements])
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const sql of list) {
      await this.client.execute({ sql, args: [] });
    }
  }

  async transaction(fn) {
    const tx = await this.client.transaction('write');
    const ctx = {
      get: async (sql, params = []) => {
        const r = await tx.execute({ sql, args: params });
        return r.rows[0] ?? null;
      },
      all: async (sql, params = []) => {
        const r = await tx.execute({ sql, args: params });
        return r.rows;
      },
      run: async (sql, params = []) => {
        const r = await tx.execute({ sql, args: params });
        return {
          changes:         r.rowsAffected,
          lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null,
        };
      },
      query: async (queryObject) => {
        const LibSQLCompiler = require('../compilers/libsql');
        const SelectQuery    = require('../query/select');
        const { sql, params } = new LibSQLCompiler().compile(queryObject);
        if (queryObject instanceof SelectQuery) {
          const r = await tx.execute({ sql, args: params });
          return queryObject._single ? (r.rows[0] ?? null) : r.rows;
        }
        const r = await tx.execute({ sql, args: params });
        return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null };
      },
    };
    try {
      const result = await fn(ctx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  // ── High-level query object API ─────────────────────────────────────────────

  async query(queryObject) {
    const LibSQLCompiler = require('../compilers/libsql');
    const SelectQuery    = require('../query/select');

    const { sql, params } = new LibSQLCompiler().compile(queryObject);

    if (queryObject instanceof SelectQuery) {
      return queryObject._single ? this.get(sql, params) : this.all(sql, params);
    }
    return this.run(sql, params);
  }

  // ── Schema compilation ───────────────────────────────────────────────────────

  /**
   * Translate neutral table + index definitions into LibSQL/SQLite DDL strings.
   * Maps:
   *   type       → SQLite affinity (integer / text / real / blob)
   *   default    → literal value; "now" → unixepoch()
   *   references → REFERENCES table(col) ON DELETE …
   *   fullTextSearch → FTS5 virtual table + three sync triggers (ai/ad/au)
   */
  /**
   * Render a column default as a SQLite literal.
   *
   * String defaults MUST use single quotes: SQLite resolves a double-quoted
   * token as an identifier first and only falls back to a string literal when
   * no column/function of that name exists. A default like "json_array" would
   * otherwise collide with the built-in json_array() function and be rejected
   * with "default value is not constant".
   */
  _defaultLiteral(value) {
    if (value === 'now') return 'unixepoch()';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    return String(value);
  }

  compileSchema(tables, indexes) {
    const stmts = [];

    for (const table of tables) {
      const colDefs = table.columns.map(col => {
        const parts = [col.name, col.type.toUpperCase()];
        if (col.primaryKey) parts.push('PRIMARY KEY AUTOINCREMENT');
        if (col.notNull)    parts.push('NOT NULL');
        if (col.unique)     parts.push('UNIQUE');
        if (col.default !== undefined) {
          parts.push(`DEFAULT (${this._defaultLiteral(col.default)})`);
        }
        if (col.references) {
          const ref = col.references;
          parts.push(`REFERENCES ${ref.table}(${ref.column}) ON DELETE ${ref.onDelete}`);
        }
        return '  ' + parts.join(' ');
      });

      if (table.uniqueConstraints) {
        for (const cols of table.uniqueConstraints) {
          colDefs.push(`  UNIQUE(${cols.join(', ')})`);
        }
      }

      stmts.push(
        `CREATE TABLE IF NOT EXISTS ${table.name} (\n${colDefs.join(',\n')}\n)`
      );

      // FTS5 virtual table + sync triggers
      if (table.fullTextSearch) {
        const ftsCols = table.fullTextSearch.columns;
        const ftsTable = `${table.name}_fts`;

        stmts.push(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(\n` +
          ftsCols.map(c => `  ${c}`).join(',\n') + `,\n` +
          `  content=${table.name},\n  content_rowid=id\n)`
        );

        const colList = ftsCols.join(', ');
        const newVals = ftsCols.map(c => `new.${c}`).join(', ');
        const oldVals = ftsCols.map(c => `old.${c}`).join(', ');

        stmts.push(
          `CREATE TRIGGER IF NOT EXISTS ${table.name}_ai AFTER INSERT ON ${table.name} BEGIN\n` +
          `  INSERT INTO ${ftsTable}(rowid, ${colList}) VALUES (new.id, ${newVals});\nEND`
        );
        stmts.push(
          `CREATE TRIGGER IF NOT EXISTS ${table.name}_ad AFTER DELETE ON ${table.name} BEGIN\n` +
          `  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList}) VALUES ('delete', old.id, ${oldVals});\nEND`
        );
        stmts.push(
          `CREATE TRIGGER IF NOT EXISTS ${table.name}_au AFTER UPDATE ON ${table.name} BEGIN\n` +
          `  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colList}) VALUES ('delete', old.id, ${oldVals});\n` +
          `  INSERT INTO ${ftsTable}(rowid, ${colList}) VALUES (new.id, ${newVals});\nEND`
        );
      }
    }

    for (const idx of indexes) {
      // `unique: true`      → CREATE UNIQUE INDEX
      // `where: "<predicate>"` → SQLite partial index; combined with unique this is
      // how constraints like "only one UDP collector per user" are enforced in the DB.
      const uniq  = idx.unique ? 'UNIQUE ' : '';
      const where = idx.where  ? ` WHERE ${idx.where}` : '';
      stmts.push(
        `CREATE ${uniq}INDEX IF NOT EXISTS ${idx.name} ON ${idx.table}(${idx.columns.join(', ')})${where}`
      );
    }

    return stmts;
  }

  /**
   * Current table → column-name map, read from SQLite's own catalogue.
   * Used by migrations that must branch on the live schema shape.
   */
  async describeSchema() {
    const tables = await this.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    );
    const schema = new Map();
    for (const { name } of tables) {
      // PRAGMA cannot be parameterised; the name comes from sqlite_master, not user input.
      const cols = await this.all(`PRAGMA table_info("${String(name).replace(/"/g, '""')}")`);
      schema.set(String(name), new Set(cols.map(c => String(c.name))));
    }
    return schema;
  }

  /** Render a single `ALTER TABLE … ADD COLUMN` clause body. */
  _columnClause(col) {
    const parts = [col.type.toUpperCase()];
    if (col.notNull && col.default === undefined) {
      throw new Error(`addColumn "${col.name}": NOT NULL column requires a default for existing rows`);
    }
    if (col.notNull) parts.push('NOT NULL');
    if (col.default !== undefined) parts.push(`DEFAULT (${this._defaultLiteral(col.default)})`);
    if (col.references) {
      const ref = col.references;
      parts.push(`REFERENCES ${ref.table}(${ref.column}) ON DELETE ${ref.onDelete}`);
    }
    return parts.join(' ');
  }

  /**
   * Compile a structured migration operation into LibSQL/SQLite DDL strings.
   * Supported types: addColumn, guardedColumns, addIndex, dropIndex,
   * renameColumn, dropTable, raw.
   * Baseline-only entries (no type field) return an empty array.
   *
   * @param {object} migration
   * @param {Map<string, Set<string>>} [schema]  — from describeSchema(); required
   *                                               for introspection-based types
   */
  compileMigration(migration, schema) {
    if (!migration.type) return []; // baseline marker, nothing to run

    switch (migration.type) {
      case 'guardedColumns': {
        // Additive columns applied only where they are genuinely missing.
        //
        // Migrations run before compileSchema(), so on a fresh database the
        // target tables do not exist yet — and they will be created complete.
        // Skipping absent tables makes this migration a no-op there, while an
        // already-deployed database gets exactly the columns it lacks.
        if (!schema) throw new Error('guardedColumns migration requires a schema snapshot');
        if (!Array.isArray(migration.columns) || migration.columns.length === 0) {
          throw new Error('guardedColumns migration requires a non-empty "columns" array');
        }

        const stmts = [];
        const touched = new Set();

        for (const entry of migration.columns) {
          const existing = schema.get(entry.table);
          touched.add(entry.table);
          if (!existing) continue;                       // fresh DB — compileSchema() handles it
          if (existing.has(entry.column.name)) continue; // already applied
          stmts.push(
            `ALTER TABLE ${entry.table} ADD COLUMN ${entry.column.name} ${this._columnClause(entry.column)}`
          );
        }

        // Follow-up data statements are only safe once every table they touch exists.
        const allPresent = [...touched].every(t => schema.has(t));
        if (allPresent && Array.isArray(migration.then)) stmts.push(...migration.then);

        return stmts;
      }
      case 'raw': {
        // Escape hatch for dialect-specific / destructive operations that have no
        // neutral representation (dropping FTS triggers, rebuilding tables, …).
        if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
          throw new Error('raw migration requires a non-empty "statements" array');
        }
        return migration.statements;
      }
      case 'dropTable':
        return [`DROP TABLE IF EXISTS ${migration.table}`];
      case 'addColumn': {
        const col = migration.column;
        return [`ALTER TABLE ${migration.table} ADD COLUMN ${col.name} ${this._columnClause(col)}`];
      }
      case 'addIndex':
        return [`CREATE INDEX IF NOT EXISTS ${migration.name} ON ${migration.table}(${migration.columns.join(', ')})`];
      case 'dropIndex':
        return [`DROP INDEX IF EXISTS ${migration.name}`];
      case 'renameColumn':
        // Supported in SQLite 3.25+ / LibSQL
        return [`ALTER TABLE ${migration.table} RENAME COLUMN ${migration.from} TO ${migration.to}`];
      default:
        throw new Error(`Unknown migration type: "${migration.type}"`);
    }
  }
}

module.exports = LibSQLAdapter;
