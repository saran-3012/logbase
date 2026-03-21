'use strict';

/**
 * Abstract database adapter interface.
 *
 * To add a new backend (PostgreSQL, MySQL, …):
 *   1. Create src/db/adapters/<name>.js that extends BaseAdapter.
 *   2. Implement all five methods below.
 *   3. Set DB_ADAPTER=<name> in environment variables.
 *   4. Provide adapter-specific DDL in src/db/schema/<name>.js if the SQL
 *      dialect differs from LibSQL/SQLite (e.g. unixepoch(), FTS5, triggers).
 *
 * All methods are async and return plain JS objects / arrays.
 */
class BaseAdapter {
  /**
   * Execute a SELECT and return the first matching row, or null.
   * @param {string}  sql
   * @param {Array}   [params=[]]
   * @returns {Promise<object|null>}
   */
  async get(sql, params = []) {
    throw new Error(`${this.constructor.name} must implement get()`);
  }

  /**
   * Execute a SELECT and return all matching rows.
   * @param {string}  sql
   * @param {Array}   [params=[]]
   * @returns {Promise<object[]>}
   */
  async all(sql, params = []) {
    throw new Error(`${this.constructor.name} must implement all()`);
  }

  /**
   * Execute a write statement (INSERT / UPDATE / DELETE / DDL).
   * @param {string}  sql
   * @param {Array}   [params=[]]
   * @returns {Promise<{ changes: number, lastInsertRowid: number|null }>}
   */
  async run(sql, params = []) {
    throw new Error(`${this.constructor.name} must implement run()`);
  }

  /**
   * Execute one or more DDL statements with no parameters.
   * Accepts either a single SQL string or an array of SQL strings;
   * each string must be exactly one statement.
   * @param {string|string[]} statements
   * @returns {Promise<void>}
   */
  async exec(statements) {
    throw new Error(`${this.constructor.name} must implement exec()`);
  }

  /**
   * Run an async function atomically inside a transaction.
   * The function receives a context object { get, all, run } whose calls
   * are scoped to the open transaction.
   * Returns whatever the function returns.
   * @param {function} fn
   * @returns {Promise<any>}
   */
  async transaction(fn) {
    throw new Error(`${this.constructor.name} must implement transaction()`);
  }
}

module.exports = BaseAdapter;
