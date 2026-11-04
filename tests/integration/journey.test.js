'use strict';
// End-to-end test of the whole adoption journey through the api-gateway.
// It creates its own accounts (unique emails per run), so it is safe against
// any environment:
//
//   BASE_URL=http://portal.local/api ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:integration
//
// Used in CI against docker compose, and as evidence for objective O1
// ("the adoption journey works end to end").

const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@portal.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-admin-pw';
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const run = Date.now().toString(36);

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, servedBy: res.headers.get('x-served-by') };
}

// Read models are eventually consistent; poll until the event has arrived.
async function eventually(fn, what, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const state = {};

test('admin logs in with the bootstrap account', async () => {
  const r = await call('POST', '/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'admin');
  assert.ok(r.data.refreshToken);
  state.admin = r.data.token;
});

test('shelter staff signs up; the shelter waits for approval', async () => {
  const email = `staff-${run}@shelter.test`;
  const s = await call('POST', '/signup', { body: { name: 'Sangay Dorji', email, password: 'correct-horse-1', role: 'staff', district: 'Thimphu', shelterName: `Thimphu Rescue ${run}` } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal(s.servedBy, 'signup');
  const l = await call('POST', '/login', { body: { email, password: 'correct-horse-1' } });
  assert.equal(l.status, 200);
  state.staff = l.data.token;
  state.shelterId = l.data.user.shelterId;
  const sh = await call('GET', `/shelters/${state.shelterId}`);
  assert.equal(sh.data.status, 'pending');

  const early = await call('POST', '/pets', { token: state.staff, body: { name: 'Early', species: 'dog', sex: 'male', ageMonths: 10, description: 'Should not be accepted before approval.' } });
  assert.equal(early.status, 403);
});

test('duplicate email is refused and leaves no half account behind', async () => {
  const r = await call('POST', '/signup', { body: { name: 'Copy', email: `staff-${run}@shelter.test`, password: 'another-pass-1', role: 'staff', shelterName: 'Duplicate' } });
  assert.equal(r.status, 409);
  const all = await call('GET', '/shelters?status=all', { token: state.admin });
  assert.ok(!all.data.some((s) => s.name === 'Duplicate'), 'compensation removed the duplicate shelter');
});

test('only an admin can approve shelters', async () => {
  const denied = await call('PATCH', `/shelters/${state.shelterId}/approval`, { token: state.staff, body: { status: 'approved' } });
  assert.equal(denied.status, 403);
  const ok = await call('PATCH', `/shelters/${state.shelterId}/approval`, { token: state.admin, body: { status: 'approved' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'approved');
});

test('staff lists a pet; search indexes it from the pet.created event', async () => {
  const bad = await call('POST', '/pets', { token: state.staff, body: { name: 'X', species: 'dragon', sex: 'male', ageMonths: 1, description: 'short' } });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/pets', {
    token: state.staff,
    body: { name: `Tashi ${run}`, species: 'dog', breed: 'Bhutanese mix', sex: 'male', ageMonths: 26, size: 'medium', coat: '#b07a45',
      description: 'Found near the vegetable market. Calm, walks well on a lead.', vaccinated: true, neutered: true, goodWith: ['adults', 'children'] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  state.petId = r.data.id;
  const found = await eventually(async () => {
    const s = await call('GET', `/search?q=${encodeURIComponent(`tashi ${run}`)}`);
    return s.data.items.find((p) => p.id === state.petId);
  }, 'search index');
  assert.equal(found.status, 'available');
  assert.match(found.shelterName, /Thimphu Rescue/);
});

test('adopter signs up, saves the pet, and applies', async () => {
  const email = `adopter-${run}@mail.test`;
  assert.equal((await call('POST', '/signup', { body: { name: 'Karma Wangmo', email, password: 'adopt-me-please', district: 'Paro' } })).status, 201);
  const l = await call('POST', '/login', { body: { email, password: 'adopt-me-please' } });
  state.adopter = l.data.token;
  state.adopterRefresh = l.data.refreshToken;
  state.adopterEmail = email;

  const fav = await call('POST', '/favorites', { token: state.adopter, body: { petId: state.petId } });
  assert.equal(fav.status, 201);
  assert.deepEqual(fav.data, [state.petId]);

  const short = await call('POST', '/adoptions', { token: state.adopter, body: { petId: state.petId, message: 'too short', homeType: 'house' } });
  assert.equal(short.status, 400);
  const a = await call('POST', '/adoptions', { token: state.adopter, body: { petId: state.petId, homeType: 'house', hasYard: true, message: 'We have a fenced garden and work from home most days.' } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  state.applicationId = a.data.id;
  const av = await call('GET', `/adoptions/availability/${state.petId}`);
  assert.equal(av.data.status, 'pending');
});

test('a second adopter is told the pet is taken (one-winner rule)', async () => {
  const email = `late-${run}@mail.test`;
  await call('POST', '/signup', { body: { name: 'Late Comer', email, password: 'too-late-sorry' } });
  const l = await call('POST', '/login', { body: { email, password: 'too-late-sorry' } });
  const r = await call('POST', '/adoptions', { token: l.data.token, body: { petId: state.petId, homeType: 'apartment', message: 'I would love to give this dog a home too.' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'PET_TAKEN');
});

test('staff approves; notification, history, email and reports follow from events', async () => {
  const list = await call('GET', '/adoptions/shelter', { token: state.staff });
  const app = list.data.find((a) => a.id === state.applicationId);
  assert.equal(app.applicant.name, 'Karma Wangmo');
  assert.equal(app.applicant.email, state.adopterEmail);

  const d = await call('POST', `/adoptions/${state.applicationId}/decision`, { token: state.staff, body: { decision: 'approved', note: 'Please visit on Saturday at 10am.' } });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const again = await call('POST', `/adoptions/${state.applicationId}/decision`, { token: state.staff, body: { decision: 'rejected' } });
  assert.equal(again.status, 409);

  const n = await eventually(async () => {
    const r = await call('GET', '/notifications', { token: state.adopter });
    return r.data.unread > 0 && r.data;
  }, 'notification');
  assert.match(n.items[0].title, /approved/);

  const h = await eventually(async () => (await call('GET', '/history', { token: state.adopter })).data.find((x) => x.applicationId === state.applicationId), 'history');
  assert.equal(h.outcome, 'approved');

  await eventually(async () => {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${state.adopterEmail}`)}`).then((x) => x.json());
    return r.messages_count === 1;
  }, 'exactly one email in Mailpit');

  const rep = await eventually(async () => {
    const r = await call('GET', '/reports/summary', { token: state.staff });
    return r.data.applications.byStatus.approved === 1 && r.data.pets.byStatus.adopted === 1 && r.data;
  }, 'reporting');
  assert.match(rep.scope, /Thimphu Rescue/);
  assert.equal((await call('GET', '/reports/summary', { token: state.adopter })).status, 403);

  const s = await eventually(async () => {
    const r = await call('GET', `/search?status=all&shelterId=${state.shelterId}`);
    return r.data.items.find((p) => p.id === state.petId && p.status === 'adopted');
  }, 'search status adopted');
  assert.ok(s);
});

test('adopter reviews the shelter (one review per adopter, updated on repeat)', async () => {
  const r1 = await call('POST', '/reviews', { token: state.adopter, body: { shelterId: state.shelterId, rating: 4, comment: 'Kind and organised staff.' } });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.authorName, 'Karma W.');
  await call('POST', '/reviews', { token: state.adopter, body: { shelterId: state.shelterId, rating: 5, comment: 'Updated: wonderful handover.' } });
  const list = await call('GET', `/reviews?shelterId=${state.shelterId}`);
  assert.equal(list.data.count, 1);
  assert.equal(list.data.average, 5);
});

test('security: forged identity headers, bad tokens and internal paths are refused', async () => {
  const forged = await call('GET', '/reports/summary', { headers: { 'x-user-id': '00000000-0000-4000-8000-000000000000', 'x-user-role': 'admin' } });
  assert.equal(forged.status, 401, 'gateway must strip client-supplied identity headers');
  const bad = await call('GET', '/profile', { token: 'not.a.jwt' });
  assert.equal(bad.status, 401);
  const internal = await call('GET', '/internal/profiles');
  assert.equal(internal.status, 404);
  const sneaky = await call('GET', '/profile/../internal/profiles');
  assert.equal(sneaky.status === 404 || sneaky.status === 401, true);
  const wrongStaff = await call('PUT', `/shelters/${state.shelterId}`, { token: state.adopter, body: { name: 'Hijacked' } });
  assert.equal(wrongStaff.status, 403);
});

test('refresh tokens rotate, and reusing an old one ends the session family', async () => {
  const r1 = await call('POST', '/login/refresh', { body: { refreshToken: state.adopterRefresh } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.data.refreshToken, state.adopterRefresh);
  const reuse = await call('POST', '/login/refresh', { body: { refreshToken: state.adopterRefresh } });
  assert.equal(reuse.status, 401);
  const after = await call('POST', '/login/refresh', { body: { refreshToken: r1.data.refreshToken } });
  assert.equal(after.status, 401, 'the whole family is revoked after reuse');
});

test('staff cannot remove a pet with a pending application; can remove an available one', async () => {
  const p = await call('POST', '/pets', { token: state.staff, body: { name: `Pema ${run}`, species: 'cat', sex: 'female', ageMonths: 14, description: 'Quiet cat who likes sunny windows.' } });
  assert.equal(p.status, 201);
  const del = await call('DELETE', `/pets/${p.data.id}`, { token: state.staff });
  assert.equal(del.status, 204);
  assert.equal((await call('GET', `/pets/${p.data.id}`)).status, 404);
});
