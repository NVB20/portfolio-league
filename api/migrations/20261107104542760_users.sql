-- Up Migration

-- One row per player. Firebase Auth owns the login; this row owns the app data.
CREATE TABLE users (
  uid        TEXT PRIMARY KEY,                       -- the Firebase Auth uid (the JWT's `sub`)
  email      TEXT NOT NULL,                          -- copied from the verified token on every login
  roles      TEXT[] NOT NULL DEFAULT '{user}'
             CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['admin', 'user']),
  theme      TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),   -- D-007
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE users;
