'use strict';

const SelectQuery = require('../query/select');
const InsertQuery = require('../query/insert');
const UpdateQuery = require('../query/update');
const DeleteQuery = require('../query/delete');

const { TableRef, SubquerySource, UsingClause } = require('../query/nodes/source');
const {
  ColRef, ValueExpr, RawExpr, AliasExpr, SubqueryExpr,
  CaseExpr, WindowExpr, AggregateExpr,
} = require('../query/nodes/columns');
const {
  ComparisonCondition, NullCondition, InCondition, BetweenCondition,
  ExistsCondition, NotCondition, LogicalCondition, RawCondition,
} = require('../query/nodes/conditions');
const { JoinClause } = require('../query/nodes/join');
const { CteClause }  = require('../query/nodes/cte');

/**
 * BaseCompiler — dialect-neutral recursive compiler.
 *
 * Subclasses must override:
 *   placeholder(index)  — returns '?' (SQLite/MySQL) or `$${index}` (PostgreSQL)
 *   quoteIdent(name)    — wraps an identifier: `"name"` or `` `name` ``
 *   fnMap()             — optional: returns { 'unixepoch()': 'NOW()' } override map
 *
 * The public API is:
 *   const { sql, params } = compiler.compile(queryObject);
 */
class BaseCompiler {
  constructor() {
    // Params are accumulated into this array across recursive calls.
    // Reset in compile() for each top-level invocation.
    this._params = [];
  }

  // ── Dialect hooks (implement in subclasses) ─────────────────────────────────

  /** Return the placeholder for the n-th parameter (1-based index). */
  placeholder(/* index */) {
    throw new Error(`${this.constructor.name} must implement placeholder()`);
  }

  /** Quote a single identifier segment. */
  quoteIdent(name) {
    throw new Error(`${this.constructor.name} must implement quoteIdent()`);
  }

  /**
   * Optional: dialect-specific function name overrides.
   * Returns { 'unixepoch()': 'replacement()' }
   */
  fnMap() { return {}; }

  // ── Public entry point ──────────────────────────────────────────────────────

  /**
   * Compile a query object into { sql: string, params: any[] }.
   * @param {SelectQuery|InsertQuery|UpdateQuery|DeleteQuery} query
   */
  compile(query) {
    this._params = [];

    if (query instanceof SelectQuery) return { sql: this._compileSelect(query), params: this._params };
    if (query instanceof InsertQuery) return { sql: this._compileInsert(query), params: this._params };
    if (query instanceof UpdateQuery) return { sql: this._compileUpdate(query), params: this._params };
    if (query instanceof DeleteQuery) return { sql: this._compileDelete(query), params: this._params };

    throw new Error(`BaseCompiler: unknown query type "${query?.constructor?.name}"`);
  }

  // ── SELECT ──────────────────────────────────────────────────────────────────

  _compileSelect(q) {
    const parts = [];

    // WITH / CTEs
    if (q._with && q._with.length > 0) {
      const hasRecursive = q._with.some(c => c.recursive);
      const cteParts = q._with.map(c => this._compileCte(c));
      parts.push(`WITH ${hasRecursive ? 'RECURSIVE ' : ''}${cteParts.join(', ')}`);
    }

    // SELECT [DISTINCT] columns
    const colList = q._columns.length > 0
      ? q._columns.map(c => this._compileColumnExpr(c)).join(', ')
      : '*';
    parts.push(`SELECT${q._distinct ? ' DISTINCT' : ''} ${colList}`);

    // FROM
    parts.push(`FROM ${this._compileSource(q._from)}`);

    // JOINs
    for (const j of q._joins) {
      parts.push(this._compileJoin(j));
    }

    // WHERE
    if (q._where) {
      parts.push(`WHERE ${this._compileCondition(q._where)}`);
    }

    // GROUP BY
    if (q._groupBy && q._groupBy.length > 0) {
      parts.push(`GROUP BY ${q._groupBy.map(e => this._compileColumnExpr(e)).join(', ')}`);
    }

    // HAVING
    if (q._having) {
      parts.push(`HAVING ${this._compileCondition(q._having)}`);
    }

    // UNION / UNION ALL / INTERSECT / EXCEPT
    for (const u of (q._union || [])) {
      parts.push(`${u.type} ${this._compileSelect(u.query)}`);
    }

    // ORDER BY
    if (q._orderBy && q._orderBy.length > 0) {
      const obs = q._orderBy.map(o => {
        let s = `${this._compileColumnExpr(o.expr)} ${o.dir}`;
        if (o.nulls) s += ` NULLS ${o.nulls}`;
        return s;
      });
      parts.push(`ORDER BY ${obs.join(', ')}`);
    }

    // LIMIT / OFFSET
    if (q._limit  !== null) parts.push(`LIMIT ${q._limit}`);
    if (q._offset !== null) parts.push(`OFFSET ${q._offset}`);

    return parts.join('\n');
  }

  // ── INSERT ──────────────────────────────────────────────────────────────────

  _compileInsert(q) {
    const parts = [];

    // Determine conflict prefix
    const prefix = q._onConflict === 'ignore' ? 'INSERT OR IGNORE INTO' : 'INSERT INTO';
    parts.push(`${prefix} ${this.quoteIdent(q._table)}`);

    if (q._fromSelect) {
      // INSERT … SELECT
      parts.push(this._compileSelect(q._fromSelect));
    } else {
      // INSERT … VALUES
      const rows = Array.isArray(q._values) ? q._values : [q._values];
      if (!rows.length || !rows[0]) throw new Error('InsertQuery: values are required');

      const keys = Object.keys(rows[0]);
      const colList = `(${keys.map(k => this.quoteIdent(k)).join(', ')})`;
      const placeholders = rows.map(row => {
        const ph = keys.map(k => {
          const v = row[k];
          return this._compileColumnExpr(
            (v instanceof ColRef || v instanceof ValueExpr || v instanceof RawExpr) ? v : new ValueExpr(v)
          );
        });
        return `(${ph.join(', ')})`;
      });

      parts.push(`${colList} VALUES ${placeholders.join(', ')}`);
    }

    // ON CONFLICT DO UPDATE (upsert)
    if (q._onConflict && q._onConflict !== 'ignore') {
      const { target, set } = q._onConflict;
      const setClauses = Object.entries(set).map(([k, v]) => {
        const expr = (v instanceof ValueExpr || v instanceof RawExpr || v instanceof ColRef)
          ? v : new ValueExpr(v);
        return `${this.quoteIdent(k)} = ${this._compileColumnExpr(expr)}`;
      });
      parts.push(`ON CONFLICT (${target.map(c => this.quoteIdent(c)).join(', ')}) DO UPDATE SET ${setClauses.join(', ')}`);
    }

    // RETURNING
    if (q._returning && q._returning.length > 0) {
      parts.push(`RETURNING ${q._returning.map(c => this._compileColumnExpr(c)).join(', ')}`);
    }

    return parts.join('\n');
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────

  _compileUpdate(q) {
    const parts = [];

    const tableExpr = q._alias
      ? `${this.quoteIdent(q._table)} ${this.quoteIdent(q._alias)}`
      : this.quoteIdent(q._table);
    parts.push(`UPDATE ${tableExpr}`);

    if (!q._set || q._set.length === 0) throw new Error('UpdateQuery: at least one SET column is required');
    const setClauses = q._set.map(s => `${this.quoteIdent(s.col)} = ${this._compileColumnExpr(s.value)}`);
    parts.push(`SET ${setClauses.join(', ')}`);

    if (q._from) parts.push(`FROM ${this._compileSource(q._from)}`);

    if (q._where) parts.push(`WHERE ${this._compileCondition(q._where)}`);

    if (q._returning && q._returning.length > 0) {
      parts.push(`RETURNING ${q._returning.map(c => this._compileColumnExpr(c)).join(', ')}`);
    }

    return parts.join('\n');
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────

  _compileDelete(q) {
    const parts = [];

    const tableExpr = q._alias
      ? `${this.quoteIdent(q._table)} ${this.quoteIdent(q._alias)}`
      : this.quoteIdent(q._table);
    parts.push(`DELETE FROM ${tableExpr}`);

    if (q._using && q._using.length > 0) {
      parts.push(`USING ${q._using.map(s => this._compileSource(s)).join(', ')}`);
    }

    if (q._where) parts.push(`WHERE ${this._compileCondition(q._where)}`);

    if (q._returning && q._returning.length > 0) {
      parts.push(`RETURNING ${q._returning.map(c => this._compileColumnExpr(c)).join(', ')}`);
    }

    return parts.join('\n');
  }

  // ── Sources ─────────────────────────────────────────────────────────────────

  _compileSource(source) {
    if (source instanceof TableRef) {
      const t = this.quoteIdent(source.table);
      return source.alias ? `${t} ${this.quoteIdent(source.alias)}` : t;
    }
    if (source instanceof SubquerySource) {
      return `(${this._compileSelect(source.query)}) ${this.quoteIdent(source.alias)}`;
    }
    throw new Error(`BaseCompiler: unknown source type "${source?.constructor?.name}"`);
  }

  // ── JOINs ───────────────────────────────────────────────────────────────────

  _compileJoin(join) {
    const src = this._compileSource(join.source);

    if (!join.on) {
      // CROSS JOIN or join with no explicit condition
      return `${join.type} JOIN ${src}`;
    }

    if (join.on instanceof UsingClause) {
      return `${join.type} JOIN ${src} USING (${join.on.columns.map(c => this.quoteIdent(c)).join(', ')})`;
    }

    return `${join.type} JOIN ${src} ON ${this._compileCondition(join.on)}`;
  }

  // ── Conditions ──────────────────────────────────────────────────────────────

  _compileCondition(cond) {
    if (cond instanceof ComparisonCondition) {
      const l = this._compileColumnExpr(cond.left);
      const r = this._compileColumnExpr(cond.right);
      return `${l} ${cond.op} ${r}`;
    }

    if (cond instanceof NullCondition) {
      const e = this._compileColumnExpr(cond.expr);
      return `${e} IS${cond.negate ? ' NOT' : ''} NULL`;
    }

    if (cond instanceof InCondition) {
      const e = this._compileColumnExpr(cond.expr);
      let list;
      if (cond.values instanceof SubqueryExpr) {
        list = `(${this._compileSelect(cond.values.query)})`;
      } else {
        list = `(${cond.values.map(v => this._compileColumnExpr(v)).join(', ')})`;
      }
      return `${e}${cond.negate ? ' NOT' : ''} IN ${list}`;
    }

    if (cond instanceof BetweenCondition) {
      const e  = this._compileColumnExpr(cond.expr);
      const lo = this._compileColumnExpr(cond.lo);
      const hi = this._compileColumnExpr(cond.hi);
      return `${e}${cond.negate ? ' NOT' : ''} BETWEEN ${lo} AND ${hi}`;
    }

    if (cond instanceof ExistsCondition) {
      const sub = this._compileSelect(cond.query);
      return `${cond.negate ? 'NOT ' : ''}EXISTS (${sub})`;
    }

    if (cond instanceof NotCondition) {
      return `NOT (${this._compileCondition(cond.condition)})`;
    }

    if (cond instanceof LogicalCondition) {
      const parts = cond.operands.map(o => {
        // Wrap OR operands inside AND in parens for correct precedence
        const compiled = this._compileCondition(o);
        const needsParens = (cond.op === 'AND' && o instanceof LogicalCondition && o.op === 'OR');
        return needsParens ? `(${compiled})` : compiled;
      });
      return parts.join(` ${cond.op} `);
    }

    if (cond instanceof RawCondition) {
      // Push raw params, substituting placeholders
      for (const p of cond.params) {
        this._params.push(p);
      }
      // Replace ? with dialect-specific placeholder
      return this._rewriteRawPlaceholders(cond.sql, cond.params.length);
    }

    throw new Error(`BaseCompiler: unknown condition type "${cond?.constructor?.name}"`);
  }

  // ── Column expressions ───────────────────────────────────────────────────────

  _compileColumnExpr(expr) {
    if (expr instanceof ColRef) {
      // Dot-qualified refs: quote each segment separately
      return expr.expr.split('.').map(seg => {
        if (seg === '*') return '*';
        return this.quoteIdent(seg);
      }).join('.');
    }

    if (expr instanceof ValueExpr) {
      this._params.push(expr.val);
      return this.placeholder(this._params.length);
    }

    if (expr instanceof RawExpr) {
      for (const p of expr.params) {
        this._params.push(p);
      }
      let sql = this._applyFnMap(expr.sql);
      return this._rewriteRawPlaceholders(sql, expr.params.length);
    }

    if (expr instanceof AliasExpr) {
      return `${this._compileColumnExpr(expr.expr)} AS ${this.quoteIdent(expr.name)}`;
    }

    if (expr instanceof SubqueryExpr) {
      return `(${this._compileSelect(expr.query)})`;
    }

    if (expr instanceof AggregateExpr) {
      const inner = this._compileColumnExpr(expr.expr);
      return `${expr.fn}(${expr.distinct ? 'DISTINCT ' : ''}${inner})`;
    }

    if (expr instanceof CaseExpr) {
      const subject = expr.subject ? ` ${this._compileColumnExpr(expr.subject)}` : '';
      const whens   = expr.whens.map(w =>
        `WHEN ${this._compileCondition(w.condition)} THEN ${this._compileColumnExpr(w.result)}`
      ).join(' ');
      const elseStr = expr.elseExpr ? ` ELSE ${this._compileColumnExpr(expr.elseExpr)}` : '';
      return `CASE${subject} ${whens}${elseStr} END`;
    }

    if (expr instanceof WindowExpr) {
      const fn = this._compileColumnExpr(expr.fn);
      const parts = [];
      if (expr.partitionByClauses.length > 0) {
        parts.push(`PARTITION BY ${expr.partitionByClauses.map(e => this._compileColumnExpr(e)).join(', ')}`);
      }
      if (expr.orderByClauses.length > 0) {
        const obs = expr.orderByClauses.map(o => `${this._compileColumnExpr(o.expr)} ${o.dir}`);
        parts.push(`ORDER BY ${obs.join(', ')}`);
      }
      if (expr.frame) parts.push(expr.frame);
      return `${fn} OVER (${parts.join(' ')})`;
    }

    throw new Error(`BaseCompiler: unknown column expression type "${expr?.constructor?.name}"`);
  }

  // ── CTEs ─────────────────────────────────────────────────────────────────────

  _compileCte(cte) {
    return `${this.quoteIdent(cte.name)} AS (${this._compileSelect(cte.query)})`;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /**
   * Rewrite positional `?` markers in a raw fragment to dialect-specific
   * placeholders.  For `?`-based dialects this is a no-op.
   * For $N dialects we replace each `?` with the running counter.
   * `count` is the number of params that were added for this fragment.
   */
  _rewriteRawPlaceholders(sql, count) {
    // Base implementation: no-op (? stays as ?)
    // PostgreSQL subclass overrides this.
    return sql;
  }

  /** Apply the dialect's function-name substitution map to a raw SQL string. */
  _applyFnMap(sql) {
    const map = this.fnMap();
    let result = sql;
    for (const [from, to] of Object.entries(map)) {
      result = result.replaceAll(from, to);
    }
    return result;
  }
}

module.exports = BaseCompiler;
