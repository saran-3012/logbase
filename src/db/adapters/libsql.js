'use strict';

const { createClient } = require('@libsql/client');
const BaseAdapter = require('./base');

/**
 * LibSQL / Turso adapter.
 *
 * Configuration (environment variables):
 *   TURSO_DATABASE_URL  — libsql://…  for Turso cloud
 *                       — file:./data/logs.db  for local SQLite file
 *   TURSO_AUTH_TOKEN    — required for Turso cloud; omit for local file
 */
class LibSQLAdapter extends BaseAdapter {
  constructor() {
    super();
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) {
      throw new Error('TURSO_DATABASE_URL environment variable is required');
    }
    this.client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }

  async get(sql, params = []) {
    const result = await this.client.execute({ sql, args: params });
    return result.rows[0] ?? null;
  }

  async all(sql, params = []) {
    const result = await this.client.execute({ sql, args: params });
    return result.rows;
  }

  async run(sql, params = []) {
    const result = await this.client.execute({ sql, args: params });
    return {
      changes:          result.rowsAffected,
      lastInsertRowid:  result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
    };
  }

  async exec(statements) {
    const list = (Array.isArray(statements) ? statements : [statements])
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (list.length === 0) return;
    await this.client.batch(list.map(sql => ({ sql })), 'write');
  }

  async transaction(fn) {
    const tx = await this.client.transaction('write');
    const ctx = {
      get: async (sql, params = []) => {
        const r = await tx.execute({ sql, args: params });
        return r.rows[0] ?? null;
      },
      all: async (sql, params = []) => {
        const r = await tx.execute({ sql, args: params });
        return r.rows;
      },
      run: async (sql, params = []) => {
        const r = await tx.execute({ sql, args: params });
        return {
          changes:         r.rowsAffected,
          lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null,
        };
      },
    };
    try {
      const result = await fn(ctx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}

module.exports = LibSQLAdapter;
