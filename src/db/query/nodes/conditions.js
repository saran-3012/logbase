'use strict';

// ── Condition node types ──────────────────────────────────────────────────────

/**
 * A comparison: left <op> right
 * left  — ColRef | RawExpr | SubqueryExpr  (the thing being compared)
 * right — ValueExpr | ColRef | SubqueryExpr
 *
 * Op: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'ILIKE' | 'NOT LIKE'
 */
class ComparisonCondition {
  constructor(left, op, right) {
    this.left = left;
    this.op   = op;
    this.right = right;
  }
}

/** field IS NULL / IS NOT NULL */
class NullCondition {
  constructor(expr, negate = false) {
    this.expr   = expr;
    this.negate = negate; // true → IS NOT NULL
  }
}

/**
 * expr IN (v1, v2, …) or expr IN (subquery)
 * values — ValueExpr[] | SubqueryExpr
 */
class InCondition {
  constructor(expr, values, negate = false) {
    this.expr   = expr;
    this.values = values; // ValueExpr[] or SubqueryExpr
    this.negate = negate; // true → NOT IN
  }
}

/**
 * expr BETWEEN lo AND hi  (inclusive, as per SQL standard)
 */
class BetweenCondition {
  constructor(expr, lo, hi, negate = false) {
    this.expr   = expr;
    this.lo     = lo;
    this.hi     = hi;
    this.negate = negate; // true → NOT BETWEEN
  }
}

/**
 * EXISTS (subquery) / NOT EXISTS (subquery)
 */
class ExistsCondition {
  constructor(query, negate = false) {
    this.query  = query;
    this.negate = negate; // true → NOT EXISTS
  }
}

/**
 * NOT (condition)
 */
class NotCondition {
  constructor(condition) {
    this.condition = condition;
  }
}

/**
 * AND / OR of an arbitrary number of conditions.
 * operands — ConditionNode[]
 */
class LogicalCondition {
  constructor(op, operands) {
    if (!['AND', 'OR'].includes(op)) throw new Error(`LogicalCondition: op must be AND or OR, got "${op}"`);
    if (operands.length === 0) throw new Error('LogicalCondition: requires at least one operand');
    this.op       = op;  // 'AND' | 'OR'
    this.operands = operands;
  }
}

/**
 * Verbatim SQL condition fragment — escape hatch for dialect-specific
 * constructs like FTS5 MATCH, tsvector @@ tsquery, etc.
 *
 *   raw('logs_fts MATCH ?', [ftsQuery])
 */
class RawCondition {
  constructor(sql, params = []) {
    this.sql    = sql;
    this.params = params;
  }
}

// ── Column / value helpers re-used inside conditions ─────────────────────────
// Imported here so call sites can do: const { eq, col, value } = require('…/conditions')
const { ColRef, ValueExpr, RawExpr, SubqueryExpr } = require('./columns');

// ── Factory helpers ───────────────────────────────────────────────────────────

// Promote a bare JS value or string-column to the right node type.
// Rules:
//   ColRef / ValueExpr / RawExpr / SubqueryExpr  → pass through unchanged
//   string                                        → treat as column reference
//   anything else                                 → treat as bound value
function _coerce(x) {
  if (x instanceof ColRef || x instanceof ValueExpr ||
      x instanceof RawExpr || x instanceof SubqueryExpr) return x;
  if (typeof x === 'string') return new ColRef(x);
  return new ValueExpr(x);
}

// Value side of a comparison: bare JS scalars become bound parameters.
function _coerceValue(x) {
  if (x instanceof ValueExpr || x instanceof ColRef ||
      x instanceof RawExpr   || x instanceof SubqueryExpr) return x;
  return new ValueExpr(x);
}

const eq    = (left, right) => new ComparisonCondition(_coerce(left), '=',       _coerceValue(right));
const neq   = (left, right) => new ComparisonCondition(_coerce(left), '!=',      _coerceValue(right));
const gt    = (left, right) => new ComparisonCondition(_coerce(left), '>',       _coerceValue(right));
const gte   = (left, right) => new ComparisonCondition(_coerce(left), '>=',      _coerceValue(right));
const lt    = (left, right) => new ComparisonCondition(_coerce(left), '<',       _coerceValue(right));
const lte   = (left, right) => new ComparisonCondition(_coerce(left), '<=',      _coerceValue(right));
const like  = (left, right) => new ComparisonCondition(_coerce(left), 'LIKE',    _coerceValue(right));
const ilike = (left, right) => new ComparisonCondition(_coerce(left), 'ILIKE',   _coerceValue(right));
const notLike=(left, right) => new ComparisonCondition(_coerce(left), 'NOT LIKE',_coerceValue(right));

const isNull    = (expr) => new NullCondition(_coerce(expr), false);
const isNotNull = (expr) => new NullCondition(_coerce(expr), true);

const inList    = (expr, vals) => new InCondition(_coerce(expr), wrapInValues(vals), false);
const notInList = (expr, vals) => new InCondition(_coerce(expr), wrapInValues(vals), true);

const between    = (expr, lo, hi) => new BetweenCondition(_coerce(expr), _coerceValue(lo), _coerceValue(hi), false);
const notBetween = (expr, lo, hi) => new BetweenCondition(_coerce(expr), _coerceValue(lo), _coerceValue(hi), true);

const exists    = (query) => new ExistsCondition(query, false);
const notExists = (query) => new ExistsCondition(query, true);

const not = (condition) => new NotCondition(condition);

/** AND of all supplied conditions.  and(c1, c2, c3 …) → (c1 AND c2 AND c3 …) */
const and = (...conditions) => {
  const flat = conditions.flat(); // allow and([c1, c2]) or and(c1, c2)
  return flat.length === 1 ? flat[0] : new LogicalCondition('AND', flat);
};

/** OR of all supplied conditions.  or(c1, c2, …) → (c1 OR c2 OR …) */
const or = (...conditions) => {
  const flat = conditions.flat();
  return flat.length === 1 ? flat[0] : new LogicalCondition('OR', flat);
};

/** Verbatim SQL condition — FTS MATCH, tsvector @@, etc. */
const rawCond = (sql, params = []) => new RawCondition(sql, params);

// Helper: accept array of JS scalars, ColRef, or a SubqueryExpr for IN
function wrapInValues(vals) {
  if (vals instanceof SubqueryExpr) return vals;
  // Lazy-require to avoid circular dep with SubqueryExpr import
  const { SubqueryExpr: SE } = require('./columns');
  if (vals instanceof SE) return vals;
  return (Array.isArray(vals) ? vals : [vals]).map(_coerceValue);
}

module.exports = {
  // Classes
  ComparisonCondition, NullCondition, InCondition, BetweenCondition,
  ExistsCondition, NotCondition, LogicalCondition, RawCondition,
  // Factories
  eq, neq, gt, gte, lt, lte, like, ilike, notLike,
  isNull, isNotNull, inList, notInList,
  between, notBetween,
  exists, notExists,
  not, and, or,
  rawCond,
};
