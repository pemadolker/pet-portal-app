'use strict';
// notification (service 13): in-app messages, built from events.
// When an application is decided it stores a message for the adopter and, in the
// same transaction, queues an email on email.queue (through the outbox). The
// email-worker sends it. A slow mail server therefore never slows anyone down.

const { http, db, events, errors, validate, config, start } = require('../../../libs/common');

const { requireUser } = errors;
const { uuidParam } = validate;
const app = http.createApp();
const PUBLIC_URL = config.env('PUBLIC_URL', 'http://portal.local');

const view = (r) => ({ id: r.id, userId: r.user_id, title: r.title, body: r.body, link: r.link, read: r.read, createdAt: r.created_at });

app.get('/notifications', async ({ user }) => {
  requireUser(user);
  const { rows } = await db.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [user.id]);
  const unread = (await db.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT read', [user.id])).rows[0].n;
  return { unread, items: rows.map(view) };
});

app.post('/notifications/read-all', async ({ user }) => {
  requireUser(user);
  await db.query('UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read', [user.id]);
  return { unread: 0 };
});

app.post('/notifications/:id/read', async ({ user, params }) => {
  requireUser(user);
  const { rows } = await db.query('UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *', [uuidParam(params.id, 'notification'), user.id]);
  return rows[0] ? view(rows[0]) : null;
});

function messageFor(d) {
  if (d.decision === 'approved') {
    return {
      title: `Your application for ${d.petName} was approved`,
      body: d.note || `${d.shelterName || 'The shelter'} will contact you to arrange the handover.`,
    };
  }
  return {
    title: `Update on your application for ${d.petName}`,
    body: d.note || 'The shelter chose another home this time. Other pets are still waiting.',
  };
}

const consumers = [
  events.createConsumer({
    stream: 'application.decided',
    handler: async (e, c) => {
      const d = e.data;
      const { title, body } = messageFor(d);
      await c.query(
        'INSERT INTO notifications (user_id, title, body, link, source_event) VALUES ($1, $2, $3, $4, $5)',
        [d.userId, title, body, '#/applications', e.id]);
      if (d.userEmail) {
        await events.enqueue(c, 'email.queue', {
          to: d.userEmail,
          subject: title,
          text: `Hello${d.userName ? ` ${d.userName}` : ''},\n\n${body}\n\nSee your applications: ${PUBLIC_URL}/#/applications\n\nPet Adoption Portal`,
          sourceEvent: e.id,
        });
      }
    },
  }),
];

start(app, { outbox: true, consumers });
