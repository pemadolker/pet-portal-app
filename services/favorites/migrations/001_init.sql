-- favorites schema
CREATE TABLE favorites (
  user_id    uuid        NOT NULL,
  pet_id     uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pet_id)
);
CREATE INDEX favorites_pet ON favorites (pet_id);

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  stream       text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
