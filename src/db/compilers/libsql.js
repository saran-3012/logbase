'use strict';

const BaseCompiler = require('./base');

/**
 * Compiler for LibSQL / SQLite / Turso.
 *
 * Placeholder style : ?
 * Identifier quoting: "name"
 */
class LibSQLCompiler extends BaseCompiler {
  placeholder(/* index */) {
    return '?';
  }

  quoteIdent(name) {
    // Escape embedded double-quotes by doubling them (SQL standard).
    return `"${String(name).replace(/"/g, '""')}"`;
  }
}

module.exports = LibSQLCompiler;
