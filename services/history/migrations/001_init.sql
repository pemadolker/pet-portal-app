-- history schema: one row per decided application, from application.decided events.
CREATE TABLE entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL,
  application_id uuid        NOT NULL UNIQUE,
  pet_id         uuid        NOT NULL,
  pet_name       text        NOT NULL,
  shelter_id     uuid        NOT NULL,
  shelter_name   text        NOT NULL DEFAULT '',
  outcome        text        NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  decided_at     timestamptz NOT NULL
);
CREATE INDEX entries_user ON entries (user_id, decided_at DESC);

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  stream       text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
