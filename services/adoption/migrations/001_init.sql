-- adoption schema. adoption is the single owner of each pet's availability (decision D3).
CREATE TABLE availability (
  pet_id         uuid PRIMARY KEY,
  shelter_id     uuid        NOT NULL,
  status         text        NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available', 'pending', 'adopted', 'removed')),
  application_id uuid,
  version        integer     NOT NULL DEFAULT 0,   -- bumps on every change; read models ignore older versions
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('pending', 'adopted') OR application_id IS NOT NULL)
);

CREATE TABLE applications (
  id            uuid PRIMARY KEY,
  pet_id        uuid        NOT NULL,
  shelter_id    uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  message       text        NOT NULL,
  home_type     text        NOT NULL,
  has_yard      boolean     NOT NULL DEFAULT false,
  other_pets    text        NOT NULL DEFAULT '',
  experience    text        NOT NULL DEFAULT '',
  decision_note text        NOT NULL DEFAULT '',
  decided_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX applications_user ON applications (user_id, created_at DESC);
CREATE INDEX applications_shelter ON applications (shelter_id, created_at DESC);
-- Belt and braces for the one-winner rule: the database itself refuses a second
-- open or approved application for the same pet, even if the code were wrong.
CREATE UNIQUE INDEX applications_one_active_per_pet ON applications (pet_id) WHERE status IN ('submitted', 'approved');

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
