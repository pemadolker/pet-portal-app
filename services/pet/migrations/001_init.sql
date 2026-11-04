-- pet schema. Availability (available/pending/adopted) is NOT stored here: adoption owns it.
CREATE TABLE pets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shelter_id  uuid        NOT NULL,
  created_by  uuid        NOT NULL,
  name        text        NOT NULL,
  species     text        NOT NULL CHECK (species IN ('dog', 'cat', 'rabbit', 'bird')),
  breed       text        NOT NULL DEFAULT 'Mixed',
  sex         text        NOT NULL CHECK (sex IN ('male', 'female')),
  age_months  integer     NOT NULL CHECK (age_months BETWEEN 0 AND 359),
  size        text        NOT NULL DEFAULT 'medium' CHECK (size IN ('small', 'medium', 'large')),
  coat        text        NOT NULL DEFAULT '#8a6b4e',
  description text        NOT NULL,
  vaccinated  boolean     NOT NULL DEFAULT false,
  neutered    boolean     NOT NULL DEFAULT false,
  good_with   text[]      NOT NULL DEFAULT '{}',
  image_url   text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pets_shelter ON pets (shelter_id, created_at DESC);

CREATE TABLE outbox (
  id          uuid PRIMARY KEY,
  stream      text        NOT NULL,
  payload     jsonb       NOT NULL,
  traceparent text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX outbox_unsent ON outbox (created_at) WHERE sent_at IS NULL;
