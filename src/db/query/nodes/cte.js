'use strict';

/**
 * A Common Table Expression (CTE):
 *
 *   WITH <name> AS (SELECT …)
 *   WITH RECURSIVE <name> AS (SELECT … UNION ALL SELECT …)
 */
class CteClause {
  constructor(name, query, recursive = false) {
    if (!name || typeof name !== 'string') throw new Error('CteClause: name must be a non-empty string');
    this.name      = name;
    this.query     = query;    // SelectQuery
    this.recursive = recursive;
  }
}

/** Non-recursive CTE */
const cte = (name, query) => new CteClause(name, query, false);

/** Recursive CTE */
const recursiveCte = (name, query) => new CteClause(name, query, true);

module.exports = { CteClause, cte, recursiveCte };
