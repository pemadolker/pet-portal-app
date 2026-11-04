#!/usr/bin/env node
'use strict';
// Schema migrations. Runs as a Helm PreSync hook Job before new pods start
// (charts/microservice/templates/migration-job.yaml), and locally with
//   SERVICE_NAME=pet DB_SCHEMA=pet ... node libs/common/migrate.js services/pet/migrations
//
// Files are applied in name order (001_init.sql, 002_x.sql, ...), each in its own
// transaction, and recorded in <schema>.schema_migrations. A transaction-level
// advisory lock stops two Jobs from migrating the same schema at once.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function migrate(dir) {
  const db = require('./db');
  const { logger } = require('./logger');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pool = db.getPool();
  const lockKey = crypto.createHash('sha1').update(`migrate:${process.env.DB_SCHEMA}`).digest().readInt32BE(0);

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== sum) throw new Error(`Migration ${file} was changed after it was applied. Add a new file instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    logger.info({ count: files.length }, 'schema up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const dir = process.argv[2] || process.env.MIGRATIONS_DIR || path.join(process.cwd(), 'migrations');
  migrate(dir)
    .then(() => require('./db').close())
    .then(() => process.exit(0))
    .catch((err) => { console.error(JSON.stringify({ level: 'error', msg: err.message })); process.exit(1); });
}
