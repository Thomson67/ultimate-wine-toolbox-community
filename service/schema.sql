CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('antimicrox','reshade')),
  metadata TEXT NOT NULL,
  profile TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','publishing','approved','rejected')),
  created INTEGER NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT
);
CREATE INDEX IF NOT EXISTS submissions_queue ON submissions(status, kind, created);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_expiry ON rate_limits(expires);

-- Pairing extension: rerunning this complete file preserves existing submissions.
CREATE TABLE IF NOT EXISTS pairings (
  device_hash TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  expires INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),
  remember INTEGER NOT NULL DEFAULT 0,
  access_expires INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pairings_expiry ON pairings(expires);
CREATE TABLE IF NOT EXISTS devices (
  hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_expiry ON devices(expires);
CREATE TABLE IF NOT EXISTS device_sessions (
  session_hash TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_sessions_device ON device_sessions(device_hash);
