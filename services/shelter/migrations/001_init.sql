-- shelter schema
CREATE TABLE shelters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  district    text        NOT NULL DEFAULT '',
  address     text        NOT NULL DEFAULT '',
  phone       text        NOT NULL DEFAULT '',
  email       text        NOT NULL DEFAULT '',
  about       text        NOT NULL DEFAULT '',
  status      text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_at timestamptz,
  approved_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shelters_status ON shelters (status);

-- transactional outbox (see libs/common/events.js)
CREATE TABLE outbox (
  id          uuid PRIMARY KEY,
  stream      text        NOT NULL,
  payload     jsonb       NOT NULL,
  traceparent text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX outbox_unsent ON outbox (created_at) WHERE sent_at IS NULL;
