-- review schema
CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shelter_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  author_name text        NOT NULL,
  rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shelter_id, user_id)
);
CREATE INDEX reviews_shelter ON reviews (shelter_id, created_at DESC);
