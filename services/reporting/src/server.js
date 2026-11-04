'use strict';
// reporting (service 15): summaries for shelter staff and the admin.
// A read model built only from events (pets, availability, applications,
// shelters, emails sent), so producing a report never loads the services that
// handle live traffic.

const { http, db, events, errors, start } = require('../../../libs/common');

const { requireRole } = errors;
const app = http.createApp();

const consumers = [
  events.createConsumer({
    stream: 'pet.created',
    handler: (e, c) => c.query(
      `INSERT INTO pet_facts (pet_id, shelter_id, species) VALUES ($1, $2, $3)
       ON CONFLICT (pet_id) DO UPDATE SET shelter_id = EXCLUDED.shelter_id, species = EXCLUDED.species, removed = false`,
      [e.data.petId, e.data.shelterId, e.data.pet.species]),
  }),
  events.createConsumer({
    stream: 'pet.updated',
    handler: (e, c) => c.query(
      `INSERT INTO pet_facts (pet_id, shelter_id, species) VALUES ($1, $2, $3)
       ON CONFLICT (pet_id) DO UPDATE SET species = EXCLUDED.species`,
      [e.data.petId, e.data.shelterId, e.data.pet.species]),
  }),
  events.createConsumer({
    stream: 'pet.deleted',
    handler: (e, c) => c.query('UPDATE pet_facts SET removed = true WHERE pet_id = $1', [e.data.petId]),
  }),
  events.createConsumer({
    stream: 'availability.changed',
    handler: (e, c) => c.query(
      `INSERT INTO pet_status (pet_id, status, version) VALUES ($1, $2, $3)
       ON CONFLICT (pet_id) DO UPDATE SET status = EXCLUDED.status, version = EXCLUDED.version
       WHERE pet_status.version < EXCLUDED.version`, [e.data.petId, e.data.status, e.data.version]),
  }),
  events.createConsumer({
    stream: 'application.submitted',
    handler: (e, c) => c.query(
      `INSERT INTO application_facts (application_id, shelter_id, status, created_at) VALUES ($1, $2, 'submitted', $3)
       ON CONFLICT (application_id) DO NOTHING`, [e.data.applicationId, e.data.shelterId, e.data.createdAt]),
  }),
  events.createConsumer({
    stream: 'application.decided',
    handler: (e, c) => c.query(
      `INSERT INTO application_facts (application_id, shelter_id, status, created_at, decided_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (application_id) DO UPDATE SET status = EXCLUDED.status, decided_at = EXCLUDED.decided_at`,
      [e.data.applicationId, e.data.shelterId, e.data.decision, e.data.createdAt, e.data.decidedAt]),
  }),
  events.createConsumer({
    stream: 'shelter.updated',
    handler: (e, c) => c.query(
      `INSERT INTO shelter_facts (shelter_id, name, status) VALUES ($1, $2, $3)
       ON CONFLICT (shelter_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
      [e.data.shelter.id, e.data.shelter.name, e.data.shelter.status]),
  }),
  events.createConsumer({
    stream: 'email.sent',
    handler: (e, c) => c.query('UPDATE counters SET value = value + 1 WHERE name = $1', ['emails_sent']),
  }),
];

const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.k, r.n]));

app.get('/reports/summary', async ({ user }) => {
  requireRole(user, 'staff', 'admin');
  const shelterId = user.role === 'staff' ? user.shelterId : null;
  const scopeSql = shelterId ? 'AND p.shelter_id = $1' : '';
  const appScope = shelterId ? 'WHERE shelter_id = $1' : '';
  const params = shelterId ? [shelterId] : [];

  const [byStatus, bySpecies, apps, avgDays, shelters, emails, scope] = await Promise.all([
    db.query(`SELECT coalesce(s.status, 'available') AS k, count(*)::int AS n
                FROM pet_facts p LEFT JOIN pet_status s USING (pet_id)
               WHERE NOT p.removed ${scopeSql} GROUP BY 1`, params),
    db.query(`SELECT p.species AS k, count(*)::int AS n FROM pet_facts p WHERE NOT p.removed ${scopeSql} GROUP BY 1`, params),
    db.query(`SELECT status AS k, count(*)::int AS n FROM application_facts ${appScope} GROUP BY 1`, params),
    db.query(`SELECT coalesce(avg(extract(epoch FROM decided_at - created_at)) / 86400, 0)::float AS d
                FROM application_facts ${appScope ? `${appScope} AND` : 'WHERE'} decided_at IS NOT NULL`, params),
    shelterId ? null : db.query('SELECT status AS k, count(*)::int AS n FROM shelter_facts GROUP BY 1'),
    db.query("SELECT value FROM counters WHERE name = 'emails_sent'"),
    shelterId ? db.query('SELECT name FROM shelter_facts WHERE shelter_id = $1', [shelterId]) : null,
  ]);
  const petStatus = toMap(byStatus.rows);
  const appStatus = toMap(apps.rows);
  return {
    scope: shelterId ? (scope.rows[0]?.name || 'Your shelter') : 'All shelters',
    pets: { total: Object.values(petStatus).reduce((a, b) => a + b, 0), byStatus: petStatus, bySpecies: toMap(bySpecies.rows) },
    applications: {
      total: Object.values(appStatus).reduce((a, b) => a + b, 0),
      byStatus: appStatus,
      averageDecisionDays: Math.round(avgDays.rows[0].d * 10) / 10,
    },
    shelters: shelters ? toMap(shelters.rows) : undefined,
    emailsSent: Number(emails.rows[0]?.value || 0),
  };
});

start(app, { consumers });
