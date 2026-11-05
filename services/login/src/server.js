'use strict';
// login (service 4): owns credentials and issues tokens.
//
//  * Passwords are stored as scrypt hashes (Node's built-in crypto, N=2^13, r=8, p=10,
//    16-byte random salt). That is one of OWASP's recommended scrypt settings and
//    needs only 8 MiB per hash, which matters inside a 192 MiB pod. Hashing is deliberately
//    CPU-heavy and runs on the libuv thread pool, which is why login scales on CPU.
//  * Access tokens are RS256 JWTs (1 h). login holds the private key; the gateway
//    only has the public key, so nothing else can mint tokens.
//  * Refresh tokens are random, stored as SHA-256 hashes, rotated on every use and
//    revoked on logout. Reusing an old refresh token revokes the whole family.
//  * Five wrong passwords lock the account for 15 minutes.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const jose = require('jose');
const { http, db, client, errors, validate, metrics, config, logger, start } = require('../../../libs/common');

const { need, fail } = errors;
const { str, isUuid, EMAIL } = validate;
const app = http.createApp();

const SCRYPT_N = 2 ** config.envInt('SCRYPT_LOG_N', 13);
const SCRYPT = { N: SCRYPT_N, r: 8, p: config.envInt('SCRYPT_P', 10), maxmem: 128 * SCRYPT_N * 8 * 2 };
const scrypt = promisify(crypto.scrypt);
const ACCESS_TTL = config.envInt('ACCESS_TOKEN_TTL_SECONDS', 3600);
const REFRESH_TTL_DAYS = config.envInt('REFRESH_TOKEN_TTL_DAYS', 14);
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const ISSUER = 'pet-portal-login';
const AUDIENCE = 'pet-portal';

const logins = metrics.counter('logins_total', 'Login attempts by result.', ['result']);
const hashSeconds = metrics.histogram('password_hash_seconds', 'Time spent hashing or verifying a password.', ['op'], [0.01, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6]);

let privateKey;
let keyId;
async function keys() {
  if (!privateKey) {
    const pem = config.secret('JWT_PRIVATE_KEY');
    privateKey = await jose.importPKCS8(pem, 'RS256');
    const pub = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    keyId = crypto.createHash('sha256').update(pub).digest('base64url').slice(0, 16);
  }
  return privateKey;
}

// scrypt runs on libuv's small thread pool (4 threads), which Node also uses for DNS
// lookups. Unlimited, a burst of sign-ups fills every thread, the lookup of "postgres"
// for a new database connection waits more than 5 s and the request fails with a 500.
// So at most SCRYPT_CONCURRENCY hashes run at once; the rest wait their turn in memory.
const HASH_SLOTS = config.envInt('SCRYPT_CONCURRENCY', 2);
let hashing = 0;
const waiting = [];
async function hashSlot(fn) {
  if (hashing >= HASH_SLOTS) await new Promise((resolve) => waiting.push(resolve));
  hashing++;
  try { return await fn(); } finally { hashing--; waiting.shift()?.(); }
}
const timed = async (op, fn) => { const end = hashSeconds.startTimer({ op }); try { return await hashSlot(fn); } finally { end(); } };
// Format: scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>, so parameters can be raised later
// without breaking existing hashes.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${Math.log2(SCRYPT.N)}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [alg, logN, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const N = 2 ** Number(logN);
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N, r: Number(r), p: Number(p), maxmem: 128 * N * Number(r) * 2 });
  return crypto.timingSafeEqual(key, expected);
}
// A real hash of a random string, so unknown emails take as long as wrong passwords.
let DUMMY_HASH;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function issueTokens(cred, family = crypto.randomUUID()) {
  const token = await new jose.SignJWT({ role: cred.role, shelter_id: cred.shelter_id || null })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setSubject(cred.user_id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .setJti(crypto.randomUUID())
    .sign(await keys());
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(refreshToken), cred.user_id, family, REFRESH_TTL_DAYS],
  );
  return { token, refreshToken, expiresIn: ACCESS_TTL };
}

async function publicUser(cred, forward) {
  let name = '';
  try {
    const p = await client.get('profile', `/internal/profiles/${cred.user_id}`, { headers: forward, timeoutMs: 1500 });
    name = p?.name || '';
  } catch { /* the name is only for display; login must not fail because profile is slow */ }
  return { id: cred.user_id, email: cred.email, role: cred.role, shelterId: cred.shelter_id, name };
}

app.post('/login', async ({ body, forward, log }) => {
  const email = str(body.email, 254).toLowerCase();
  const password = String(body.password ?? '');
  need(email && password, 400, 'Enter your email and password.');

  const { rows } = await db.query('SELECT * FROM credentials WHERE email = $1', [email]);
  const cred = rows[0];
  if (cred?.locked_until && new Date(cred.locked_until) > new Date()) {
    logins.inc({ result: 'locked' });
    fail(429, 'Too many failed attempts. Try again in a few minutes.');
  }
  DUMMY_HASH ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
  const ok = await timed('verify', () => verifyPassword(password, cred?.password_hash || DUMMY_HASH));
  if (!cred || !ok) {
    if (cred) {
      await db.query(
        `UPDATE credentials SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE user_id = $1`, [cred.user_id, MAX_FAILED, LOCK_MINUTES]);
    }
    logins.inc({ result: 'rejected' });
    log.info({ email: email.replace(/^(.).*@/, '$1***@') }, 'login rejected');
    fail(401, 'That email and password do not match.');
  }
  if (cred.failed_attempts > 0) await db.query('UPDATE credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1', [cred.user_id]);
  await db.query('UPDATE credentials SET last_login_at = now() WHERE user_id = $1', [cred.user_id]);
  logins.inc({ result: 'ok' });
  const tokens = await issueTokens(cred);
  return { ...tokens, user: await publicUser(cred, forward) };
});

app.post('/login/refresh', async ({ body, forward }) => {
  const presented = String(body.refreshToken || '');
  need(presented, 401, 'Your session has ended. Log in again.');
  const hash = sha256(presented);
  const out = await db.withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [hash]);
    const rt = rows[0];
    if (!rt) return null;
    if (rt.used_at || rt.revoked_at) {
      // Reuse of a rotated token: someone may have stolen it. End every session in this family.
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [rt.family_id]);
      return null;
    }
    if (new Date(rt.expires_at) < new Date()) return null;
    await c.query('UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1', [hash]);
    const cred = (await c.query('SELECT * FROM credentials WHERE user_id = $1', [rt.user_id])).rows[0];
    return cred ? { cred, family: rt.family_id } : null;
  });
  if (!out) { logins.inc({ result: 'refresh_rejected' }); fail(401, 'Your session has ended. Log in again.'); }
  logins.inc({ result: 'refreshed' });
  return { ...(await issueTokens(out.cred, out.family)), user: await publicUser(out.cred, forward) };
});

app.post('/login/logout', async ({ body }) => {
  const presented = String(body.refreshToken || '');
  if (presented) {
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
      [sha256(presented)]);
  }
  return http.noContent();
});

/* ------------------------------------------------- internal (signup only) */

app.post('/internal/credentials', async ({ body }) => {
  const userId = String(body.userId || '');
  const email = str(body.email, 254).toLowerCase();
  const password = String(body.password ?? '');
  need(isUuid(userId), 400, 'userId must be a UUID.');
  need(EMAIL.test(email), 400, 'Enter a valid email address.');
  need(password.length >= 8 && password.length <= 128, 400, 'Use a password of 8 to 128 characters.');
  need(['adopter', 'staff', 'admin'].includes(body.role), 400, 'Unknown role.');
  if (body.role === 'staff') need(isUuid(body.shelterId), 400, 'Staff accounts need a shelter.');
  const hash = await timed('hash', () => hashPassword(password));
  try {
    await db.query(
      'INSERT INTO credentials (user_id, email, password_hash, role, shelter_id) VALUES ($1, $2, $3, $4, $5)',
      [userId, email, hash, body.role, body.role === 'staff' ? body.shelterId : null]);
  } catch (err) {
    if (err.code === '23505') fail(409, 'An account with this email already exists. Log in instead.');
    throw err;
  }
  return http.created({ userId, email, role: body.role });
});

app.delete('/internal/credentials/:userId', async ({ params }) => {
  if (isUuid(params.userId)) await db.query('DELETE FROM credentials WHERE user_id = $1', [params.userId]);
  return http.noContent();
});

// Expired and used refresh tokens are cleaned up hourly.
setInterval(() => {
  db.query("DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'")
    .catch((err) => logger.warn({ err: err.message }, 'refresh token cleanup failed'));
}, 3600_000).unref();

keys().then(() => start(app, { usesRedis: false })).catch((err) => {
  logger.fatal({ err: err.message }, 'cannot load JWT signing key');
  process.exit(1);
});