#!/usr/bin/env node
'use strict';

/**
 * DESTRUCTIVE: drops every Logbase table and recreates the current schema.
 *
 * Low-level implementation — prefer the wrapper, which resolves the target
 * database and confirms before running:
 *
 *   npm run db:reset              local database, prompts
 *   npm run db:reset -- --yes     local database, no prompt
 *   npm run db:reset -- --turso   cloud database (requires .env)
 *
 * Direct use reads TURSO_DATABASE_URL from the environment:
 *
 *   node scripts/db-reset.js --yes
 *
 * Use when a schema change cannot be expressed as a migration, or to clear a
 * development database. All users, logs, collectors and credentials are lost.
 */

require('dotenv').config();

const db       = require('../src/db/database');
const tables   = require('../src/db/schema/tables.json');
const indexes  = require('../src/db/schema/indexes.json');

const TABLES_TO_DROP = [
  // Children first so foreign keys never block the drop.
  'collector_credentials',
  'oauth_refresh_tokens',
  'logs',
  'collectors',
  'users',
  '_schema_version',
  // Legacy objects from the pre-collector schema.
  'api_tokens',
  'oauth_clients',
];

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to run without --yes.\n');
    console.error('This deletes ALL data (users, logs, collectors, credentials).');
    console.error('Run:  npm run db:reset        (prompts, targets the local database)');
    console.error('  or: node scripts/db-reset.js --yes');
    process.exit(1);
  }

  console.log(`[reset] Target: ${process.env.TURSO_DATABASE_URL}`);

  const drops = [
    'DROP TRIGGER IF EXISTS logs_ai',
    'DROP TRIGGER IF EXISTS logs_ad',
    'DROP TRIGGER IF EXISTS logs_au',
    'DROP TABLE IF EXISTS logs_fts',
    ...TABLES_TO_DROP.map(t => `DROP TABLE IF EXISTS ${t}`),
  ];

  await db.exec(drops);
  console.log(`[reset] Dropped ${drops.length} object(s)`);

  await db.exec(db.compileSchema(tables, indexes));
  console.log('[reset] Schema recreated');

  // Mark the schema as fully migrated — the fresh schema already reflects
  // every migration, so none should re-run on next boot.
  const migrations = require('../src/db/schema/migrations.json');
  const { InsertQuery } = require('../src/db/query');
  await db.query(new InsertQuery('_schema_version').values({ version: migrations.length }));
  console.log(`[reset] Schema version set to ${migrations.length}`);

  console.log('[reset] Done. Register a new account to begin.');
}

main().catch(err => {
  console.error('[reset] Failed:', err.message);
  process.exit(1);
});
