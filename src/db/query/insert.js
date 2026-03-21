'use strict';

const SelectQuery = require('./select');

/**
 * Fluent INSERT query builder.
 *
 * @example — single row
 *   new InsertQuery('users')
 *     .values({ username, email, password_hash })
 *
 * @example — batch (array of plain objects with matching keys)
 *   new InsertQuery('logs')
 *     .values([entry1, entry2, entry3])
 *
 * @example — INSERT … SELECT
 *   new InsertQuery('archive_logs')
 *     .fromSelect(new SelectQuery('logs').where(lt('timestamp', cutoff)))
 *
 * @example — ON CONFLICT DO NOTHING
 *   new InsertQuery('users').values({…}).onConflict('ignore')
 *
 * @example — ON CONFLICT DO UPDATE (upsert)
 *   new InsertQuery('users')
 *     .values({…})
 *     .onConflict({ target: ['email'], set: { username } })
 *
 * @example — RETURNING
 *   new InsertQuery('users').values({…}).returning([col('id'), col('username')])
 */
class InsertQuery {
  constructor(table) {
    if (!table || typeof table !== 'string') throw new Error('InsertQuery: table name is required');
    this._table      = table;
    this._values     = null;       // object | object[]
    this._fromSelect = null;       // SelectQuery
    this._onConflict = null;       // 'ignore' | { target: string[], set: object }
    this._returning  = [];         // ColumnExpr[]
  }

  /**
   * Provide row values.
   * @param {object|object[]} data  — plain object (single row) or array (batch)
   */
  values(data) {
    this._values = data;
    return this;
  }

  /**
   * INSERT … SELECT instead of explicit values.
   */
  fromSelect(query) {
    if (!(query instanceof SelectQuery)) throw new Error('InsertQuery.fromSelect: expected SelectQuery');
    this._fromSelect = query;
    return this;
  }

  /**
   * ON CONFLICT handling.
   * @param {'ignore'|{target: string[], set: object}} action
   */
  onConflict(action) {
    this._onConflict = action;
    return this;
  }

  /**
   * RETURNING clause (supported by PostgreSQL and LibSQL/SQLite ≥ 3.35).
   * @param {ColumnExpr[]} cols
   */
  returning(cols) {
    const { ColRef } = require('./nodes/columns');
    this._returning = cols.map(c => (typeof c === 'string' ? new ColRef(c) : c));
    return this;
  }
}

module.exports = InsertQuery;
