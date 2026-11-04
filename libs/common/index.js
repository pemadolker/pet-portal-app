'use strict';
// Shared library for the 13 backend services and the api-gateway.
// Services require this package; tracing.js is preloaded separately with
// `node --require ./libs/common/tracing.js` (see the Dockerfile).

const config = require('./config');
const { logger } = require('./logger');
const errors = require('./errors');
const http = require('./http');
const db = require('./db');
const events = require('./events');
const registry = require('./registry');
const client = require('./client');
const metrics = require('./metrics');
const validate = require('./validate');

/**
 * Standard start-up for a service that owns a PostgreSQL schema and uses Redis.
 * Registers readiness checks and shutdown hooks in the right order.
 */
async function start(app, { usesDb = true, usesRedis = true, outbox = false, consumers = [], onStart } = {}) {
  if (usesDb) {
    app.readiness(() => db.ping());
    app.onShutdown(() => db.close());
  }
  if (usesRedis) {
    app.readiness(() => events.ping());
    app.onShutdown(() => events.close());
  }
  for (const c of consumers) app.onShutdown(() => c.stop());
  await app.listen();
  if (outbox) events.startOutbox();
  for (const c of consumers) {
    // Retry until Redis is reachable; the pod stays not-ready meanwhile.
    (async function startConsumer(delay = 1000) {
      try { await c.start(); } catch (err) {
        logger.warn({ err: err.message, stream: c.stream }, 'consumer start failed, retrying');
        setTimeout(() => startConsumer(Math.min(delay * 2, 15000)), delay);
      }
    })();
  }
  if (onStart) await onStart();
}

process.on('unhandledRejection', (err) => logger.error({ err: err?.message, stack: err?.stack }, 'unhandled rejection'));

module.exports = { config, logger, errors, http, db, events, registry, client, metrics, validate, start };
