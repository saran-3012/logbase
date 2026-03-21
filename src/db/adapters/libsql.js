'use strict';

const { createClient } = require('@libsql/client');
const BaseAdapter = require('./base');

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

  // ── Schema compilation ───────────────────────────────────────────────────────

  /**
   * Translate neutral table + index definitions into LibSQL/SQLite DDL strings.
   * Maps:
   *   type       → SQLite affinity (integer / text / real / blob)
   *   default    → literal value; "now" → unixepoch()
   *   references → REFERENCES table(col) ON DELETE …
   *   fullTextSearch → FTS5 virtual table + three sync triggers (ai/ad/au)
   */
  compileSchema(tables, indexes) {
    const stmts = [];

    for (const table of tables) {
      const colDefs = table.columns.map(col => {
        const parts = [col.name, col.type.toUpperCase()];
        if (col.primaryKey) parts.push('PRIMARY KEY AUTOINCREMENT');
        if (col.notNull)    parts.push('NOT NULL');
        if (col.unique)     parts.push('UNIQUE');
        if (col.default !== undefined) {
          const def = col.default === 'now' ? 'unixepoch()' : JSON.stringify(col.default);
          parts.push(`DEFAULT (${def})`);
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
      stmts.push(
        `CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table}(${idx.columns.join(', ')})`
      );
    }

    return stmts;
  }

  /**
   * Compile a structured migration operation into LibSQL/SQLite DDL strings.
   * Supported types: addColumn, addIndex, dropIndex, renameColumn.
   * Baseline-only entries (no type field) return an empty array.
   */
  compileMigration(migration) {
    if (!migration.type) return []; // baseline marker, nothing to run

    switch (migration.type) {
      case 'addColumn': {
        const col = migration.column;
        const parts = [col.type.toUpperCase()];
        if (col.notNull && col.default === undefined)
          throw new Error(`addColumn "${col.name}": NOT NULL column requires a default for existing rows`);
        if (col.notNull)    parts.push('NOT NULL');
        if (col.default !== undefined) {
          const def = col.default === 'now' ? 'unixepoch()' : JSON.stringify(col.default);
          parts.push(`DEFAULT (${def})`);
        }
        if (col.references) {
          const ref = col.references;
          parts.push(`REFERENCES ${ref.table}(${ref.column}) ON DELETE ${ref.onDelete}`);
        }
        return [`ALTER TABLE ${migration.table} ADD COLUMN ${col.name} ${parts.join(' ')}`];
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
