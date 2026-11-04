'use strict';
// Service registry on the three-member etcd cluster (proposal decision D4).
//
//  * Every service registers  /pet-portal/<env>/services/<name>/<pod>  =  {"url": "http://<podIP>:8080", ...}
//    attached to a 15 s lease that it keeps alive. If the pod dies the lease
//    expires and the entry disappears on its own. On SIGTERM it revokes the lease
//    first, so the gateway stops routing to it before it shuts down.
//  * The api-gateway reads and watches /services/ to route requests, and
//    /config/ for live settings (rate limits, maintenance mode) that change
//    without a redeploy.
//
// It talks to etcd's built-in JSON gateway (/v3/...) with fetch, so no gRPC
// library is needed and each pod stays small. Several endpoints can be given;
// requests fail over to the next one, which is what experiment E8 relies on.

const { env, envInt, service } = require('./config');
const { logger } = require('./logger');

const endpoints = env('ETCD_ENDPOINTS', '').split(',').map((s) => s.trim()).filter(Boolean);
const PREFIX = `/pet-portal/${service.environment}`;
const TTL = envInt('REGISTRY_TTL_SECONDS', 15);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s || '', 'base64').toString('utf8');

// Smallest key greater than every key with this prefix (etcd range_end).
function prefixEnd(prefix) {
  const buf = Buffer.from(prefix, 'utf8');
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] < 0xff) { buf[i] += 1; return buf.subarray(0, i + 1).toString('base64'); }
  }
  return b64('\0');
}

let preferred = 0;
async function call(path, body, { timeoutMs = 3000, signal } = {}) {
  let lastErr;
  for (let i = 0; i < endpoints.length; i++) {
    const idx = (preferred + i) % endpoints.length;
    try {
      const res = await fetch(`${endpoints[idx]}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`etcd ${path} returned ${res.status}`);
      preferred = idx;
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no etcd endpoints configured');
}
const callJson = async (path, body, opts) => (await call(path, body, opts)).json();

const enabled = () => endpoints.length > 0;

/* ------------------------------------------------------------ registration */

let leaseId;
let keepAliveTimer;
let registered = false;

async function register(extra = {}) {
  if (!enabled()) return;
  const key = `${PREFIX}/services/${service.name}/${service.podName}`;
  const value = JSON.stringify({
    url: `http://${service.podIp}:${service.port}`, pod: service.podName, version: service.version,
    namespace: service.namespace, startedAt: new Date().toISOString(), ...extra,
  });

  const grantAndPut = async () => {
    const lease = await callJson('/v3/lease/grant', { TTL });
    leaseId = lease.ID;
    await callJson('/v3/kv/put', { key: b64(key), value: b64(value), lease: leaseId });
    registered = true;
    logger.info({ key, ttl: TTL }, 'registered in etcd');
  };

  const keepAlive = async () => {
    try {
      if (!leaseId) return await grantAndPut();
      const r = await callJson('/v3/lease/keepalive', { ID: leaseId });
      // TTL missing or 0 means the lease expired (for example etcd lost quorum for a while): register again.
      if (!r.result || !Number(r.result.TTL)) { leaseId = undefined; await grantAndPut(); }
    } catch (err) {
      registered = false;
      logger.warn({ err: err.message }, 'etcd keepalive failed, will retry');
    }
  };

  await keepAlive();
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(keepAlive, Math.max(1000, (TTL * 1000) / 3));
  keepAliveTimer.unref();
}

async function deregister() {
  clearInterval(keepAliveTimer);
  if (!enabled() || !leaseId) return;
  try {
    await callJson('/v3/lease/revoke', { ID: leaseId }, { timeoutMs: 1500 });
    logger.info('deregistered from etcd');
  } catch (err) {
    logger.warn({ err: err.message }, 'etcd deregister failed; the lease will expire on its own');
  }
  leaseId = undefined;
  registered = false;
}

/* --------------------------------------------------------- reading/watching */

async function getPrefix(sub) {
  const key = `${PREFIX}${sub}`;
  const r = await callJson('/v3/kv/range', { key: b64(key), range_end: prefixEnd(key) });
  return (r.kvs || []).map((kv) => ({ key: unb64(kv.key).slice(PREFIX.length), value: unb64(kv.value) }));
}

async function put(sub, value) {
  await callJson('/v3/kv/put', { key: b64(`${PREFIX}${sub}`), value: b64(value) });
}

/**
 * Keeps an in-memory copy of everything under PREFIX+sub and calls onChange(map)
 * whenever it changes. Uses a watch stream and falls back to polling every 10 s,
 * so a lost watch (etcd member restart) never leaves the map stale for long.
 */
function watchPrefix(sub, onChange) {
  let stopped = false;
  let controller;
  let map = new Map();

  async function reload() {
    const items = await getPrefix(sub);
    map = new Map(items.map((i) => [i.key, i.value]));
    onChange(map);
  }

  async function watchLoop() {
    while (!stopped) {
      try {
        await reload();
        controller = new AbortController();
        const key = `${PREFIX}${sub}`;
        const res = await call('/v3/watch', { create_request: { key: b64(key), range_end: prefixEnd(key) } },
          { signal: controller.signal });
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            const events = msg.result?.events || [];
            if (!events.length) continue;
            for (const e of events) {
              const k = unb64(e.kv.key).slice(PREFIX.length);
              if (e.type === 'DELETE') map.delete(k); else map.set(k, unb64(e.kv.value));
            }
            onChange(map);
          }
        }
      } catch (err) {
        if (stopped) break;
        logger.warn({ err: err.message, sub }, 'etcd watch interrupted, reconnecting');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const poll = setInterval(() => { reload().catch(() => {}); }, 10_000);
  poll.unref();
  if (enabled()) watchLoop();
  return { stop() { stopped = true; clearInterval(poll); controller?.abort(); } };
}

module.exports = {
  enabled, register, deregister, getPrefix, put, watchPrefix, isRegistered: () => registered, PREFIX,
};
