'use strict';
// profile (service 5): personal details for adopters, staff and admins.
// Other services read names, emails and phone numbers through /internal routes
// (adoption shows staff who applied; review shows the author's name).

const { http, db, errors, validate, start } = require('../../../libs/common');

const { need, requireUser } = errors;
const { str, bool, isUuid, idList, EMAIL } = validate;
const app = http.createApp();

const HOME_TYPES = ['', 'house', 'apartment', 'farm', 'other'];

const view = (r) => r && ({
  userId: r.user_id, name: r.name, email: r.email, phone: r.phone, district: r.district,
  homeType: r.home_type, hasYard: r.has_yard, otherPets: r.other_pets, about: r.about,
});

app.get('/profile', async ({ user }) => {
  requireUser(user);
  const { rows } = await db.query('SELECT * FROM profiles WHERE user_id = $1', [user.id]);
  need(rows[0], 404, 'Your profile was not found.');
  return { ...view(rows[0]), role: user.role };
});

app.put('/profile', async ({ user, body }) => {
  requireUser(user);
  const name = str(body.name, 120);
  need(name, 400, 'Enter your name.');
  const phone = str(body.phone, 30);
  need(!phone || /^[+0-9 ()-]{6,30}$/.test(phone), 400, 'Enter a valid phone number.');
  const homeType = HOME_TYPES.includes(body.homeType) ? body.homeType : '';
  const { rows } = await db.query(
    `UPDATE profiles SET name = $2, phone = $3, district = $4, home_type = $5, has_yard = $6,
            other_pets = $7, about = $8, updated_at = now()
      WHERE user_id = $1 RETURNING *`,
    [user.id, name, phone, str(body.district, 60), homeType, bool(body.hasYard), str(body.otherPets, 200), str(body.about, 1000)]);
  need(rows[0], 404, 'Your profile was not found.');
  return { ...view(rows[0]), role: user.role };
});

/* ----------------------------------------------------------------- internal */

app.post('/internal/profiles', async ({ body }) => {
  need(isUuid(body.userId), 400, 'userId must be a UUID.');
  const email = str(body.email, 254).toLowerCase();
  need(EMAIL.test(email), 400, 'A valid email is required.');
  const { rows } = await db.query(
    `INSERT INTO profiles (user_id, email, name, district) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email RETURNING *`,
    [body.userId, email, str(body.name, 120), str(body.district, 60)]);
  return http.created(view(rows[0]));
});

app.get('/internal/profiles/:userId', async ({ params }) => {
  need(isUuid(params.userId), 404, 'Profile not found.');
  const { rows } = await db.query('SELECT * FROM profiles WHERE user_id = $1', [params.userId]);
  need(rows[0], 404, 'Profile not found.');
  return view(rows[0]);
});

app.get('/internal/profiles', async ({ query }) => {
  const ids = idList(query.ids);
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT * FROM profiles WHERE user_id = ANY($1)', [ids]);
  return rows.map(view);
});

start(app, { usesRedis: false });
