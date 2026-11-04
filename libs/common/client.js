'use strict';
// Service-to-service calls over the cluster network (Kubernetes Service DNS,
// for example http://shelter:8080). Only /internal/* routes are used here: the
// gateway refuses /internal paths from outside, and NetworkPolicy only lets the
// named callers reach each service.
//
// Each call has a timeout, GETs are retried twice with a short back-off, and a
// small circuit breaker fails fast for 10 s after 5 failures in a row, so one
// slow service cannot tie up every pod that depends on it.

const { HttpError } = require('./errors');
const { logger } = require('./logger');
const metrics = require('./metrics');

const upstreamCalls = metrics.counter('upstream_requests_total',
  'Calls this service made to other services, by target and outcome.', ['target', 'outcome']);

const breakers = new Map();

function baseUrl(target) {
  const key = `${target.toUpperCase().replace(/-/g, '_')}_URL`;
  return process.env[key] || `http://${target}:8080`;
}

function breaker(target) {
  if (!breakers.has(target)) breakers.set(target, { failures: 0, openUntil: 0 });
  return breakers.get(target);
}

async function call(target, method, path, { body, headers = {}, timeoutMs = 3000, retries } = {}) {
  const b = breaker(target);
  if (Date.now() < b.openUntil) {
    upstreamCalls.inc({ target, outcome: 'circuit_open' });
    throw new HttpError(503, `The ${target} service is temporarily unavailable. Please try again shortly.`);
  }
  const attempts = 1 + (retries ?? (method === 'GET' ? 2 : 0));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${baseUrl(target)}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = res.status === 204 ? '' : await res.text();
      const data = text ? JSON.parse(text) : null;
      if (res.status >= 500) throw new Error(`${target} answered ${res.status}`);
      b.failures = 0;
      upstreamCalls.inc({ target, outcome: res.ok ? 'ok' : 'client_error' });
      return { status: res.status, data };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  b.failures += 1;
  if (b.failures >= 5) { b.openUntil = Date.now() + 10_000; b.failures = 0; logger.warn({ target }, 'circuit opened'); }
  upstreamCalls.inc({ target, outcome: 'error' });
  logger.warn({ target, path, err: lastErr?.message }, 'upstream call failed');
  throw new HttpError(503, `The ${target} service is not responding. Please try again shortly.`);
}

// Convenience: returns data for 2xx, null for 404, throws HttpError otherwise.
async function get(target, path, opts) {
  const r = await call(target, 'GET', path, opts);
  if (r.status === 404) return null;
  if (r.status >= 400) throw new HttpError(r.status, r.data?.error || `${target} refused the request`);
  return r.data;
}
async function post(target, path, body, opts) {
  const r = await call(target, 'POST', path, { ...opts, body });
  if (r.status >= 400) throw new HttpError(r.status, r.data?.error || `${target} refused the request`, r.data?.code ? { code: r.data.code } : {});
  return r.data;
}

module.exports = { call, get, post, baseUrl };
