-- profile schema: personal details. Credentials live in login, not here.
CREATE TABLE profiles (
  user_id    uuid PRIMARY KEY,
  email      text        NOT NULL,
  name       text        NOT NULL DEFAULT '',
  phone      text        NOT NULL DEFAULT '',
  district   text        NOT NULL DEFAULT '',
  home_type  text        NOT NULL DEFAULT '' CHECK (home_type IN ('', 'house', 'apartment', 'farm', 'other')),
  has_yard   boolean     NOT NULL DEFAULT false,
  other_pets text        NOT NULL DEFAULT '',
  about      text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
