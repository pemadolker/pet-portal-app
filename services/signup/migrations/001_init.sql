-- signup schema: an audit trail of sign-up attempts. The account itself lives in
-- login (credentials), profile (personal details) and shelter (for staff).
CREATE TABLE registrations (
  id             uuid PRIMARY KEY,
  email          text        NOT NULL,
  role           text        NOT NULL CHECK (role IN ('adopter', 'staff', 'admin')),
  status         text        NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  failure_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registrations_email ON registrations (email);
CREATE INDEX registrations_created ON registrations (created_at DESC);
