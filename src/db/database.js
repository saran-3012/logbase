'use strict';

const LibSQLAdapter  = require('./adapters/libsql');
const tables         = require('./schema/tables.json');
const indexes        = require('./schema/indexes.json');
const migrations     = require('./schema/migrations.json');
const schemaVersionQ = require('./queries/schemaVersion');

// ── Adapter factory ────────────────────────────────────────────────────────────
// To add a new adapter: create src/db/adapters/<name>.js, set DB_ADAPTER=<name>.
const ADAPTERS = {
  libsql: LibSQLAdapter,
};

const adapterName = (process.env.DB_ADAPTER || 'libsql').toLowerCase();
const AdapterClass = ADAPTERS[adapterName];
if (!AdapterClass) {
  throw new Error(`Unknown DB_ADAPTER "${adapterName}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
}

const db = new AdapterClass(AdapterClass.configFromEnv());

// ── init() ─────────────────────────────────────────────────────────────────────
// Called once at server startup (in server.js) before app.listen().
// Compiles schema from JSON definitions and applies any pending migrations.
async function init() {
  // Compile neutral JSON schema → dialect-specific DDL and execute
  const ddl = db.compileSchema(tables, indexes);
  await db.exec(ddl);

  // Seed version row on first run
  const versionRow = await db.get(schemaVersionQ.select);
  if (!versionRow) {
    await db.run(schemaVersionQ.insert);
  }
  const currentVersion = versionRow ? Number(versionRow.version) : 0;

  // Apply any migrations not yet applied (skip version 1 — baseline only)
  for (let i = currentVersion; i < migrations.length; i++) {
    const migration = migrations[i];
    const stmts = db.compileMigration(migration);
    if (stmts.length > 0) {
      await db.transaction(async (ctx) => {
        for (const sql of stmts) {
          await ctx.run(sql);
        }
        await ctx.run(schemaVersionQ.update, [i + 1]);
      });
      console.log(`[db] Applied migration v${i + 1}: ${migration.description || migration.type}`);
    } else {
      // Baseline marker — just bump the version
      await db.run(schemaVersionQ.update, [i + 1]);
    }
  }

  console.log('[db] Initialized');
}

module.exports = db;
module.exports.init = init;

