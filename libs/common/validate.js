'use strict';
// Small input helpers. Every value from a request is treated as untrusted:
// trimmed, length-limited and type-checked before it reaches SQL (which is
// always parameterised) or another service.

const { need } = require('./errors');

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;

function uuidParam(v, what = 'item') {
  need(isUuid(v), 404, `That ${what} was not found.`);
  return v.toLowerCase();
}

function idList(v, max = 200) {
  const ids = String(v || '').split(',').map((s) => s.trim()).filter(isUuid);
  need(ids.length <= max, 400, `At most ${max} ids per request.`);
  return [...new Set(ids.map((s) => s.toLowerCase()))];
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

module.exports = { str, bool, isUuid, uuidParam, idList, oneOf, EMAIL };
