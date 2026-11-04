'use strict';
// The shared HTTP layer: routing, JSON errors, identity headers, limits, probes, metrics.
process.env.SERVICE_NAME = 'unit';
process.env.PORT = '18999';
process.env.LOG_LEVEL = 'silent';
process.env.SHUTDOWN_DELAY_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, created } = require('../../libs/common/http');
const { requireRole, need } = require('../../libs/common/errors');

const BASE = 'http://127.0.0.1:18999';
const app = createApp();
app.get('/things/:id', ({ params, query }) => ({ id: params.id, q: query.q || null }));
app.post('/things', ({ body, user }) => { requireRole(user, 'staff'); need(body.name, 400, 'Name needed.'); return created({ name: body.name, by: user.id }); });
app.delete('/things/:id', () => undefined);

test.before(() => app.listen());
test.after(() => new Promise((r) => app.server.close(r)));

const call = async (method, path, { body, headers } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await r.text();
  return { status: r.status, headers: r.headers, data: text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};

test('routes with params and query', async () => {
  const r = await call('GET', '/things/42?q=x');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { id: '42', q: 'x' });
  assert.equal(r.headers.get('x-served-by'), 'unit');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('404 and 405 are JSON errors', async () => {
  assert.equal((await call('GET', '/nope')).status, 404);
  const r = await call('PUT', '/things/1');
  assert.equal(r.status, 405);
  assert.ok(r.data.error);
});

test('identity comes only from the gateway headers', async () => {
  assert.equal((await call('POST', '/things', { body: '{"name":"a"}' })).status, 401);
  const wrongRole = await call('POST', '/things', { body: '{"name":"a"}', headers: { 'x-user-id': 'u1', 'x-user-role': 'adopter' } });
  assert.equal(wrongRole.status, 403);
  const bogusRole = await call('POST', '/things', { body: '{"name":"a"}', headers: { 'x-user-id': 'u1', 'x-user-role': 'root' } });
  assert.equal(bogusRole.status, 401);
  const ok = await call('POST', '/things', { body: '{"name":"a"}', headers: { 'x-user-id': 'u1', 'x-user-role': 'staff' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.data, { name: 'a', by: 'u1' });
});

test('bad JSON is 400, a huge body is 413', async () => {
  const h = { 'x-user-id': 'u1', 'x-user-role': 'staff' };
  assert.equal((await call('POST', '/things', { body: '{not json', headers: h })).status, 400);
  const big = JSON.stringify({ name: 'x'.repeat(70 * 1024) });
  const r = await call('POST', '/things', { body: big, headers: h }).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
});

test('204 for handlers that return nothing', async () => {
  assert.equal((await call('DELETE', '/things/1')).status, 204);
});

test('probes and metrics', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/ready')).status, 200);
  const m = await call('GET', '/metrics');
  assert.match(m.data, /http_requests_total\{method="GET",route="\/things\/:id",status_code="200"/);
  assert.doesNotMatch(m.data, /route="\/health"/, 'probes are not counted as traffic');
});
