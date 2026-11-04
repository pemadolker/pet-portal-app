'use strict';
// api-gateway (service 2): the only way into the backend.
//
// For every request under /api it:
//   1. refuses /internal/* paths (those are for service-to-service calls only)
//   2. removes any X-User-* headers the client sent, verifies the JWT once
//      (RS256, public key only) and forwards the user as X-User-Id / X-User-Role /
//      X-Shelter-Id (decision D5). Services trust these headers, which is why
//      NetworkPolicy lets only the gateway reach them (experiment E9).
//   3. applies rate limits in Redis, shared by all gateway pods
//   4. picks a live pod of the owning service from the etcd registry
//      (round-robin) and proxies the request; if the registry is empty or etcd
//      is down it falls back to the Kubernetes Service name
//   5. records RED metrics per route and passes the trace context on
//
// Live settings are read from etcd under /pet-portal/<env>/config/gateway/ and
// change without a restart (for example before a load test):
//   rate_limit_per_minute        per user (or per IP when logged out), default 300
//   auth_rate_limit_per_minute   per IP for /login and /signup, default 20
//   read_only                    "true" refuses writes with 503 (maintenance)

const http = require('node:http');
const crypto = require('node:crypto');
const jose = require('jose');
const { config, logger, metrics, registry, events } = require('../../../libs/common');

const { service } = config;

// Path prefix -> owning service (docs/API-CONTRACT.md, gateway routing table).
const ROUTES = {
  signup: 'signup', login: 'login', profile: 'profile', pets: 'pet', search: 'search', shelters: 'shelter',
  favorites: 'favorites', adoptions: 'adoption', reviews: 'review', history: 'history',
  notifications: 'notification', reports: 'reporting',
};

const BODY_LIMIT = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = config.envInt('UPSTREAM_TIMEOUT_MS', 10_000);
const TRUST_PROXY = config.envBool('TRUST_PROXY', true);
const USE_REGISTRY = config.env('UPSTREAM_DISCOVERY', 'registry') === 'registry';
const RATE_LIMIT_ENABLED = config.envBool('RATE_LIMIT_ENABLED', true);

const upstreamDuration = metrics.histogram('gateway_upstream_duration_seconds', 'Time the owning service took to answer.', ['upstream', 'status_code'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
const rateLimited = metrics.counter('gateway_rate_limited_total', 'Requests refused by the rate limiter.', ['bucket']);
const authFailures = metrics.counter('gateway_auth_failures_total', 'Requests with a missing, invalid or expired token.', ['reason']);
const discovery = metrics.counter('gateway_upstream_discovery_total', 'How the upstream address was found.', ['source']);
const registryInstances = metrics.gauge('gateway_registry_instances', 'Live instances per service in the etcd registry.', ['upstream']);

/* ---------------------------------------------------------------- settings */

const live = { rateLimit: 300, authRateLimit: 20, readOnly: false };
const instances = new Map(); // service -> [url, ...]
const rr = new Map();

function applyConfig(map) {
  const get = (k) => map.get(`/config/gateway/${k}`);
  live.rateLimit = Number(get('rate_limit_per_minute')) || 300;
  live.authRateLimit = Number(get('auth_rate_limit_per_minute')) || 20;
  live.readOnly = get('read_only') === 'true';
  logger.info({ live }, 'gateway settings loaded');
}

function applyServices(map) {
  instances.clear();
  for (const [key, value] of map) {
    const name = key.split('/')[2]; // /services/<name>/<pod>
    try {
      const { url } = JSON.parse(value);
      if (!instances.has(name)) instances.set(name, []);
      instances.get(name).push(url);
    } catch { /* ignore malformed entries */ }
  }
  for (const name of Object.values(ROUTES)) registryInstances.set({ upstream: name }, instances.get(name)?.length || 0);
}

function pickUpstream(name) {
  const list = USE_REGISTRY ? instances.get(name) : null;
  if (list && list.length) {
    const i = (rr.get(name) || 0) % list.length;
    rr.set(name, i + 1);
    discovery.inc({ source: 'registry' });
    return list[i];
  }
  discovery.inc({ source: 'dns' });
  return process.env[`${name.toUpperCase().replace(/-/g, '_')}_URL`] || `http://${name}:8080`;
}

const dnsUrl = (name) => process.env[`${name.toUpperCase().replace(/-/g, '_')}_URL`] || `http://${name}:8080`;

/* --------------------------------------------------------------------- auth */

let publicKey;
async function verify(token) {
  publicKey ||= await jose.importSPKI(config.secret('JWT_PUBLIC_KEY'), 'RS256');
  const { payload } = await jose.jwtVerify(token, publicKey, { issuer: 'pet-portal-login', audience: 'pet-portal', algorithms: ['RS256'] });
  return payload;
}

/* --------------------------------------------------------------- rate limit */

async function overLimit(bucket, id, limit) {
  if (!RATE_LIMIT_ENABLED) return false;
  const windowKey = `rl:${bucket}:${id}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const r = events.redis();
    const [[, count]] = await r.multi().incr(windowKey).expire(windowKey, 70).exec();
    return count > limit;
  } catch {
    return false; // Redis down: fail open rather than take the site down
  }
}

/* -------------------------------------------------------------------- proxy */

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Served-By': 'api-gateway', ...headers,
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(target, req, path, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, target);
    const up = http.request(url, { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS }, resolve);
    up.on('timeout', () => up.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    up.on('error', reject);
    if (body.length) up.write(body);
    up.end();
  });
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

async function handle(req, res) {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, 'http://gateway');
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const segment = path.split('/')[1] || '';
  const upstream = ROUTES[segment];
  const route = upstream ? `/${segment}` : 'unmatched';
  const requestId = (typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id']))
    ? req.headers['x-request-id'] : crypto.randomUUID();
  let status = 500;
  metrics.httpInFlight.inc();

  try {
    if (req.method === 'GET' && url.pathname === '/health') { status = 200; return json(res, 200, { status: 'ok', service: 'api-gateway' }); }
    if (req.method === 'GET' && url.pathname === '/ready') { status = shuttingDown ? 503 : 200; return json(res, status, { status: shuttingDown ? 'stopping' : 'ready' }); }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      status = 200;
      res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
      return res.end(await metrics.registry.metrics());
    }
    if (path.startsWith('/internal') || path.includes('/internal/')) { status = 404; return json(res, 404, { error: 'Not found.' }); }
    if (!upstream) { status = 404; return json(res, 404, { error: `No route for ${req.method} ${path}` }); }
    if (live.readOnly && req.method !== 'GET') {
      status = 503;
      return json(res, 503, { error: 'The portal is in maintenance. You can browse, but changes are paused for a few minutes.' }, { 'Retry-After': '120' });
    }

    const clientIp = (TRUST_PROXY && (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()))
      || req.socket.remoteAddress || 'unknown';

    // Identity: never trust identity headers from outside.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || k.startsWith('x-user-') || k === 'x-shelter-id' || k === 'authorization') continue;
      headers[k] = v;
    }
    let claims = null;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        claims = await verify(auth.slice(7));
      } catch (err) {
        authFailures.inc({ reason: err.code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid' });
        status = 401;
        return json(res, 401, { error: 'Your session has ended. Log in again.' });
      }
      headers['x-user-id'] = claims.sub;
      headers['x-user-role'] = claims.role;
      if (claims.shelter_id) headers['x-shelter-id'] = claims.shelter_id;
    }

    // Rate limits.
    if ((segment === 'login' || segment === 'signup') && req.method === 'POST') {
      if (await overLimit('auth', clientIp, live.authRateLimit)) {
        rateLimited.inc({ bucket: 'auth' });
        status = 429;
        return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' }, { 'Retry-After': '60' });
      }
    } else if (await overLimit('api', claims ? `u:${claims.sub}` : `ip:${clientIp}`, live.rateLimit)) {
      rateLimited.inc({ bucket: 'api' });
      status = 429;
      return json(res, 429, { error: 'Too many requests. Slow down and try again in a minute.' }, { 'Retry-After': '60' });
    }

    headers['x-request-id'] = requestId;
    headers['x-forwarded-for'] = clientIp;
    let body;
    try { body = await readBody(req); } catch (err) {
      status = err.status || 400;
      return json(res, status, { error: 'Request body is too large.' });
    }
    headers['content-length'] = String(body.length);
    const upPath = path + url.search;

    const upStarted = process.hrtime.bigint();
    let upRes;
    try {
      upRes = await forward(pickUpstream(upstream), req, upPath, headers, body);
    } catch (err) {
      // A refused connection means the request never reached a pod (for example a
      // registry entry for a pod that just stopped), so it is safe to retry once
      // through the Kubernetes Service, even for POST.
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH') {
        logger.warn({ upstream, err: err.code }, 'stale upstream, retrying through the Service');
        upRes = await forward(dnsUrl(upstream), req, upPath, headers, body);
      } else throw err;
    }
    status = upRes.statusCode;
    upstreamDuration.observe({ upstream, status_code: String(status) }, Number(process.hrtime.bigint() - upStarted) / 1e9);

    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) outHeaders[k] = v;
    outHeaders['x-request-id'] = requestId;
    res.writeHead(status, outHeaders);
    upRes.pipe(res);
    await new Promise((resolve) => { res.on('finish', resolve); res.on('close', resolve); });
  } catch (err) {
    const timeout = err.code === 'ETIMEDOUT';
    status = timeout ? 504 : 502;
    logger.error({ err: err.message, code: err.code, upstream, requestId }, 'upstream failed');
    if (!res.headersSent) {
      json(res, status, { error: timeout ? 'The service took too long to answer. Please try again.' : `The ${upstream || 'requested'} service is not available right now. Please try again shortly.` });
    } else res.destroy();
  } finally {
    metrics.httpInFlight.dec();
    if (!['/health', '/ready', '/metrics'].includes(url.pathname)) {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = { method: req.method, route, status_code: String(status) };
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(labels, seconds);
      logger[status >= 500 ? 'error' : 'info']({ requestId, method: req.method, route, path, status, upstream, ms: Math.round(seconds * 1000) }, 'request');
    }
  }
}

/* ---------------------------------------------------------------- lifecycle */

let shuttingDown = false;
const server = http.createServer((req, res) => { handle(req, res).catch((err) => logger.error({ err: err.message }, 'handler crashed')); });
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const watches = [];
async function main() {
  await verify('x.y.z').catch(() => {}); // load the public key early; a bad key fails here, not on the first user
  if (!publicKey) { logger.fatal('JWT_PUBLIC_KEY could not be loaded'); process.exit(1); }
  if (registry.enabled()) {
    watches.push(registry.watchPrefix('/config/gateway/', applyConfig));
    watches.push(registry.watchPrefix('/services/', applyServices));
  } else {
    logger.warn('ETCD_ENDPOINTS not set: routing by Kubernetes Service names only, default settings');
  }
  await new Promise((r) => server.listen(service.port, r));
  logger.info({ port: service.port, discovery: USE_REGISTRY ? 'registry' : 'dns' }, 'api-gateway listening');
  await registry.register().catch(() => {});
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await registry.deregister();
  await new Promise((r) => setTimeout(r, config.envInt('SHUTDOWN_DELAY_MS', 5000)));
  for (const w of watches) w.stop();
  await new Promise((r) => server.close(r));
  await events.close();
  await require('../../../libs/common/tracing').shutdown();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => { logger.fatal({ err: err.message }, 'gateway failed to start'); process.exit(1); });
