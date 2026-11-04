'use strict';
// email-worker (service 14): sends the emails queued on email.queue.
//
// No database: it remembers sent event ids in Redis for 7 days so a re-delivered
// message is not sent twice. A failed send is left un-acknowledged; another pod
// (or this one) claims it again after 30 s, and after 5 attempts it goes to
// email.queue.dlq. Each pod is limited to SMTP_RATE_PER_SECOND sends, as real
// mail providers rate-limit senders. That limit is why a burst of emails builds
// a backlog, and KEDA adds pods when the backlog per pod passes 20 (E4).
//
// Only /health, /ready and /metrics are served. In the cluster, emails go to
// Mailpit, which catches them so no real address is ever contacted.

const nodemailer = require('nodemailer');
const { http, events, config, metrics, logger, start } = require('../../../libs/common');

const app = http.createApp();
const RATE = Math.max(1, config.envInt('SMTP_RATE_PER_SECOND', 5));
const FROM = config.env('MAIL_FROM', 'Pet Adoption Portal <no-reply@portal.local>');

const sent = metrics.counter('emails_sent_total', 'Emails handed to the SMTP server, by result.', ['result']);
const sendSeconds = metrics.histogram('email_send_seconds', 'Time to hand one email to the SMTP server.', [], [0.05, 0.1, 0.2, 0.5, 1, 2, 5]);

const transport = nodemailer.createTransport({
  host: config.env('SMTP_HOST', 'localhost'),
  port: config.envInt('SMTP_PORT', 1025),
  secure: config.envBool('SMTP_TLS', false),
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: config.secret('SMTP_PASSWORD', '') } : undefined,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

let nextSlot = 0;
async function rateLimit() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1000 / RATE;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function send(e) {
  const m = e.data;
  if (!m?.to || !m?.subject) { logger.warn({ eventId: e.id }, 'email without recipient or subject, skipping'); return; }
  await rateLimit();
  const end = sendSeconds.startTimer();
  try {
    const info = await transport.sendMail({ from: FROM, to: m.to, subject: m.subject, text: m.text || '', headers: { 'X-Event-Id': e.id } });
    sent.inc({ result: 'sent' });
    logger.info({ eventId: e.id, messageId: info.messageId }, 'email sent');
    await events.publishDirect('email.sent', { eventId: e.id, to: m.to, subject: m.subject });
  } catch (err) {
    sent.inc({ result: 'failed' });
    throw err;
  } finally {
    end();
  }
}

const consumers = [events.createConsumer({ stream: 'email.queue', group: 'email-worker', handler: send, idempotency: 'redis', batch: RATE })];

// Readiness only checks Redis (added by start). If the mail server is down, sends fail and
// are retried from the stream, which is the behaviour we want, so it is not a readiness check.
start(app, { usesDb: false, consumers });
