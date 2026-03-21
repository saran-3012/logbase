'use strict';

const { TableRef, SubquerySource } = require('./nodes/source');

/**
 * Fluent SELECT query builder.
 *
 * @example
 * new SelectQuery('logs', 'l')
 *   .columns([col('l.id'), alias(count(), 'total')])
 *   .join(inner('api_tokens', on('api_tokens.id', 'l.token_id')))
 *   .where(eq('l.user_id', userId))
 *   .orderBy('l.timestamp', 'DESC')
 *   .limit(50).offset(0)
 */
class SelectQuery {
  /**
   * @param {string|TableRef|SubquerySource} from  — table name, TableRef, or SubquerySource
   * @param {string} [alias]  — shorthand alias when 'from' is a string
   */
  constructor(from, alias = null) {
    // Normalise 'from' to a source node
    if (typeof from === 'string') {
      this._from = new TableRef(from, alias);
    } else if (from instanceof TableRef || from instanceof SubquerySource) {
      this._from = from;
    } else {
      throw new Error('SelectQuery: from must be a table name string, TableRef, or SubquerySource');
    }

    this._with       = [];   // CteClause[]
    this._distinct   = false;
    this._columns    = [];   // ColumnExpr[]  — empty = SELECT *
    this._joins      = [];   // JoinClause[]
    this._where      = null; // ConditionNode | null
    this._groupBy    = [];   // ColumnExpr[]
    this._having     = null; // ConditionNode | null
    this._orderBy    = [];   // { expr, dir, nulls? }[]
    this._limit      = null;
    this._offset     = null;
    this._single     = false; // hint to adapter: use get() not all()
    this._union      = [];   // { type: 'UNION'|'UNION ALL'|…, query: SelectQuery }[]
  }

  // ── CTEs ────────────────────────────────────────────────────────────────────
  with(...ctes) { this._with.push(...ctes); return this; }

  // ── DISTINCT ────────────────────────────────────────────────────────────────
  distinct() { this._distinct = true; return this; }

  // ── Columns ─────────────────────────────────────────────────────────────────
  /**
   * @param {Array} cols  — ColumnExpr[], or bare strings interpreted as ColRef
   */
  columns(cols) {
    const { ColRef } = require('./nodes/columns');
    this._columns = cols.map(c => (typeof c === 'string' ? new ColRef(c) : c));
    return this;
  }

  // ── JOINs ───────────────────────────────────────────────────────────────────
  join(...joins) { this._joins.push(...joins); return this; }

  // ── WHERE ───────────────────────────────────────────────────────────────────
  /**
   * Add a WHERE condition. Multiple calls are AND-ed together.
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

  // ── GROUP BY ────────────────────────────────────────────────────────────────
  groupBy(exprs) {
    const { ColRef } = require('./nodes/columns');
    const arr = Array.isArray(exprs) ? exprs : [exprs];
    this._groupBy = arr.map(e => (typeof e === 'string' ? new ColRef(e) : e));
    return this;
  }

  // ── HAVING ──────────────────────────────────────────────────────────────────
  having(condition) { this._having = condition; return this; }

  // ── ORDER BY ────────────────────────────────────────────────────────────────
  /**
   * @param {ColumnExpr|string} expr — column or expression to sort by
   * @param {'ASC'|'DESC'} dir
   * @param {'FIRST'|'LAST'|null} nulls  — NULLS FIRST / NULLS LAST
   */
  orderBy(expr, dir = 'ASC', nulls = null) {
    const { ColRef } = require('./nodes/columns');
    const e = typeof expr === 'string' ? new ColRef(expr) : expr;
    this._orderBy.push({ expr: e, dir: dir.toUpperCase(), nulls });
    return this;
  }

  // ── LIMIT / OFFSET ──────────────────────────────────────────────────────────
  limit(n)  { this._limit  = Number(n); return this; }
  offset(n) { this._offset = Number(n); return this; }

  // ── UNION / UNION ALL / INTERSECT / EXCEPT ──────────────────────────────────
  union(query)        { this._union.push({ type: 'UNION',     query }); return this; }
  unionAll(query)     { this._union.push({ type: 'UNION ALL', query }); return this; }
  intersect(query)    { this._union.push({ type: 'INTERSECT', query }); return this; }
  except(query)       { this._union.push({ type: 'EXCEPT',    query }); return this; }

  // ── Adapter hint ────────────────────────────────────────────────────────────
  /**
   * Tell the adapter to use get() (returns first row / null) instead of all().
   */
  single() { this._single = true; return this; }
}

module.exports = SelectQuery;
