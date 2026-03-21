'use strict';

/**
 * Abstract database adapter interface.
 *
 * To add a new backend (PostgreSQL, MySQL, …):
 *   1. Create src/db/adapters/<name>.js that extends BaseAdapter.
 *   2. Implement all methods below.
 *   3. Set DB_ADAPTER=<name> in environment variables.
 *
 * Schema is defined as plain JSON in src/db/schema/:
 *   tables.json     — table and column definitions (dialect-neutral)
 *   indexes.json    — index definitions
 *   migrations.json — ordered list of schema change operations
 *
 * Each adapter's compileSchema() / compileMigration() translates those
 * neutral definitions into its own SQL dialect.
 *
 * All methods are async and return plain JS objects / arrays.
 */
class BaseAdapter {
  // ── Query methods ────────────────────────────────────────────────────────────

  /**
   * Execute a SELECT and return the first matching row, or null.
   * @param {string} sql
   * @param {Array}  [params=[]]
   * @returns {Promise<object|null>}
   */
  async get(sql, params = []) {
    throw new Error(`${this.constructor.name} must implement get()`);
  }

  /**
   * Execute a SELECT and return all matching rows.
   * @param {string} sql
   * @param {Array}  [params=[]]
   * @returns {Promise<object[]>}
   */
  async all(sql, params = []) {
    throw new Error(`${this.constructor.name} must implement all()`);
  }

  /**
   * Execute a write statement (INSERT / UPDATE / DELETE).
   * @param {string} sql
   * @param {Array}  [params=[]]
   * @returns {Promise<{ changes: number, lastInsertRowid: number|null }>}
   */
  async run(sql, params = []) {
    throw new Error(`${this.constructor.name} must implement run()`);
  }

  /**
   * Execute one or more raw DDL strings with no parameters.
   * Accepts a single string or an array of strings (one statement each).
   * @param {string|string[]} statements
   * @returns {Promise<void>}
   */
  async exec(statements) {
    throw new Error(`${this.constructor.name} must implement exec()`);
  }

  /**
   * Run an async function atomically inside a transaction.
   * The function receives a context { get, all, run } scoped to the transaction.
   * @param {function} fn
   * @returns {Promise<any>}
   */
  async transaction(fn) {
    throw new Error(`${this.constructor.name} must implement transaction()`);
  }

  /**
   * Compile and execute a query object (SelectQuery, InsertQuery, UpdateQuery,
   * DeleteQuery) using the adapter's own compiler, then dispatch the result
   * through get / all / run as appropriate.
   *
   * - SelectQuery with .single() → get() → first row or null
   * - SelectQuery without .single() → all() → row array
   * - InsertQuery / UpdateQuery / DeleteQuery → run() → { changes, lastInsertRowid }
   *
   * @param {object} queryObject  — a query builder instance
   * @returns {Promise<object|object[]|{changes,lastInsertRowid}>}
   */
  async query(queryObject) {
    throw new Error(`${this.constructor.name} must implement query()`);
  }

  // ── Schema compilation ───────────────────────────────────────────────────────

  /**
   * Compile neutral table + index definitions (from JSON) into an array of
   * DDL strings ready to be passed to exec().
   *
   * Supported column properties:
   *   type          — 'integer' | 'text' | 'real' | 'blob'
   *   primaryKey    — boolean
   *   notNull       — boolean
   *   unique        — boolean (column-level)
   *   default       — scalar value, or the string "now" (adapter maps to its timestamp fn)
   *   references    — { table, column, onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' }
   *
   * Supported table properties:
   *   uniqueConstraints  — array of column-name arrays for multi-column UNIQUE
   *   fullTextSearch     — { columns: string[] }  (adapter chooses FTS mechanism)
   *
   * @param {object[]} tables   — parsed tables.json
   * @param {object[]} indexes  — parsed indexes.json
   * @returns {string[]}
   */
  compileSchema(tables, indexes) {
    throw new Error(`${this.constructor.name} must implement compileSchema()`);
  }

  /**
   * Compile a single migration operation object into an array of DDL strings.
   *
   * Supported operation types:
   *   { type: 'addColumn',    table, column: { name, type, notNull, default, references } }
   *   { type: 'addIndex',     name, table, columns }
   *   { type: 'dropIndex',    name }
   *   { type: 'renameColumn', table, from, to }        — not supported by all backends
   *
   * Baseline-only entry (version 1 with no type) returns an empty array.
   *
   * @param {object} migration  — one entry from migrations.json
   * @returns {string[]}
   */
  compileMigration(migration) {
    throw new Error(`${this.constructor.name} must implement compileMigration()`);
  }
}

module.exports = BaseAdapter;

