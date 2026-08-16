-- Wombat (WOMBAT.md): a third prediction type. SQLite cannot widen a CHECK in place,
-- so this is the standard rebuild — new table, copy, drop, rename, and the one index
-- predictions carries. Column list is written out rather than SELECT * so the copy
-- breaks loudly if the schema ever drifts from what this migration believes.
--
-- Wombat rows live in predictions ON PURPOSE: the sealed-until-lock rules on
-- GET /api/predictions are the game's integrity model, and a separate table would sit
-- outside them and need its own visibility logic. One rule, one place.
--
-- The cron scores wombat rows only as facts — result = which of the ten ranked songs
-- played, score stays NULL — because points depend on which crew is looking (resolution
-- is per crew, computed at read; see lib-less resolver in web/predictor.js).
CREATE TABLE predictions_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  showdate     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('setlist','bingo','wombat')),
  payload      TEXT NOT NULL,
  created      TEXT NOT NULL,
  updated      TEXT,
  result       TEXT,
  score        REAL,
  bingo        INTEGER NOT NULL DEFAULT 0,
  live_checked TEXT,
  scored_at    TEXT,
  UNIQUE (user_id, showdate, type)
);
INSERT INTO predictions_new
  (id, user_id, showdate, type, payload, created, updated, result, score, bingo, live_checked, scored_at)
  SELECT id, user_id, showdate, type, payload, created, updated, result, score, bingo, live_checked, scored_at
    FROM predictions;
DROP TABLE predictions;
ALTER TABLE predictions_new RENAME TO predictions;
CREATE INDEX idx_pred_showdate ON predictions(showdate);
