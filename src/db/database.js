'use strict';

const LibSQLAdapter  = require('./adapters/libsql');
const tables         = require('./schema/tables.json');
const indexes        = require('./schema/indexes.json');
const migrations     = require('./schema/migrations.json');
const { SelectQuery, InsertQuery, UpdateQuery } = require('./query');

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
  // ── Order matters ───────────────────────────────────────────────────────────
  // Migrations run BEFORE the schema DDL, not after.
  //
  // The DDL is written against the *current* schema. On an existing database
  // still carrying an older schema, a statement like
  //   CREATE INDEX idx_logs_collector ON logs(collector_id)
  // fails with "no such column" because the migration that rebuilds `logs`
  // hasn't run yet. Running migrations first brings the database up to the
  // shape the DDL expects; the DDL (all CREATE … IF NOT EXISTS) then fills in
  // whatever the migrations dropped or never created.
  //
  // Bootstrap just the version table so the migration runner has somewhere to
  // read from — it is never touched by migrations.
  const versionTable = tables.filter(t => t.name === '_schema_version');
  await db.exec(db.compileSchema(versionTable, []));

  // Seed version row on first run
  const versionRow = await db.query(
    new SelectQuery('_schema_version').columns(['version']).single()
  );
  if (!versionRow) {
    await db.query(new InsertQuery('_schema_version').values({ version: 0 }));
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
        await ctx.query(new UpdateQuery('_schema_version').set({ version: i + 1 }));
      });
      console.log(`[db] Applied migration v${i + 1}: ${migration.description || migration.type}`);
    } else {
      // Baseline marker — just bump the version
      await db.query(new UpdateQuery('_schema_version').set({ version: i + 1 }));
    }
  }

  // Schema DDL — runs after migrations so it always sees the up-to-date shape.
  // Creates anything missing: a fresh database in full, or the objects a
  // destructive migration just dropped. Every statement is CREATE … IF NOT
  // EXISTS, so it is a no-op on an already-current database.
  await db.exec(db.compileSchema(tables, indexes));

  console.log('[db] Initialized');
}

module.exports = db;
module.exports.init = init;

