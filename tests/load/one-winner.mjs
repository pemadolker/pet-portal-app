// Experiment E2 without k6: N adopters race for P pets at the same instant.
// Pass criterion: exactly P applications accepted (one per pet), everyone else 409 PET_TAKEN,
// no other status codes.
//
//   node tests/load/one-winner.mjs --base http://portal.local/api --users 2000 --pets 10
//
// Before running against the cluster, raise the gateway's live limits (no restart needed):
//   etcdctl put /pet-portal/prod/config/gateway/auth_rate_limit_per_minute 100000
//   etcdctl put /pet-portal/prod/config/gateway/rate_limit_per_minute 100000
// and put them back afterwards.

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg('base', process.env.BASE_URL || 'http://127.0.0.1:8080/api');
const USERS = Number(arg('users', 2000));
const PETS = Number(arg('pets', 10));
const ADMIN_EMAIL = arg('admin-email', process.env.ADMIN_EMAIL || 'admin@portal.local');
const ADMIN_PASSWORD = arg('admin-password', process.env.ADMIN_PASSWORD || 'change-me-admin-pw');
const run = `e2-${Date.now().toString(36)}`;

async function call(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const must = (r, status, what) => { if (r.status !== status) throw new Error(`${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

console.log(`setting up: 1 shelter, ${PETS} pets, ${USERS} adopters (run ${run})`);
const admin = must(await call('POST', '/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }), 200, 'admin login').token;
must(await call('POST', '/signup', { name: 'Load Staff', email: `${run}-staff@load.test`, password: 'load-test-pass', role: 'staff', shelterName: `Load shelter ${run}` }), 201, 'staff signup');
const staffLogin = must(await call('POST', '/login', { email: `${run}-staff@load.test`, password: 'load-test-pass' }), 200, 'staff login');
must(await call('PATCH', `/shelters/${staffLogin.user.shelterId}/approval`, { status: 'approved' }, admin), 200, 'approve');
const pets = [];
for (let p = 0; p < PETS; p++) {
  pets.push(must(await call('POST', '/pets', { name: `Race ${p}`, species: 'dog', sex: p % 2 ? 'male' : 'female', ageMonths: 12 + p, description: 'A pet created for the one-winner contention experiment.' }, staffLogin.token), 201, 'create pet').id);
}

const t0 = Date.now();
const tokens = await pool([...Array(USERS).keys()], 40, async (k) => {
  const email = `${run}-u${k}@load.test`;
  must(await call('POST', '/signup', { name: `Adopter ${k}`, email, password: 'load-test-pass' }), 201, `signup ${k}`);
  return must(await call('POST', '/login', { email, password: 'load-test-pass' }), 200, `login ${k}`).token;
});
console.log(`${USERS} adopters ready in ${((Date.now() - t0) / 1000).toFixed(1)} s; releasing all applications at once`);

const t1 = Date.now();
const results = await Promise.all(tokens.map((tok, k) => call('POST', '/adoptions', {
  petId: pets[k % PETS], homeType: 'house', hasYard: true, message: 'Contention test: I would like to adopt this pet please.',
}, tok)));
const ms = Date.now() - t1;

const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
const winners = results.filter((r) => r.status === 201).map((r) => r.data.petId);
const uniqueWinners = new Set(winners);
const taken = results.filter((r) => r.status === 409 && r.data?.code === 'PET_TAKEN').length;

const apps = must(await call('GET', '/adoptions/shelter', null, staffLogin.token), 200, 'shelter applications');
const perPet = {};
for (const a of apps) perPet[a.petId] = (perPet[a.petId] || 0) + 1;

console.log(JSON.stringify({ users: USERS, pets: PETS, burstMs: ms, byStatus, accepted: winners.length, distinctPetsWon: uniqueWinners.size, taken, applicationsStored: apps.length, maxApplicationsPerPet: Math.max(...Object.values(perPet)) }, null, 2));
const pass = winners.length === PETS && uniqueWinners.size === PETS && taken === USERS - PETS && apps.length === PETS && Math.max(...Object.values(perPet)) === 1;
console.log(pass ? 'E2 PASS: exactly one accepted application per pet, every other request got PET_TAKEN' : 'E2 FAIL');
process.exit(pass ? 0 : 1);
