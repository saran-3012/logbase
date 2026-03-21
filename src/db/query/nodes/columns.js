'use strict';

// ── Column expression node types ──────────────────────────────────────────────

/**
 * A column or table-qualified column reference.
 *   col('id')        → id
 *   col('l.id')      → l.id
 *   col('l.*')       → l.*
 */
class ColRef {
  constructor(expr) {
    if (!expr || typeof expr !== 'string') throw new Error('ColRef: expr must be a non-empty string');
    this.expr = expr;
  }
}

/**
 * A bound parameter value — always compiled to a placeholder (?, $1, …).
 *   value(42)       → ?  (with 42 in params)
 */
class ValueExpr {
  constructor(val) {
    this.val = val;
  }
}

/**
 * A verbatim SQL fragment — the escape hatch.
 * Use only for DB-specific functions (unixepoch(), NOW(), COUNT(*), etc.).
 *   raw('unixepoch()')                 → unixepoch()
 *   raw('unixepoch() + ?', [86400])    → unixepoch() + ?  (with 86400 in params)
 */
class RawExpr {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params;
  }
}

/**
 * Wraps any ColumnExpr with an AS alias.
 *   alias(col('id'), 'user_id')         → id AS user_id
 *   alias(raw('COUNT(*)'), 'total')      → COUNT(*) AS total
 */
class AliasExpr {
  constructor(expr, name) {
    if (!name || typeof name !== 'string') throw new Error('AliasExpr: alias name must be a non-empty string');
    this.expr = expr;
    this.name = name;
  }
}

/**
 * A scalar subquery inside a SELECT column list or condition.
 *   subquery(new SelectQuery(...))  → (SELECT …)
 */
class SubqueryExpr {
  constructor(query) {
    this.query = query;
  }
}

/**
 * A CASE … WHEN … THEN … ELSE … END expression.
 *
 *   case_()
 *     .when(eq('level', 'error'), value(1))
 *     .when(eq('level', 'warn'),  value(2))
 *     .else_(value(0))
 */
class CaseExpr {
  constructor() {
    this.subject = null; // optional: simple CASE subject expr
    this.whens = [];     // [{ condition: ConditionNode, result: ColumnExpr }]
    this.elseExpr = null;
  }

  /** Optional: CASE <subject> WHEN <value>… (simple form) */
  subject_(expr) { this.subject = expr; return this; }

  when(condition, result) {
    this.whens.push({ condition, result });
    return this;
  }

  else_(expr) { this.elseExpr = expr; return this; }
}

/**
 * A window function call:  fn OVER (PARTITION BY … ORDER BY … frame)
 *
 *   window_(raw('ROW_NUMBER()'))
 *     .partitionBy([col('user_id')])
 *     .orderBy([{ expr: col('timestamp'), dir: 'DESC' }])
 */
class WindowExpr {
  constructor(fn) {
    this.fn = fn; // ColumnExpr — the window function itself (e.g. raw('ROW_NUMBER()'))
    this.partitionByClauses = [];
    this.orderByClauses = [];
    this.frame = null; // optional: raw frame SQL e.g. 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'
  }

  partitionBy(exprs) { this.partitionByClauses = exprs; return this; }
  orderBy(clauses) { this.orderByClauses = clauses; return this; }
  frameClause(sql) { this.frame = sql; return this; }
}

/**
 * An aggregate function.
 *   count(col('id'))           → COUNT(id)
 *   count(col('id'), true)     → COUNT(DISTINCT id)
 *   sum(col('amount'))         → SUM(amount)
 */
class AggregateExpr {
  constructor(fn, expr, distinct = false) {
    this.fn = fn;           // 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
    this.expr = expr;       // ColumnExpr — what to aggregate
    this.distinct = distinct;
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Column / qualified-column reference (never parameterised) */
const col = (expr) => new ColRef(expr);

/** Bound parameter value (always becomes a placeholder) */
const value = (val) => new ValueExpr(val);

/** Verbatim SQL fragment */
const rawExpr = (sql, params = []) => new RawExpr(sql, params);

/** Wrap with AS alias */
const aliasExpr = (expr, name) => new AliasExpr(expr, name);

/** Scalar subquery */
const subqueryExpr = (query) => new SubqueryExpr(query);

/** Start a CASE expression */
const case_ = () => new CaseExpr();

/** Start a window function */
const window_ = (fn) => new WindowExpr(fn);

/** COUNT(expr) — pass distinct=true for COUNT(DISTINCT …) */
const count = (expr = rawExpr('*'), distinct = false) => new AggregateExpr('COUNT', expr, distinct);
const sum   = (expr) => new AggregateExpr('SUM',  expr);
const avg   = (expr) => new AggregateExpr('AVG',  expr);
const min   = (expr) => new AggregateExpr('MIN',  expr);
const max   = (expr) => new AggregateExpr('MAX',  expr);

module.exports = {
  ColRef, ValueExpr, RawExpr, AliasExpr, SubqueryExpr, CaseExpr, WindowExpr, AggregateExpr,
  col, value, rawExpr, aliasExpr, subqueryExpr, case_, window_,
  count, sum, avg, min, max,
};
