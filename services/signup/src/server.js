'use strict';
// signup (service 3): creates accounts.
//
// An account touches three owners, so signup runs a small saga over internal calls:
//   1. shelter  POST /internal/shelters     (staff only; the shelter starts "pending")
//   2. login    POST /internal/credentials  (email + bcrypt hash; 409 if the email exists)
//   3. profile  POST /internal/profiles     (name, district)
// If a later step fails, the earlier ones are undone (compensation), so a failed
// signup never leaves half an account behind. Each attempt is recorded in
// signup.registrations for auditing.
//
// The first admin is created at start-up from BOOTSTRAP_ADMIN_EMAIL and
// BOOTSTRAP_ADMIN_PASSWORD (a Kubernetes Secret). There are no demo accounts.

const crypto = require('node:crypto');
const { http, db, client, errors, validate, logger, metrics, start, config } = require('../../../libs/common');

const { need, HttpError } = errors;
const { str, EMAIL } = validate;
const app = http.createApp();
const signups = metrics.counter('signups_total', 'Account sign-ups by role and result.', ['role', 'result']);

async function record(id, email, role, status, reason = null) {
  await db.query(
    `INSERT INTO registrations (id, email, role, status, failure_reason) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, failure_reason = EXCLUDED.failure_reason, updated_at = now()`,
    [id, email, role, status, reason],
  ).catch((err) => logger.warn({ err: err.message }, 'could not record registration'));
}

async function createAccount({ name, email, password, role, district, shelterName }, forward = {}) {
  const userId = crypto.randomUUID();
  const undo = [];
  await record(userId, email, role, 'started');
  try {
    let shelterId = null;
    if (role === 'staff') {
      const shelter = await client.post('shelter', '/internal/shelters', { name: shelterName, district, email }, { headers: forward });
      shelterId = shelter.id;
      undo.push(() => client.call('shelter', 'DELETE', `/internal/shelters/${shelterId}`, { headers: forward }));
    }
    await client.post('login', '/internal/credentials', { userId, email, password, role, shelterId }, { headers: forward, timeoutMs: 8000 });
    undo.push(() => client.call('login', 'DELETE', `/internal/credentials/${userId}`, { headers: forward }));
    await client.post('profile', '/internal/profiles', { userId, email, name, district }, { headers: forward });
    await record(userId, email, role, 'completed');
    signups.inc({ role, result: 'created' });
    return { id: userId, email, role, shelterId, name };
  } catch (err) {
    for (const fn of undo.reverse()) await fn().catch((e) => logger.error({ err: e.message, userId }, 'compensation step failed'));
    await record(userId, email, role, 'failed', err.message);
    signups.inc({ role, result: err.status === 409 ? 'duplicate' : 'failed' });
    throw err;
  }
}

app.post('/signup', async ({ body, forward }) => {
  const email = str(body.email, 254).toLowerCase();
  const name = str(body.name, 120);
  const password = String(body.password ?? '');
  const district = str(body.district, 60);
  const role = body.role === 'staff' ? 'staff' : 'adopter';
  need(name, 400, 'Enter your name.');
  need(EMAIL.test(email), 400, 'Enter a valid email address.');
  need(password.length >= 8, 400, 'Use a password of at least 8 characters.');
  need(password.length <= 128, 400, 'Use a password of at most 128 characters.');
  const shelterName = str(body.shelterName, 120);
  if (role === 'staff') need(shelterName, 400, "Enter your shelter's name.");
  const user = await createAccount({ name, email, password, role, district, shelterName }, forward);
  return http.created({ user });
});

// First admin account, created once from a Secret. Safe to run on every start.
async function bootstrapAdmin(attempt = 1) {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const password = config.secret('BOOTSTRAP_ADMIN_PASSWORD', '');
  if (password.length < 12) { logger.error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters; admin not created'); return; }
  try {
    await createAccount({ name: process.env.BOOTSTRAP_ADMIN_NAME || 'Portal administrator', email, password, role: 'admin', district: '' });
    logger.info({ email }, 'bootstrap admin created');
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) return logger.info({ email }, 'bootstrap admin already exists');
    const delay = Math.min(30, 2 ** attempt) * 1000;
    logger.warn({ err: err.message, retryInMs: delay }, 'bootstrap admin not created yet (login/profile not ready?), retrying');
    setTimeout(() => bootstrapAdmin(attempt + 1), delay).unref();
  }
}

start(app, { usesRedis: false, onStart: () => { bootstrapAdmin(); } });
