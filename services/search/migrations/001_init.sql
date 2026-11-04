-- search schema: a read model built only from events. It can be dropped and
-- rebuilt at any time: delete the consumer groups and the service re-reads the streams.
CREATE TABLE pet_index (
  pet_id      uuid PRIMARY KEY,
  shelter_id  uuid        NOT NULL,
  name        text        NOT NULL,
  species     text        NOT NULL,
  breed       text        NOT NULL,
  sex         text        NOT NULL,
  age_months  integer     NOT NULL,
  size        text        NOT NULL,
  coat        text        NOT NULL,
  description text        NOT NULL,
  vaccinated  boolean     NOT NULL,
  neutered    boolean     NOT NULL,
  good_with   text[]      NOT NULL,
  image_url   text        NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  search_text text        NOT NULL
);
CREATE INDEX pet_index_shelter ON pet_index (shelter_id);
CREATE INDEX pet_index_created ON pet_index (created_at DESC);
CREATE INDEX pet_index_species ON pet_index (species);

CREATE TABLE pet_status (
  pet_id  uuid PRIMARY KEY,
  status  text    NOT NULL,
  version integer NOT NULL
);

CREATE TABLE shelter_names (
  shelter_id uuid PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL
);

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  stream       text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
