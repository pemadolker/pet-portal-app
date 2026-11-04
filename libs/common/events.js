'use strict';
// Events on Redis Streams (proposal section 5, "Data and events").
//
// Producing: transactional outbox. A service writes the event into its own
// `outbox` table in the SAME database transaction as the change it describes,
// then a relay copies unsent rows to Redis with XADD. If the pod dies between
// commit and XADD the row is still there and the next relay pass sends it, so
// no event is ever lost and no event is sent for a change that rolled back.
//
// Consuming: one consumer group per service. Redis Streams delivers at least
// once, so every consumer records processed event ids (in a `processed_events`
// table inside the same transaction as its own writes) and skips repeats.
// Messages a crashed pod left un-acknowledged are claimed by another pod after
// CLAIM_IDLE_MS. After MAX_DELIVERIES failed attempts a message is copied to
// <stream>.dlq and acknowledged, so one poison message cannot block a stream.

const crypto = require('node:crypto');
const os = require('node:os');
const Redis = require('ioredis');
const otel = require('@opentelemetry/api');
const { env, envInt, service } = require('./config');
const { logger } = require('./logger');
const metrics = require('./metrics');
const db = require('./db');

const MAXLEN = envInt('STREAM_MAXLEN', 100_000);
const CLAIM_IDLE_MS = envInt('STREAM_CLAIM_IDLE_MS', 30_000);
const MAX_DELIVERIES = envInt('STREAM_MAX_DELIVERIES', 5);

const tracer = otel.trace.getTracer('pet-portal-events');
const connections = new Set();

function connect(name) {
  const r = new Redis(env('REDIS_URL', 'redis://localhost:6379'), {
    connectionName: `${service.name}:${name}`,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  r.on('error', (err) => logger.warn({ err: err.message, conn: name }, 'redis connection error'));
  connections.add(r);
  return r;
}

let shared;
function redis() {
  if (!shared) shared = connect('main');
  return shared;
}

function newEvent(type, data) {
  return { id: crypto.randomUUID(), type, occurredAt: new Date().toISOString(), producer: service.name, data };
}

function currentTraceparent() {
  const carrier = {};
  otel.propagation.inject(otel.context.active(), carrier);
  return carrier.traceparent || '';
}

async function xadd(stream, event, traceparent) {
  await redis().xadd(stream, 'MAXLEN', '~', MAXLEN, '*',
    'id', event.id, 'type', event.type, 'data', JSON.stringify(event), 'traceparent', traceparent || '');
  metrics.eventsPublished.inc({ stream });
}

/* ------------------------------------------------------------------ outbox */

// Call inside withTx(): the event commits or rolls back with the caller's change.
async function enqueue(client, stream, data) {
  const event = newEvent(stream, data);
  await client.query(
    'INSERT INTO outbox (id, stream, payload, traceparent) VALUES ($1, $2, $3, $4)',
    [event.id, stream, event, currentTraceparent()],
  );
  scheduleRelay();
  return event;
}

let relayTimer;
let relayRunning = false;
let relayStopped = false;

function scheduleRelay(delay = 0) {
  if (relayStopped) return;
  clearTimeout(relayTimer);
  relayTimer = setTimeout(relayOnce, delay);
}

async function relayOnce() {
  if (relayRunning) return scheduleRelay(200);
  relayRunning = true;
  let sent = 0;
  try {
    // SKIP LOCKED lets several replicas relay in parallel without sending a row twice.
    sent = await db.withTx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, stream, payload, traceparent FROM outbox
          WHERE sent_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`);
      for (const r of rows) await xadd(r.stream, r.payload, r.traceparent);
      if (rows.length) await c.query('UPDATE outbox SET sent_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      return rows.length;
    });
    if (Math.random() < 0.01) await db.query("DELETE FROM outbox WHERE sent_at < now() - interval '7 days'");
  } catch (err) {
    logger.warn({ err: err.message }, 'outbox relay failed, will retry');
  } finally {
    relayRunning = false;
    scheduleRelay(sent === 100 ? 0 : 1000);
  }
}

function startOutbox() { relayStopped = false; scheduleRelay(0); }
function stopOutbox() { relayStopped = true; clearTimeout(relayTimer); }

// For services without a database (email-worker): publish straight away.
async function publishDirect(stream, data) {
  const event = newEvent(stream, data);
  await xadd(stream, event, currentTraceparent());
  return event;
}

/* ---------------------------------------------------------------- consumer */

function parseFields(fields) {
  const o = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}

/**
 * createConsumer({ stream, group, handler, idempotency })
 *   handler(event, client) runs inside a DB transaction when idempotency = 'db'
 *   (the default), or with client = null when idempotency = 'redis'.
 */
function createConsumer({ stream, group = service.name, handler, idempotency = 'db', batch = 10 }) {
  const consumerName = `${service.podName || os.hostname()}`;
  const conn = connect(`consumer:${stream}`);
  let running = false;
  let lagTimer;

  async function ensureGroup() {
    try {
      // '0' so a brand-new consumer (for example search after a rebuild) reads the whole history.
      await conn.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
      logger.info({ stream, group }, 'consumer group created');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  async function alreadyProcessedRedis(id) {
    return (await redis().exists(`processed:${group}:${id}`)) === 1;
  }

  async function handle(entryId, fields, deliveries) {
    const f = parseFields(fields);
    let event;
    try { event = JSON.parse(f.data); } catch {
      logger.error({ stream, entryId }, 'unreadable event, dead-lettering');
      return deadLetter(entryId, fields, 'unparseable');
    }
    const parent = otel.propagation.extract(otel.context.active(), { traceparent: f.traceparent || '' });
    return tracer.startActiveSpan(`${stream} process`, { kind: otel.SpanKind.CONSUMER, attributes: {
      'messaging.system': 'redis', 'messaging.destination.name': stream, 'messaging.message.id': event.id,
      'messaging.consumer.group.name': group,
    } }, parent, async (span) => {
      try {
        let outcome = 'processed';
        if (idempotency === 'db') {
          await db.withTx(async (client) => {
            const r = await client.query(
              'INSERT INTO processed_events (event_id, stream) VALUES ($1, $2) ON CONFLICT DO NOTHING', [event.id, stream]);
            if (r.rowCount === 0) { outcome = 'duplicate'; return; }
            await handler(event, client);
          });
        } else if (await alreadyProcessedRedis(event.id)) {
          outcome = 'duplicate';
        } else {
          await handler(event, null);
          await redis().set(`processed:${group}:${event.id}`, '1', 'EX', 7 * 86400);
        }
        await conn.xack(stream, group, entryId);
        metrics.eventsConsumed.inc({ stream, outcome });
        if (outcome === 'duplicate') logger.info({ stream, eventId: event.id }, 'duplicate event skipped');
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: otel.SpanStatusCode.ERROR, message: err.message });
        metrics.eventsConsumed.inc({ stream, outcome: 'failed' });
        logger.error({ err: err.message, stream, eventId: event.id, deliveries }, 'event handler failed');
        if (deliveries >= MAX_DELIVERIES) await deadLetter(entryId, fields, err.message);
      } finally {
        span.end();
      }
    });
  }

  async function deadLetter(entryId, fields, reason) {
    await redis().xadd(`${stream}.dlq`, 'MAXLEN', '~', 10_000, '*', ...fields, 'reason', reason, 'group', group);
    await conn.xack(stream, group, entryId);
    metrics.eventsConsumed.inc({ stream, outcome: 'dead_lettered' });
  }

  async function deliveryCount(entryId) {
    const p = await conn.xpending(stream, group, entryId, entryId, 1);
    return p?.[0]?.[3] || 1;
  }

  async function updateLag() {
    try {
      const groups = await redis().xinfo('GROUPS', stream);
      for (const g of groups) {
        const o = parseFields(g);
        if (o.name !== group) continue;
        metrics.eventLag.set({ stream, group }, Number(o.lag ?? 0) || 0);
        metrics.eventPending.set({ stream, group }, Number(o.pending ?? 0) || 0);
      }
    } catch { /* stream may not exist yet */ }
  }

  async function loop() {
    let lastClaim = 0;
    while (running) {
      try {
        // 1) Take over messages another (probably dead) consumer has held too long.
        if (Date.now() - lastClaim > CLAIM_IDLE_MS / 2) {
          lastClaim = Date.now();
          const [, claimed] = await conn.xautoclaim(stream, group, consumerName, CLAIM_IDLE_MS, '0-0', 'COUNT', batch);
          for (const [id, fields] of claimed || []) {
            if (!fields) continue; // deleted by MAXLEN trimming
            await handle(id, fields, await deliveryCount(id));
          }
        }
        // 2) New messages.
        const res = await conn.xreadgroup('GROUP', group, consumerName, 'COUNT', batch, 'BLOCK', 5000, 'STREAMS', stream, '>');
        for (const [, entries] of res || []) {
          for (const [id, fields] of entries) await handle(id, fields, 1);
        }
      } catch (err) {
        if (!running) break;
        if (String(err.message).includes('NOGROUP')) await ensureGroup().catch(() => {});
        logger.warn({ err: err.message, stream }, 'consumer loop error, retrying in 2s');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return {
    stream,
    async start() {
      await ensureGroup();
      running = true;
      lagTimer = setInterval(updateLag, 10_000);
      updateLag();
      loop();
      logger.info({ stream, group, consumer: consumerName }, 'consumer started');
    },
    async stop() {
      running = false;
      clearInterval(lagTimer);
      conn.disconnect();
    },
  };
}

async function ping() {
  const r = await redis().ping();
  if (r !== 'PONG') throw new Error('redis ping failed');
}

async function close() {
  stopOutbox();
  for (const c of connections) c.disconnect();
  connections.clear();
  shared = undefined;
}

module.exports = { redis, enqueue, startOutbox, stopOutbox, publishDirect, createConsumer, ping, close, connect };
