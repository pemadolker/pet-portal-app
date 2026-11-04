'use strict';
// A small HTTP framework shared by all services, built on node:http so each pod
// stays well under its 128 MiB limit. It gives every service the same:
//   * routing with :params, JSON bodies (64 KB limit) and JSON errors
//   * GET /health (liveness), GET /ready (readiness: database and Redis reachable),
//     GET /metrics (Prometheus)
//   * RED metrics per route, request ids, structured access logs
//   * the caller's identity from the gateway's X-User-* headers
//   * graceful shutdown: on SIGTERM fail readiness, leave etcd, drain, then exit
//     (this is what makes rolling updates lose zero requests, experiment E5)

const http = require('node:http');
const crypto = require('node:crypto');
const { service, envInt } = require('./config');
const { logger } = require('./logger');
const metrics = require('./metrics');
const { HttpError } = require('./errors');
const registry = require('./registry');
const tracing = require('./tracing');

const BODY_LIMIT = 64 * 1024;

function compile(pattern) {
  const parts = pattern.split('/');
  return (path) => {
    const p = path.split('/');
    if (p.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        if (!p[i]) return null;
        try { params[parts[i].slice(1)] = decodeURIComponent(p[i]); } catch { return null; }
      } else if (parts[i] !== p[i]) return null;
    }
    return params;
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new HttpError(413, 'Request body is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(new HttpError(400, 'The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function userFrom(headers) {
  const id = headers['x-user-id'];
  const role = headers['x-user-role'];
  if (!id || !['adopter', 'staff', 'admin'].includes(role)) return null;
  return { id, role, shelterId: headers['x-shelter-id'] || null };
}

function send(res, status, body, extraHeaders = {}) {
  const headers = {
    'X-Served-By': service.name,
    'X-Pod': service.podName,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function createApp() {
  const routes = [];
  const readinessChecks = [];
  const shutdownHooks = [];
  let ready = false;
  let shuttingDown = false;
  let server;

  const add = (method) => (pattern, handler) => routes.push({ method, pattern, match: compile(pattern), handler });

  async function dispatch(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    let route = 'unmatched';
    let status = 500;
    metrics.httpInFlight.inc();

    try {
      if (req.method === 'GET' && path === '/health') { status = 200; return send(res, 200, { status: 'ok', service: service.name }); }
      if (req.method === 'GET' && path === '/ready') {
        route = '/ready';
        const ok = ready && !shuttingDown && (await runChecks());
        status = ok ? 200 : 503;
        return send(res, status, { status: ok ? 'ready' : 'not ready', service: service.name });
      }
      if (req.method === 'GET' && path === '/metrics') {
        status = 200;
        const text = await metrics.registry.metrics();
        res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
        return res.end(text);
      }

      let found;
      let methodMismatch = false;
      for (const r of routes) {
        const params = r.match(path);
        if (!params) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        found = { r, params };
        break;
      }
      if (!found) {
        status = methodMismatch ? 405 : 404;
        return send(res, status, { error: methodMismatch ? 'Method not allowed.' : `No route for ${req.method} ${path}` });
      }
      route = found.r.pattern;
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const ctx = {
        req, res, params: found.params, query: Object.fromEntries(url.searchParams), body,
        user: userFrom(req.headers), requestId,
        log: logger.child({ requestId }),
        forward: { 'x-request-id': requestId },
      };
      const out = await found.r.handler(ctx);
      if (out && out.__response) {
        status = out.status;
        return send(res, status, out.body, out.headers);
      }
      status = out === undefined ? 204 : 200;
      return send(res, status, out);
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        return send(res, status, { error: err.message, ...err.extra });
      }
      status = 500;
      logger.error({ err: err.message, stack: err.stack, requestId, path }, 'unhandled error');
      return send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    } finally {
      metrics.httpInFlight.dec();
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      if (route !== '/ready' && path !== '/health' && path !== '/metrics') {
        const labels = { method: req.method, route, status_code: String(status) };
        metrics.httpRequests.inc(labels);
        metrics.httpDuration.observe(labels, seconds);
        logger[status >= 500 ? 'error' : 'info']({
          requestId, method: req.method, route, path, status, ms: Math.round(seconds * 1000),
          user: req.headers['x-user-id'] || undefined,
        }, 'request');
      }
    }
  }

  async function runChecks() {
    try {
      await Promise.all(readinessChecks.map((fn) => Promise.race([
        fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('check timed out')), 1500)),
      ])));
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, 'readiness check failed');
      return false;
    }
  }

  async function listen() {
    server = http.createServer((req, res) => {
      dispatch(req, res).catch((err) => { logger.error({ err: err.message }, 'dispatch failed'); try { send(res, 500, { error: 'Internal error' }); } catch { /* already sent */ } });
    });
    server.keepAliveTimeout = 65_000; // longer than the ingress/gateway idle timeout
    server.headersTimeout = 66_000;
    await new Promise((resolve) => server.listen(service.port, resolve));
    ready = true;
    logger.info({ port: service.port }, `${service.name} listening`);
    await registry.register().catch((err) => logger.warn({ err: err.message }, 'registry unavailable at start-up; continuing'));

    const stop = (signal) => shutdown(signal).then(() => process.exit(0), () => process.exit(1));
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
    return server;
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: failing readiness and leaving the registry');
    await registry.deregister();
    // Give the endpoints controller, kube-proxy, the ingress and the gateway time to
    // stop sending us new requests before we stop accepting them.
    await new Promise((r) => setTimeout(r, envInt('SHUTDOWN_DELAY_MS', 5000)));
    await new Promise((r) => server.close(r));
    for (const hook of shutdownHooks.reverse()) {
      try { await hook(); } catch (err) { logger.warn({ err: err.message }, 'shutdown hook failed'); }
    }
    await tracing.shutdown();
    logger.info('stopped');
  }

  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    readiness: (fn) => readinessChecks.push(fn),
    onShutdown: (fn) => shutdownHooks.push(fn),
    listen,
    shutdown,
    get server() { return server; },
  };
}

// Helper so handlers can say `return created(row)`.
const respond = (status, body, headers) => ({ __response: true, status, body, headers });
const created = (body) => respond(201, body);
const noContent = () => respond(204, undefined);

module.exports = { createApp, send, respond, created, noContent, userFrom };
