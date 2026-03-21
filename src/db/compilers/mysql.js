'use strict';

const BaseCompiler = require('./base');

/**
 * Compiler for MySQL / MariaDB.
 *
 * Placeholder style : ?  (same as SQLite)
 * Identifier quoting: `name`  (backtick)
 * Function overrides: unixepoch() → UNIX_TIMESTAMP()
 *
 * NOTE: This is a stub. Implement a MySQL adapter alongside this compiler
 *       when adding MySQL support.
 */
class MySQLCompiler extends BaseCompiler {
  placeholder(/* index */) {
    return '?';
  }

  quoteIdent(name) {
    // Escape embedded backticks by doubling them.
    return '`' + String(name).replace(/`/g, '``') + '`';
  }

  fnMap() {
    return {
      'unixepoch()': 'UNIX_TIMESTAMP()',
    };
  }
}

module.exports = MySQLCompiler;
