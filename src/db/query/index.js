'use strict';

// ── Query builders ────────────────────────────────────────────────────────────
const SelectQuery = require('./select');
const InsertQuery = require('./insert');
const UpdateQuery = require('./update');
const DeleteQuery = require('./delete');

// ── Source nodes ──────────────────────────────────────────────────────────────
const { TableRef, SubquerySource, UsingClause,
        tableRef, subquerySource, using } = require('./nodes/source');

// ── Column expression nodes ───────────────────────────────────────────────────
const {
  ColRef, ValueExpr, RawExpr, AliasExpr, SubqueryExpr,
  CaseExpr, WindowExpr, AggregateExpr,
  col, value, rawExpr, aliasExpr, subqueryExpr,
  case_, window_, count, sum, avg, min, max,
} = require('./nodes/columns');

// ── Condition nodes ───────────────────────────────────────────────────────────
const {
  ComparisonCondition, NullCondition, InCondition, BetweenCondition,
  ExistsCondition, NotCondition, LogicalCondition, RawCondition,
  eq, neq, gt, gte, lt, lte, like, ilike, notLike,
  isNull, isNotNull, inList, notInList,
  between, notBetween,
  exists, notExists,
  not, and, or,
  rawCond,
} = require('./nodes/conditions');

// ── Join nodes ────────────────────────────────────────────────────────────────
const {
  JoinClause,
  on, inner, left, right, full,
  leftOuter, rightOuter, fullOuter,
  cross, lateral,
} = require('./nodes/join');

// ── CTE nodes ─────────────────────────────────────────────────────────────────
const { CteClause, cte, recursiveCte } = require('./nodes/cte');

module.exports = {
  // Builders
  SelectQuery, InsertQuery, UpdateQuery, DeleteQuery,

  // Source nodes + factories
  TableRef, SubquerySource, UsingClause,
  tableRef, subquerySource, using,

  // Column expression nodes + factories
  ColRef, ValueExpr, RawExpr, AliasExpr, SubqueryExpr,
  CaseExpr, WindowExpr, AggregateExpr,
  col, value, rawExpr, aliasExpr, subqueryExpr,
  case_, window_, count, sum, avg, min, max,

  // Condition nodes + factories
  ComparisonCondition, NullCondition, InCondition, BetweenCondition,
  ExistsCondition, NotCondition, LogicalCondition, RawCondition,
  eq, neq, gt, gte, lt, lte, like, ilike, notLike,
  isNull, isNotNull, inList, notInList,
  between, notBetween,
  exists, notExists,
  not, and, or,
  rawCond,

  // Join nodes + factories
  JoinClause, on, inner, left, right, full,
  leftOuter, rightOuter, fullOuter, cross, lateral,

  // CTE nodes + factories
  CteClause, cte, recursiveCte,
};
