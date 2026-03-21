'use strict';

/**
 * Represents a concrete table reference with an optional alias.
 *
 *   TableRef('logs')         → logs
 *   TableRef('logs', 'l')   → logs AS l
 */
class TableRef {
  constructor(table, alias = null) {
    if (!table || typeof table !== 'string') throw new Error('TableRef: table name must be a non-empty string');
    this.table = table;
    this.alias = alias;
  }
}

/**
 * Represents a derived table — a subquery used as a source in FROM or JOIN.
 * An alias is mandatory because the SQL spec requires one.
 *
 *   SubquerySource(query, 'sub') → (SELECT …) AS sub
 */
class SubquerySource {
  constructor(query, alias) {
    if (!alias || typeof alias !== 'string') throw new Error('SubquerySource: alias is required');
    this.query = query;
    this.alias = alias;
  }
}

/**
 * Represents the USING shorthand in a join.
 *
 *   UsingClause(['user_id'])  → USING (user_id)
 */
class UsingClause {
  constructor(columns) {
    if (!Array.isArray(columns) || columns.length === 0) throw new Error('UsingClause: columns must be a non-empty array');
    this.columns = columns;
  }
}

/** Convenience factory — table with optional alias */
function tableRef(table, alias) { return new TableRef(table, alias); }

/** Convenience factory — subquery source */
function subquerySource(query, alias) { return new SubquerySource(query, alias); }

/** Convenience factory — USING clause */
function using(columns) {
  return new UsingClause(Array.isArray(columns) ? columns : [columns]);
}

module.exports = { TableRef, SubquerySource, UsingClause, tableRef, subquerySource, using };
