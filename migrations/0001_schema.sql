-- Kalphishi schema. Mirrors the collections of the former data/db.json.

CREATE TABLE users (
  id       TEXT PRIMARY KEY,           -- slugifyName(name)
  name     TEXT NOT NULL,
  created  TEXT NOT NULL,              -- ISO 8601
  passhash TEXT,                       -- NULL = legacy account, claimable by registering the name
  profile  TEXT NOT NULL DEFAULT '{}'  -- JSON: {displayName,avatar,hometown,favoriteSong,bio}
);

-- token_hash is SHA-256 of the cookie value, so a database leak yields no usable sessions.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires    INTEGER NOT NULL          -- epoch ms
);
CREATE INDEX idx_sessions_expires ON sessions(expires);

-- score and bingo are denormalized out of the result JSON because they are the only
-- fields aggregated over (user stats, leaderboard); everything else is read wholesale.
CREATE TABLE predictions (
  id           TEXT PRIMARY KEY,       -- "${user_id}-${showdate}-${type}"
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  showdate     TEXT NOT NULL,          -- YYYY-MM-DD
  type         TEXT NOT NULL CHECK (type IN ('setlist','bingo')),
  payload      TEXT NOT NULL,          -- JSON
  created      TEXT NOT NULL,
  updated      TEXT,
  result       TEXT,                   -- JSON, NULL until scored
  score        REAL,
  bingo        INTEGER NOT NULL DEFAULT 0,
  live_checked TEXT,                   -- JSON bool[]
  scored_at    TEXT,
  UNIQUE (user_id, showdate, type)
);
CREATE INDEX idx_pred_showdate ON predictions(showdate);
