'use strict';
// pet (service 6): the pet records that shelter staff list.
//
// pet does NOT own availability (decision D3): adoption does. When the website
// asks for a pet, pet adds the live status from adoption and the shelter name
// from shelter, so the page needs one call. Writes publish pet.created,
// pet.updated and pet.deleted through the outbox.

const { http, db, events, client, errors, validate, start } = require('../../../libs/common');

const { need, requireRole } = errors;
const { str, bool, uuidParam, idList, isUuid } = validate;
const app = http.createApp();

const SPECIES = ['dog', 'cat', 'rabbit', 'bird'];
const SIZES = ['small', 'medium', 'large'];
const GOOD_WITH = ['adults', 'children', 'dogs', 'cats'];

const view = (r) => r && ({
  id: r.id, name: r.name, species: r.species, breed: r.breed, sex: r.sex, ageMonths: r.age_months,
  size: r.size, coat: r.coat, description: r.description, vaccinated: r.vaccinated, neutered: r.neutered,
  goodWith: r.good_with, imageUrl: r.image_url, shelterId: r.shelter_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Adds status (from adoption) and shelterName (from shelter) for display.
async function enrich(pets, forward) {
  if (!pets.length) return pets;
  const ids = pets.map((p) => p.id);
  const shelterIds = [...new Set(pets.map((p) => p.shelterId))];
  const [avail, shelters] = await Promise.all([
    client.get('adoption', `/internal/availability?petIds=${ids.join(',')}`, { headers: forward }).catch(() => null),
    client.get('shelter', `/internal/shelters?ids=${shelterIds.join(',')}`, { headers: forward }).catch(() => []),
  ]);
  // No row yet means adoption has not consumed pet.created yet: the pet is new, so available.
  // If adoption could not be reached, say so rather than guess.
  const status = new Map((avail || []).map((a) => [a.petId, a.status]));
  const fallback = avail ? 'available' : 'unknown';
  const names = new Map((shelters || []).map((s) => [s.id, s.name]));
  return pets.map((p) => ({ ...p, status: status.get(p.id) || fallback, shelterName: names.get(p.shelterId) || '' }));
}

// Staff may only write when their shelter has been approved by an admin.
async function approvedShelter(user, forward) {
  requireRole(user, 'staff');
  need(user.shelterId, 403, 'No shelter is linked to this account.');
  const s = await client.get('shelter', `/internal/shelters?ids=${user.shelterId}`, { headers: forward });
  need(s && s[0], 403, 'No shelter is linked to this account.');
  need(s[0].status === 'approved', 403, 'Your shelter is waiting for admin approval.');
  return s[0];
}

function parsePet(b) {
  const name = str(b.name, 60);
  need(name, 400, "Enter the pet's name.");
  need(SPECIES.includes(b.species), 400, 'Choose a species.');
  const age = Number(b.ageMonths);
  need(Number.isInteger(age) && age >= 0 && age < 360, 400, 'Enter an age in months between 0 and 359.');
  need(['male', 'female'].includes(b.sex), 400, 'Choose male or female.');
  const description = str(b.description, 2000);
  need(description.length >= 20, 400, 'Write a description of at least 20 characters.');
  const coat = /^#[0-9a-fA-F]{6}$/.test(b.coat || '') ? b.coat : '#8a6b4e';
  const imageUrl = str(b.imageUrl, 500);
  need(!imageUrl || /^https:\/\/[^\s"'<>]+$/.test(imageUrl), 400, 'The photo link must start with https://');
  return {
    name, species: b.species, breed: str(b.breed, 80) || 'Mixed', sex: b.sex, age_months: age,
    size: SIZES.includes(b.size) ? b.size : 'medium', coat, description,
    vaccinated: bool(b.vaccinated), neutered: bool(b.neutered),
    good_with: Array.isArray(b.goodWith) ? [...new Set(b.goodWith.filter((g) => GOOD_WITH.includes(g)))] : [],
    image_url: imageUrl,
  };
}

app.get('/pets', async ({ query, forward }) => {
  const params = [];
  let where = '';
  if (query.shelterId) { need(isUuid(query.shelterId), 400, 'Unknown shelter.'); params.push(query.shelterId); where = 'WHERE shelter_id = $1'; }
  const { rows } = await db.query(`SELECT * FROM pets ${where} ORDER BY created_at DESC LIMIT 500`, params);
  return enrich(rows.map(view), forward);
});

app.get('/pets/:id', async ({ params, forward }) => {
  const { rows } = await db.query('SELECT * FROM pets WHERE id = $1', [uuidParam(params.id, 'pet')]);
  need(rows[0], 404, 'This pet is no longer listed.');
  return (await enrich([view(rows[0])], forward))[0];
});

app.post('/pets', async ({ user, body, forward }) => {
  const shelter = await approvedShelter(user, forward);
  const p = parsePet(body);
  const pet = await db.withTx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO pets (shelter_id, created_by, name, species, breed, sex, age_months, size, coat, description,
                         vaccinated, neutered, good_with, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [shelter.id, user.id, p.name, p.species, p.breed, p.sex, p.age_months, p.size, p.coat, p.description,
        p.vaccinated, p.neutered, p.good_with, p.image_url]);
    const v = view(rows[0]);
    await events.enqueue(c, 'pet.created', { petId: v.id, shelterId: v.shelterId, pet: v });
    return v;
  });
  return http.created({ ...pet, status: 'available', shelterName: shelter.name });
});

app.put('/pets/:id', async ({ user, params, body, forward }) => {
  const shelter = await approvedShelter(user, forward);
  const id = uuidParam(params.id, 'pet');
  const p = parsePet(body);
  const pet = await db.withTx(async (c) => {
    const cur = (await c.query('SELECT shelter_id FROM pets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    need(cur, 404, 'Pet not found.');
    need(cur.shelter_id === shelter.id, 403, "You can only edit your own shelter's pets.");
    const { rows } = await c.query(
      `UPDATE pets SET name = $2, species = $3, breed = $4, sex = $5, age_months = $6, size = $7, coat = $8,
              description = $9, vaccinated = $10, neutered = $11, good_with = $12, image_url = $13, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, p.name, p.species, p.breed, p.sex, p.age_months, p.size, p.coat, p.description, p.vaccinated, p.neutered, p.good_with, p.image_url]);
    const v = view(rows[0]);
    await events.enqueue(c, 'pet.updated', { petId: v.id, shelterId: v.shelterId, pet: v });
    return v;
  });
  return (await enrich([pet], forward))[0];
});

app.delete('/pets/:id', async ({ user, params, forward }) => {
  const shelter = await approvedShelter(user, forward);
  const id = uuidParam(params.id, 'pet');
  const avail = await client.get('adoption', `/internal/availability?petIds=${id}`, { headers: forward });
  need(avail?.[0]?.status !== 'pending', 409, 'Decide the open application before removing this pet.');
  await db.withTx(async (c) => {
    const cur = (await c.query('SELECT shelter_id FROM pets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    need(cur, 404, 'Pet not found.');
    need(cur.shelter_id === shelter.id, 403, "You can only remove your own shelter's pets.");
    await c.query('DELETE FROM pets WHERE id = $1', [id]);
    await events.enqueue(c, 'pet.deleted', { petId: id, shelterId: shelter.id });
  });
  return http.noContent();
});

/* ----------------------------------------------------------------- internal */

// Raw records (no status) for adoption, which owns status itself.
app.get('/internal/pets', async ({ query }) => {
  const ids = idList(query.ids);
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT * FROM pets WHERE id = ANY($1)', [ids]);
  return rows.map(view);
});

start(app, { usesRedis: true, outbox: true });
