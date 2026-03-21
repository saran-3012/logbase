'use strict';

const BaseCompiler = require('./base');

/**
 * Compiler for PostgreSQL.
 *
 * Placeholder style : $1, $2, $3 …  (positional)
 * Identifier quoting: "name"
 * Function overrides: unixepoch() → EXTRACT(EPOCH FROM NOW())
 *
 * NOTE: This is a stub. Implement a PostgreSQL adapter alongside this compiler
 *       when adding Postgres support.
 */
class PostgreSQLCompiler extends BaseCompiler {
  placeholder(index) {
    return `$${index}`;
  }

  quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  fnMap() {
    return {
      'unixepoch()': 'EXTRACT(EPOCH FROM NOW())::bigint',
    };
  }

  /**
   * PostgreSQL uses $N positional placeholders.
   * We track how many params were added before this fragment so we can compute
   * the right $N index for each `?` found in the raw SQL.
   */
  _rewriteRawPlaceholders(sql, count) {
    // The params for this fragment were just pushed — their indices are
    // (total - count + 1) … total.
    const base = this._params.length - count;
    let i = 0;
    return sql.replace(/\?/g, () => `$${base + (++i)}`);
  }
}

module.exports = PostgreSQLCompiler;
