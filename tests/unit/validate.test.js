'use strict';
process.env.SERVICE_NAME = 'unit';
const test = require('node:test');
const assert = require('node:assert/strict');
const { str, bool, isUuid, idList, oneOf, uuidParam, EMAIL } = require('../../libs/common/validate');
const { HttpError } = require('../../libs/common/errors');

test('str trims and limits length', () => {
  assert.equal(str('  hello  '), 'hello');
  assert.equal(str('x'.repeat(600)).length, 500);
  assert.equal(str(null), '');
});

test('bool accepts form and JSON values', () => {
  for (const v of [true, 'true', 'on', 1, '1']) assert.equal(bool(v), true);
  for (const v of [false, 'false', '', 0, undefined]) assert.equal(bool(v), false);
});

test('uuid checks', () => {
  assert.ok(isUuid('7d7c9d3e-3f5b-4f62-9a3e-1b7a3e8c9d10'));
  assert.ok(!isUuid("1' OR '1'='1"));
  assert.throws(() => uuidParam('pet-tashi', 'pet'), (e) => e instanceof HttpError && e.status === 404);
});

test('idList drops junk, de-duplicates and caps the count', () => {
  const a = '7d7c9d3e-3f5b-4f62-9a3e-1b7a3e8c9d10';
  assert.deepEqual(idList(`${a},${a.toUpperCase()},nope,`), [a]);
  const many = Array.from({ length: 201 }, (_, i) => `7d7c9d3e-3f5b-4f62-9a3e-${String(i).padStart(12, '0')}`).join(',');
  assert.throws(() => idList(many), (e) => e.status === 400);
});

test('oneOf and EMAIL', () => {
  assert.equal(oneOf('dog', ['dog', 'cat'], '-'), 'dog');
  assert.equal(oneOf('dragon', ['dog', 'cat'], '-'), '-');
  assert.ok(EMAIL.test('karma@mail.bt'));
  assert.ok(!EMAIL.test('karma@mail'));
  assert.ok(!EMAIL.test('a b@c.de'));
});
