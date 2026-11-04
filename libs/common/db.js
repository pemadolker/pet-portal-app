'use strict';
// PostgreSQL access. Each service logs in with its own role and only sees its own
// schema (search_path), so no service can read another service's tables
// (proposal section 5, decision D2).

const { Pool } = require('pg');
const { env, envInt, secret } = require('./config');
const { logger } = require('./logger');

let pool;

function getPool() {
  if (pool) return pool;
  const schema = env('DB_SCHEMA');
  if (!/^[a-z_]+$/.test(schema)) throw new Error('DB_SCHEMA must be lower-case letters and underscores');
  pool = new Pool({
    host: env('PGHOST', 'localhost'),
    port: envInt('PGPORT', 5432),
    database: env('PGDATABASE', 'petportal'),
    user: env('PGUSER'),
    password: secret('PGPASSWORD'),
    max: envInt('DB_POOL_MAX', 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: envInt('DB_STATEMENT_TIMEOUT_MS', 5_000),
    application_name: env('SERVICE_NAME'),
    options: `-c search_path=${schema}`,
  });
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  return pool;
}

const query = (text, params) => getPool().query(text, params);

// Runs fn(client) inside BEGIN/COMMIT; rolls back on any error.
async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  await getPool().query('SELECT 1');
}

async function close() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = { getPool, query, withTx, ping, close };
