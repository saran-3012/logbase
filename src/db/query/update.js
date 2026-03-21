'use strict';

/**
 * Fluent UPDATE query builder.
 *
 * @example
 *   new UpdateQuery('api_tokens')
 *     .set({ last_used_at: rawExpr('unixepoch()') })
 *     .where(eq('id', tokenId))
 *
 * @example — PostgreSQL UPDATE … FROM
 *   new UpdateQuery('orders', 'o')
 *     .set({ status: value('shipped') })
 *     .from(tableRef('shipments', 's'))
 *     .where(eq('o.id', col('s.order_id')))
 *
 * @example — RETURNING
 *   new UpdateQuery('users').set({ email }).where(eq('id', id)).returning([col('id')])
 */
class UpdateQuery {
  constructor(table, alias = null) {
    if (!table || typeof table !== 'string') throw new Error('UpdateQuery: table name is required');
    this._table     = table;
    this._alias     = alias;
    this._set       = [];    // { col: string, value: ColumnExpr }[]
    this._from      = null;  // Source (PostgreSQL FROM in UPDATE)
    this._where     = null;  // ConditionNode
    this._returning = [];    // ColumnExpr[]
  }

  /**
   * SET columns.
   * Accepts a plain object (keys = column names, values = JS scalars or ColumnExpr nodes).
   * Bare JS values are automatically wrapped in ValueExpr (→ bound parameters).
   * Pass a RawExpr when you need a DB function: { ts: rawExpr('unixepoch()') }
   *
   * @param {object} assignments
   */
  set(assignments) {
    const { ValueExpr, ColRef, RawExpr, AliasExpr } = require('./nodes/columns');
    for (const [colName, val] of Object.entries(assignments)) {
      let expr;
      if (val instanceof ValueExpr || val instanceof ColRef ||
          val instanceof RawExpr   || val instanceof AliasExpr) {
        expr = val;
      } else {
        expr = new ValueExpr(val);
      }
      this._set.push({ col: colName, value: expr });
    }
    return this;
  }

  /**
   * FROM clause (PostgreSQL extension: UPDATE t SET … FROM other WHERE …).
   */
  from(source) { this._from = source; return this; }

  /**
   * WHERE condition. Multiple calls are AND-ed together.
   */
  where(condition) {
    if (!this._where) {
      this._where = condition;
    } else {
      const { and } = require('./nodes/conditions');
      this._where = and(this._where, condition);
    }
    return this;
  }

  /**
   * RETURNING clause.
   * @param {ColumnExpr[]} cols
   */
  returning(cols) {
    const { ColRef } = require('./nodes/columns');
    this._returning = cols.map(c => (typeof c === 'string' ? new ColRef(c) : c));
    return this;
  }
}

module.exports = UpdateQuery;
