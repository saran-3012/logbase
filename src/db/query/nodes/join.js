'use strict';

const { TableRef, SubquerySource, UsingClause } = require('./source');

// ── Join types ────────────────────────────────────────────────────────────────

const JOIN_TYPES = ['INNER', 'LEFT', 'LEFT OUTER', 'RIGHT', 'RIGHT OUTER', 'FULL', 'FULL OUTER', 'CROSS', 'LATERAL'];

/**
 * Describes a single JOIN clause.
 *
 *   type   — join variety (INNER, LEFT, …)
 *   source — TableRef | SubquerySource  (the table / derived table being joined)
 *   on     — ConditionNode | UsingClause | null (null only for CROSS JOIN)
 */
class JoinClause {
  constructor(type, source, on = null) {
    const t = type.toUpperCase();
    if (!JOIN_TYPES.includes(t)) throw new Error(`JoinClause: unknown join type "${type}"`);
    if (!source) throw new Error('JoinClause: source is required');
    this.type   = t;
    this.source = source;
    this.on     = on; // ConditionNode | UsingClause | null
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/**
 * Promote the first argument to a source node when a plain string is given.
 * join helpers accept:
 *   inner('logs', condition)                    — shorthand for TableRef('logs')
 *   inner(tableRef('logs', 'l'), condition)     — explicit
 *   inner(subquerySource(query, 's'), condition) — derived table
 */
function _toSource(src, alias) {
  if (typeof src === 'string') return new TableRef(src, alias || null);
  if (src instanceof TableRef || src instanceof SubquerySource) return src;
  throw new Error('JoinClause: source must be a table name string, TableRef, or SubquerySource');
}

/**
 * Column equality shorthand used inside ON clauses.
 * on('l.user_id', 'u.id') returns a ComparisonCondition (uses ColRef on both sides).
 * This is just sugar — any ConditionNode works as the on argument.
 */
function on(left, right) {
  const { col }   = require('./columns');
  const { eq }    = require('./conditions');
  const leftNode  = typeof left  === 'string' ? col(left)  : left;
  const rightNode = typeof right === 'string' ? col(right) : right;
  return eq(leftNode, rightNode);
}

/**
 * INNER JOIN source ON condition
 *   inner('logs', on('logs.user_id', 'users.id'))
 *   inner(tableRef('logs', 'l'), and(...))
 *   inner(subquerySource(subQ, 's'), on('s.id', 'u.id'))
 */
const inner   = (src, cond, alias) => new JoinClause('INNER',        _toSource(src, alias), cond);
const left    = (src, cond, alias) => new JoinClause('LEFT',         _toSource(src, alias), cond);
const right   = (src, cond, alias) => new JoinClause('RIGHT',        _toSource(src, alias), cond);
const full    = (src, cond, alias) => new JoinClause('FULL',         _toSource(src, alias), cond);
const leftOuter  = (src, cond, alias) => new JoinClause('LEFT OUTER',  _toSource(src, alias), cond);
const rightOuter = (src, cond, alias) => new JoinClause('RIGHT OUTER', _toSource(src, alias), cond);
const fullOuter  = (src, cond, alias) => new JoinClause('FULL OUTER',  _toSource(src, alias), cond);

/** CROSS JOIN (no condition) */
const cross   = (src, alias) => new JoinClause('CROSS', _toSource(src, alias), null);

/** LATERAL JOIN (PostgreSQL / modern SQL) */
const lateral = (src, cond, alias) => new JoinClause('LATERAL', _toSource(src, alias), cond);

module.exports = {
  JoinClause,
  on, inner, left, right, full,
  leftOuter, rightOuter, fullOuter,
  cross, lateral,
};
