'use strict';
// review (service 11): shelter reviews and ratings. One review per adopter per
// shelter; posting again updates the adopter's existing review.

const { http, db, client, errors, validate, start } = require('../../../libs/common');

const { need, requireRole } = errors;
const { str, isUuid } = validate;
const app = http.createApp();

const view = (r) => ({
  id: r.id, shelterId: r.shelter_id, userId: r.user_id, authorName: r.author_name,
  rating: r.rating, comment: r.comment, createdAt: r.created_at, updatedAt: r.updated_at,
});

// "Karma Wangmo" -> "Karma W." so full names are not published.
const shortName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Adopter';
  return parts[0] + (parts[1] ? ` ${parts[1][0]}.` : '');
};

app.get('/reviews', async ({ query }) => {
  const params = [];
  let where = '';
  if (query.shelterId) { need(isUuid(query.shelterId), 400, 'Unknown shelter.'); params.push(query.shelterId); where = 'WHERE shelter_id = $1'; }
  const [items, stats] = await Promise.all([
    db.query(`SELECT * FROM reviews ${where} ORDER BY created_at DESC LIMIT 100`, params),
    db.query(`SELECT count(*)::int AS count, coalesce(avg(rating), 0)::float AS average FROM reviews ${where}`, params),
  ]);
  return {
    average: Math.round(stats.rows[0].average * 10) / 10,
    count: stats.rows[0].count,
    items: items.rows.map(view),
  };
});

app.post('/reviews', async ({ user, body, forward }) => {
  requireRole(user, 'adopter');
  need(isUuid(body.shelterId), 404, 'Shelter not found.');
  const rating = Number(body.rating);
  need(Number.isInteger(rating) && rating >= 1 && rating <= 5, 400, 'Choose a rating from 1 to 5 stars.');
  const comment = str(body.comment, 1000);
  need(comment.length >= 5, 400, 'Write a short comment.');
  const [shelters, profile] = await Promise.all([
    client.get('shelter', `/internal/shelters?ids=${body.shelterId}`, { headers: forward }),
    client.get('profile', `/internal/profiles/${user.id}`, { headers: forward }),
  ]);
  need(shelters?.[0] && shelters[0].status === 'approved', 404, 'Shelter not found.');
  const { rows } = await db.query(
    `INSERT INTO reviews (shelter_id, user_id, author_name, rating, comment) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (shelter_id, user_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, author_name = EXCLUDED.author_name, updated_at = now()
     RETURNING *`,
    [body.shelterId.toLowerCase(), user.id, shortName(profile?.name), rating, comment]);
  return http.created(view(rows[0]));
});

start(app, { usesRedis: false });
