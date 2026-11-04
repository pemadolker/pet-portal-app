'use strict';
// favorites (service 9): pets an adopter has saved. Consumes pet.deleted so a
// removed pet disappears from everyone's list.

const { http, db, events, errors, validate, start } = require('../../../libs/common');

const { need, requireUser } = errors;
const { isUuid, uuidParam } = validate;
const app = http.createApp();
const MAX_FAVORITES = 200;

const list = async (userId) =>
  (await db.query('SELECT pet_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows.map((r) => r.pet_id);

app.get('/favorites', async ({ user }) => {
  requireUser(user);
  return list(user.id);
});

app.post('/favorites', async ({ user, body }) => {
  requireUser(user);
  need(isUuid(body.petId), 400, 'Choose a pet to save.');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM favorites WHERE user_id = $1', [user.id]);
  need(rows[0].n < MAX_FAVORITES, 409, `You can save up to ${MAX_FAVORITES} pets.`);
  await db.query('INSERT INTO favorites (user_id, pet_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, body.petId.toLowerCase()]);
  return http.created(await list(user.id));
});

app.delete('/favorites/:petId', async ({ user, params }) => {
  requireUser(user);
  await db.query('DELETE FROM favorites WHERE user_id = $1 AND pet_id = $2', [user.id, uuidParam(params.petId, 'pet')]);
  return list(user.id);
});

const consumers = [
  events.createConsumer({ stream: 'pet.deleted', handler: (e, c) => c.query('DELETE FROM favorites WHERE pet_id = $1', [e.data.petId]) }),
];

start(app, { consumers });
