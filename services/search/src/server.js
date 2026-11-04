'use strict';
// search (service 7): finds and filters pets.
//
// search keeps its own read model, built only from events, so browsing never
// calls pet, adoption or shelter (this is what lets it scale independently and
// stay up when they are busy). Three tables are kept apart on purpose:
//   pet_index     <- pet.created / pet.updated / pet.deleted
//   pet_status    <- availability.changed (with a version, so late events never
//                    overwrite newer ones)
//   shelter_names <- shelter.updated
// Events from different streams can arrive in any order; joining at query time
// means the order does not matter.

const { http, db, events, errors, validate, start } = require('../../../libs/common');

const { need } = errors;
const { str, isUuid, oneOf } = validate;
const app = http.createApp();

async function upsertPet(client, pet) {
  await client.query(
    `INSERT INTO pet_index (pet_id, shelter_id, name, species, breed, sex, age_months, size, coat, description,
                            vaccinated, neutered, good_with, image_url, created_at, updated_at, search_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, lower($3 || ' ' || $5 || ' ' || $10))
     ON CONFLICT (pet_id) DO UPDATE SET
       shelter_id = EXCLUDED.shelter_id, name = EXCLUDED.name, species = EXCLUDED.species, breed = EXCLUDED.breed,
       sex = EXCLUDED.sex, age_months = EXCLUDED.age_months, size = EXCLUDED.size, coat = EXCLUDED.coat,
       description = EXCLUDED.description, vaccinated = EXCLUDED.vaccinated, neutered = EXCLUDED.neutered,
       good_with = EXCLUDED.good_with, image_url = EXCLUDED.image_url, updated_at = EXCLUDED.updated_at,
       search_text = EXCLUDED.search_text
     WHERE pet_index.updated_at <= EXCLUDED.updated_at`,
    [pet.id, pet.shelterId, pet.name, pet.species, pet.breed, pet.sex, pet.ageMonths, pet.size, pet.coat,
      pet.description, pet.vaccinated, pet.neutered, pet.goodWith, pet.imageUrl, pet.createdAt, pet.updatedAt || pet.createdAt]);
}

const consumers = [
  events.createConsumer({ stream: 'pet.created', handler: (e, c) => upsertPet(c, e.data.pet) }),
  events.createConsumer({ stream: 'pet.updated', handler: (e, c) => upsertPet(c, e.data.pet) }),
  events.createConsumer({ stream: 'pet.deleted', handler: (e, c) => c.query('DELETE FROM pet_index WHERE pet_id = $1', [e.data.petId]) }),
  events.createConsumer({
    stream: 'availability.changed',
    handler: (e, c) => c.query(
      `INSERT INTO pet_status (pet_id, status, version) VALUES ($1, $2, $3)
       ON CONFLICT (pet_id) DO UPDATE SET status = EXCLUDED.status, version = EXCLUDED.version
       WHERE pet_status.version < EXCLUDED.version`, [e.data.petId, e.data.status, e.data.version]),
  }),
  events.createConsumer({
    stream: 'shelter.updated',
    handler: (e, c) => c.query(
      `INSERT INTO shelter_names (shelter_id, name, status) VALUES ($1, $2, $3)
       ON CONFLICT (shelter_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
      [e.data.shelter.id, e.data.shelter.name, e.data.shelter.status]),
  }),
];

const view = (r) => ({
  id: r.pet_id, name: r.name, species: r.species, breed: r.breed, sex: r.sex, ageMonths: r.age_months,
  size: r.size, coat: r.coat, description: r.description, vaccinated: r.vaccinated, neutered: r.neutered,
  goodWith: r.good_with, imageUrl: r.image_url, shelterId: r.shelter_id, createdAt: r.created_at,
  status: r.status, shelterName: r.shelter_name || '',
});

const SORTS = {
  newest: 'p.created_at DESC',
  youngest: 'p.age_months ASC, p.created_at DESC',
  oldest: 'p.age_months DESC, p.created_at DESC',
  name: 'p.name ASC',
};

app.get('/search', async ({ query }) => {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  const q = str(query.q, 100).toLowerCase();
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const i = params.length;
    where.push(`(p.search_text LIKE $${i} OR lower(coalesce(s.name, '')) LIKE $${i})`);
  }
  if (query.species) add('p.species = ?', oneOf(query.species, ['dog', 'cat', 'rabbit', 'bird'], '-'));
  if (query.sex) add('p.sex = ?', oneOf(query.sex, ['male', 'female'], '-'));
  if (query.size) add('p.size = ?', oneOf(query.size, ['small', 'medium', 'large'], '-'));
  if (query.shelterId) { need(isUuid(query.shelterId), 400, 'Unknown shelter.'); add('p.shelter_id = ?', query.shelterId); }
  if (query.goodWith) add('? = ANY(p.good_with)', str(query.goodWith, 20));
  if (query.age === 'young') where.push('p.age_months < 12');
  if (query.age === 'adult') where.push('p.age_months >= 12 AND p.age_months < 84');
  if (query.age === 'senior') where.push('p.age_months >= 84');
  if (query.status !== 'all') add("coalesce(st.status, 'available') = ?", oneOf(query.status, ['available', 'pending', 'adopted'], 'available'));
  // Pets of a shelter that was later rejected are hidden from the public.
  where.push("coalesce(s.status, 'approved') = 'approved'");

  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 60, 1), 200);
  const sql = `
    SELECT p.*, coalesce(st.status, 'available') AS status, s.name AS shelter_name, count(*) OVER () AS total
      FROM pet_index p
      LEFT JOIN pet_status st ON st.pet_id = p.pet_id
      LEFT JOIN shelter_names s ON s.shelter_id = p.shelter_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${SORTS[query.sort] || SORTS.newest}
     LIMIT ${limit}`;
  const { rows } = await db.query(sql, params);
  return { total: rows.length ? Number(rows[0].total) : 0, items: rows.map(view) };
});

start(app, { consumers });
