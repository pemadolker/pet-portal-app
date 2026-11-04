'use strict';
// history (service 12): an adopter's past applications and their outcomes.
// Built only from application.decided events (eventual consistency, decision D6).

const { http, db, events, errors, start } = require('../../../libs/common');

const { requireUser } = errors;
const app = http.createApp();

app.get('/history', async ({ user }) => {
  requireUser(user);
  const { rows } = await db.query('SELECT * FROM entries WHERE user_id = $1 ORDER BY decided_at DESC LIMIT 200', [user.id]);
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, applicationId: r.application_id, petId: r.pet_id, petName: r.pet_name,
    shelterId: r.shelter_id, shelterName: r.shelter_name, outcome: r.outcome, at: r.decided_at,
  }));
});

const consumers = [
  events.createConsumer({
    stream: 'application.decided',
    handler: (e, c) => c.query(
      `INSERT INTO entries (user_id, application_id, pet_id, pet_name, shelter_id, shelter_name, outcome, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (application_id) DO NOTHING`,
      [e.data.userId, e.data.applicationId, e.data.petId, e.data.petName, e.data.shelterId, e.data.shelterName || '',
        e.data.decision, e.data.decidedAt || e.occurredAt]),
  }),
];

start(app, { consumers });
