-- notification schema
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL,
  title        text        NOT NULL,
  body         text        NOT NULL,
  link         text        NOT NULL DEFAULT '',
  read         boolean     NOT NULL DEFAULT false,
  source_event uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE NOT read;

CREATE TABLE outbox (
  id          uuid PRIMARY KEY,
  stream      text        NOT NULL,
  payload     jsonb       NOT NULL,
  traceparent text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX outbox_unsent ON outbox (created_at) WHERE sent_at IS NULL;

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  stream       text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
