'use strict';
// shelter (service 8): shelters, their contact details and admin approval.
// Publishes shelter.updated (create, edit, approval) so search and reporting can
// show shelter names and counts without calling this service.

const { http, db, events, errors, validate, start } = require('../../../libs/common');

const { need, requireRole } = errors;
const { str, isUuid, uuidParam, idList, EMAIL } = validate;
const app = http.createApp();

const view = (r) => r && ({
  id: r.id, name: r.name, district: r.district, address: r.address, phone: r.phone, email: r.email,
  about: r.about, status: r.status, createdAt: r.created_at, approvedAt: r.approved_at,
});

async function save(client, row) {
  await events.enqueue(client, 'shelter.updated', { shelter: view(row) });
  return view(row);
}

app.get('/shelters', async ({ user, query }) => {
  if (query.status === 'pending' || query.status === 'all') {
    requireRole(user, 'admin');
    const { rows } = await db.query(
      `SELECT * FROM shelters ${query.status === 'pending' ? "WHERE status = 'pending'" : ''}
        ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 500`);
    return rows.map(view);
  }
  const { rows } = await db.query("SELECT * FROM shelters WHERE status = 'approved' ORDER BY name LIMIT 500");
  return rows.map(view);
});

app.get('/shelters/:id', async ({ params }) => {
  const { rows } = await db.query('SELECT * FROM shelters WHERE id = $1', [uuidParam(params.id, 'shelter')]);
  need(rows[0], 404, 'Shelter not found.');
  return view(rows[0]);
});

app.put('/shelters/:id', async ({ user, params, body }) => {
  requireRole(user, 'staff');
  const id = uuidParam(params.id, 'shelter');
  need(user.shelterId === id, 403, 'You can only edit your own shelter.');
  const name = str(body.name, 120);
  need(name, 400, "Enter the shelter's name.");
  const email = str(body.email, 254).toLowerCase();
  need(!email || EMAIL.test(email), 400, 'Enter a valid email address.');
  const phone = str(body.phone, 30);
  need(!phone || /^[+0-9 ()-]{6,30}$/.test(phone), 400, 'Enter a valid phone number.');
  return db.withTx(async (c) => {
    const { rows } = await c.query(
      `UPDATE shelters SET name = $2, district = $3, address = $4, phone = $5, email = $6, about = $7, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, name, str(body.district, 60), str(body.address, 200), phone, email, str(body.about, 2000)]);
    need(rows[0], 404, 'Shelter not found.');
    return save(c, rows[0]);
  });
});

app.patch('/shelters/:id/approval', async ({ user, params, body }) => {
  requireRole(user, 'admin');
  const id = uuidParam(params.id, 'shelter');
  need(['approved', 'rejected'].includes(body.status), 400, 'Status must be approved or rejected.');
  return db.withTx(async (c) => {
    const { rows } = await c.query(
      `UPDATE shelters SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
              approved_by = $3, updated_at = now()
        WHERE id = $1 RETURNING *`, [id, body.status, user.id]);
    need(rows[0], 404, 'Shelter not found.');
    return save(c, rows[0]);
  });
});

/* ----------------------------------------------------------------- internal */

// Called by signup when a staff member registers. The shelter waits for an admin.
app.post('/internal/shelters', async ({ body }) => {
  const name = str(body.name, 120);
  need(name, 400, "Enter the shelter's name.");
  return db.withTx(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO shelters (name, district, email) VALUES ($1, $2, $3) RETURNING *',
      [name, str(body.district, 60), str(body.email, 254).toLowerCase()]);
    return http.created(await save(c, rows[0]));
  });
});

// Compensation when signup fails after creating the shelter. Only pending shelters can be removed.
app.delete('/internal/shelters/:id', async ({ params }) => {
  if (isUuid(params.id)) await db.query("DELETE FROM shelters WHERE id = $1 AND status = 'pending'", [params.id]);
  return http.noContent();
});

app.get('/internal/shelters', async ({ query }) => {
  const ids = idList(query.ids);
  if (!ids.length) return [];
  const { rows } = await db.query('SELECT * FROM shelters WHERE id = ANY($1)', [ids]);
  return rows.map(view);
});

start(app, { usesRedis: true, outbox: true });
