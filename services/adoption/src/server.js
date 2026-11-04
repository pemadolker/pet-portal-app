'use strict';
// adoption (service 10): applications and pet availability. The hot path.
//
// THE ONE-WINNER RULE (proposal section 5, experiment E2). adoption alone owns
// each pet's availability (decision D3). Applying is one conditional UPDATE in
// one transaction:
//
//   UPDATE availability SET status = 'pending', application_id = $2, version = version + 1
//    WHERE pet_id = $1 AND status = 'available'
//
// PostgreSQL row locking serialises concurrent UPDATEs of the same row. The
// first one flips the status; every other one re-checks the WHERE clause after
// the first commits, finds 'pending', and changes 0 rows. 1 row = this adopter
// won, 0 rows = 409 PET_TAKEN. No distributed lock is needed, however many
// adoption pods KEDA has started.

const crypto = require('node:crypto');
const { http, db, events, client, errors, validate, metrics, start } = require('../../../libs/common');

const { need, fail, requireRole, requireUser } = errors;
const { str, bool, uuidParam, idList } = validate;
const app = http.createApp();

const attempts = metrics.counter('adoption_attempts_total', 'Adoption applications by result (accepted, taken, invalid).', ['result']);
const decisions = metrics.counter('adoption_decisions_total', 'Staff decisions on applications.', ['decision']);
const MAX_OPEN_PER_ADOPTER = 5;
const HOME_TYPES = ['house', 'apartment', 'farm', 'other'];

const appView = (r) => ({
  id: r.id, petId: r.pet_id, shelterId: r.shelter_id, userId: r.user_id, status: r.status, message: r.message,
  homeType: r.home_type, hasYard: r.has_yard, otherPets: r.other_pets, experience: r.experience,
  createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
});

const removedPet = (id) => ({ id, name: 'Removed pet', species: 'dog', breed: '', ageMonths: 0, sex: '', coat: '#8a6b4e', status: 'removed' });

async function approvedShelter(user, forward) {
  requireRole(user, 'staff');
  need(user.shelterId, 403, 'No shelter is linked to this account.');
  const s = await client.get('shelter', `/internal/shelters?ids=${user.shelterId}`, { headers: forward });
  need(s && s[0], 403, 'No shelter is linked to this account.');
  need(s[0].status === 'approved', 403, 'Your shelter is waiting for admin approval.');
  return s[0];
}

async function petsById(ids, forward) {
  if (!ids.length) return new Map();
  const [pets, avail] = await Promise.all([
    client.get('pet', `/internal/pets?ids=${ids.join(',')}`, { headers: forward }),
    db.query('SELECT pet_id, status FROM availability WHERE pet_id = ANY($1)', [ids]),
  ]);
  const status = new Map(avail.rows.map((r) => [r.pet_id, r.status]));
  return new Map((pets || []).map((p) => [p.id, { ...p, status: status.get(p.id) || 'available' }]));
}

/* ------------------------------------------------------------------ public */

app.get('/adoptions/availability/:petId', async ({ params }) => {
  const petId = uuidParam(params.petId, 'pet');
  const { rows } = await db.query('SELECT pet_id, status, application_id FROM availability WHERE pet_id = $1', [petId]);
  const r = rows[0];
  return r ? { petId: r.pet_id, status: r.status, applicationId: r.application_id } : { petId, status: 'available', applicationId: null };
});

app.post('/adoptions', async ({ user, body, forward, log }) => {
  requireRole(user, 'adopter');
  const petId = uuidParam(body.petId, 'pet');
  const message = str(body.message, 2000);
  if (message.length < 20) { attempts.inc({ result: 'invalid' }); fail(400, 'Tell the shelter a little more about your home (at least 20 characters).'); }
  const homeType = HOME_TYPES.includes(body.homeType) ? body.homeType : '';
  if (!homeType) { attempts.inc({ result: 'invalid' }); fail(400, 'Choose the type of home you live in.'); }

  // The availability row is created when adoption consumes pet.created. If someone
  // applies in the second before that event arrives, confirm the pet with pet and create it now.
  let av = (await db.query('SELECT status FROM availability WHERE pet_id = $1', [petId])).rows[0];
  if (!av) {
    const pets = await client.get('pet', `/internal/pets?ids=${petId}`, { headers: forward });
    need(pets && pets[0], 404, 'This pet is no longer listed.');
    await db.query(
      "INSERT INTO availability (pet_id, shelter_id, status) VALUES ($1, $2, 'available') ON CONFLICT DO NOTHING",
      [petId, pets[0].shelterId]);
    av = { status: 'available' };
  }
  need(av.status !== 'removed', 404, 'This pet is no longer listed.');

  const open = (await db.query("SELECT count(*)::int AS n FROM applications WHERE user_id = $1 AND status = 'submitted'", [user.id])).rows[0].n;
  if (open >= MAX_OPEN_PER_ADOPTER) { attempts.inc({ result: 'invalid' }); fail(409, `You already have ${open} applications waiting. Wait for a decision before applying again.`); }

  const id = crypto.randomUUID();
  const result = await db.withTx(async (c) => {
    // ---- THE ONE-WINNER RULE ----
    const won = await c.query(
      `UPDATE availability SET status = 'pending', application_id = $2, version = version + 1, updated_at = now()
        WHERE pet_id = $1 AND status = 'available'
        RETURNING shelter_id, version`, [petId, id]);
    if (won.rowCount === 0) return null; // someone else got there first
    const { shelter_id: shelterId, version } = won.rows[0];
    const { rows } = await c.query(
      `INSERT INTO applications (id, pet_id, shelter_id, user_id, message, home_type, has_yard, other_pets, experience)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, petId, shelterId, user.id, message, homeType, bool(body.hasYard), str(body.otherPets, 200), str(body.experience, 500)]);
    await events.enqueue(c, 'availability.changed', { petId, shelterId, status: 'pending', version, applicationId: id });
    await events.enqueue(c, 'application.submitted', { applicationId: id, petId, shelterId, userId: user.id, createdAt: rows[0].created_at });
    return appView(rows[0]);
  });

  if (!result) {
    attempts.inc({ result: 'taken' });
    log.info({ petId }, 'adoption lost the race: pet already taken');
    return http.respond(409, { error: 'Someone else has already applied for this pet.', code: 'PET_TAKEN' });
  }
  attempts.inc({ result: 'accepted' });
  return http.created(result);
});

app.get('/adoptions/mine', async ({ user, forward }) => {
  requireUser(user);
  const { rows } = await db.query('SELECT * FROM applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [user.id]);
  const pets = await petsById([...new Set(rows.map((r) => r.pet_id))], forward);
  const shelterIds = [...new Set(rows.map((r) => r.shelter_id))];
  const shelters = shelterIds.length ? await client.get('shelter', `/internal/shelters?ids=${shelterIds.join(',')}`, { headers: forward }).catch(() => []) : [];
  const names = new Map((shelters || []).map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...appView(r), pet: { ...(pets.get(r.pet_id) || removedPet(r.pet_id)), shelterName: names.get(r.shelter_id) || '' } }));
});

app.get('/adoptions/shelter', async ({ user, forward }) => {
  const shelter = await approvedShelter(user, forward);
  const { rows } = await db.query('SELECT * FROM applications WHERE shelter_id = $1 ORDER BY created_at DESC LIMIT 500', [shelter.id]);
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const [pets, profiles] = await Promise.all([
    petsById([...new Set(rows.map((r) => r.pet_id))], forward),
    userIds.length ? client.get('profile', `/internal/profiles?ids=${userIds.join(',')}`, { headers: forward }) : [],
  ]);
  const people = new Map((profiles || []).map((p) => [p.userId, p]));
  return rows.map((r) => {
    const p = people.get(r.user_id) || {};
    return { ...appView(r), pet: pets.get(r.pet_id) || removedPet(r.pet_id), applicant: { name: p.name || '', email: p.email || '', phone: p.phone || '' } };
  });
});

app.post('/adoptions/:id/decision', async ({ user, params, body, forward }) => {
  const shelter = await approvedShelter(user, forward);
  const id = uuidParam(params.id, 'application');
  need(['approved', 'rejected'].includes(body.decision), 400, 'Choose approve or reject.');
  const note = str(body.note, 500);

  const current = (await db.query('SELECT * FROM applications WHERE id = $1', [id])).rows[0];
  need(current, 404, 'Application not found.');
  need(current.shelter_id === shelter.id, 403, 'This application belongs to another shelter.');
  need(current.status === 'submitted', 409, 'This application has already been decided.');

  // Details for the notification email, fetched before the transaction so no lock is held during network calls.
  const [pets, profile] = await Promise.all([
    client.get('pet', `/internal/pets?ids=${current.pet_id}`, { headers: forward }).catch(() => []),
    client.get('profile', `/internal/profiles/${current.user_id}`, { headers: forward }),
  ]);
  const petName = pets?.[0]?.name || 'your pet';

  const decided = await db.withTx(async (c) => {
    const { rows } = await c.query(
      `UPDATE applications SET status = $2, decided_at = now(), decision_note = $3, decided_by = $4
        WHERE id = $1 AND status = 'submitted' RETURNING *`, [id, body.decision, note, user.id]);
    need(rows[0], 409, 'This application has already been decided.');
    const approved = body.decision === 'approved';
    const av = await c.query(
      `UPDATE availability SET status = $2, application_id = $3, version = version + 1, updated_at = now()
        WHERE pet_id = $1 AND application_id = $4 RETURNING version`,
      [current.pet_id, approved ? 'adopted' : 'available', approved ? id : null, id]);
    if (av.rowCount) {
      await events.enqueue(c, 'availability.changed', {
        petId: current.pet_id, shelterId: shelter.id, status: approved ? 'adopted' : 'available', version: av.rows[0].version, applicationId: approved ? id : null,
      });
    }
    await events.enqueue(c, 'application.decided', {
      applicationId: id, petId: current.pet_id, petName, shelterId: shelter.id, shelterName: shelter.name,
      userId: current.user_id, userEmail: profile?.email || '', userName: profile?.name || '',
      decision: body.decision, note, createdAt: rows[0].created_at, decidedAt: rows[0].decided_at,
    });
    return appView(rows[0]);
  });
  decisions.inc({ decision: body.decision });
  return decided;
});

/* ----------------------------------------------------------------- internal */

app.get('/internal/availability', async ({ query }) => {
  const ids = idList(query.petIds);
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT pet_id, status, application_id FROM availability WHERE pet_id = ANY($1)', [ids]);
  return rows.map((r) => ({ petId: r.pet_id, status: r.status, applicationId: r.application_id }));
});

/* ------------------------------------------------------------------ events */

const consumers = [
  events.createConsumer({
    stream: 'pet.created',
    handler: (e, c) => c.query(
      "INSERT INTO availability (pet_id, shelter_id, status) VALUES ($1, $2, 'available') ON CONFLICT DO NOTHING",
      [e.data.petId, e.data.shelterId]),
  }),
  events.createConsumer({
    stream: 'pet.deleted',
    handler: (e, c) => c.query(
      "UPDATE availability SET status = 'removed', version = version + 1, updated_at = now() WHERE pet_id = $1 AND status <> 'pending'",
      [e.data.petId]),
  }),
];

start(app, { outbox: true, consumers });
