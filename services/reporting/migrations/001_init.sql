-- reporting schema: read model built from events.
CREATE TABLE pet_facts (
  pet_id     uuid PRIMARY KEY,
  shelter_id uuid    NOT NULL,
  species    text    NOT NULL,
  removed    boolean NOT NULL DEFAULT false
);
CREATE INDEX pet_facts_shelter ON pet_facts (shelter_id);

CREATE TABLE pet_status (
  pet_id  uuid PRIMARY KEY,
  status  text    NOT NULL,
  version integer NOT NULL
);

CREATE TABLE application_facts (
  application_id uuid PRIMARY KEY,
  shelter_id     uuid        NOT NULL,
  status         text        NOT NULL,
  created_at     timestamptz NOT NULL,
  decided_at     timestamptz
);
CREATE INDEX application_facts_shelter ON application_facts (shelter_id);

CREATE TABLE shelter_facts (
  shelter_id uuid PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL
);

CREATE TABLE counters (
  name  text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0
);
INSERT INTO counters (name) VALUES ('emails_sent');

CREATE TABLE processed_events (
  event_id     uuid PRIMARY KEY,
  stream       text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
