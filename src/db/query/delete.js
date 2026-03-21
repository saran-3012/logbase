'use strict';

/**
 * Fluent DELETE query builder.
 *
 * @example
 *   new DeleteQuery('logs')
 *     .where(lt('timestamp', cutoff))
 *
 * @example — scoped delete (delete only rows this user owns)
 *   new DeleteQuery('api_tokens')
 *     .where(and(eq('id', id), eq('user_id', userId)))
 *
 * @example — PostgreSQL DELETE … USING (join-like filtering without altering target)
 *   new DeleteQuery('orders', 'o')
 *     .using(tableRef('customers', 'c'))
 *     .where(and(eq('o.customer_id', col('c.id')), eq('c.country', 'XY')))
 *
 * @example — RETURNING
 *   new DeleteQuery('logs').where(lt('timestamp', cutoff)).returning([col('id')])
 */
class DeleteQuery {
  constructor(table, alias = null) {
    if (!table || typeof table !== 'string') throw new Error('DeleteQuery: table name is required');
    this._table     = table;
    this._alias     = alias;
    this._using     = [];    // Source[]  (PostgreSQL USING)
    this._where     = null;  // ConditionNode
    this._returning = [];    // ColumnExpr[]
  }

  /**
   * USING clause (PostgreSQL extension for join-style filtering in DELETE).
   * @param {TableRef|SubquerySource} source
   */
  using(source) {
    this._using.push(source);
    return this;
  }

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

module.exports = DeleteQuery;
