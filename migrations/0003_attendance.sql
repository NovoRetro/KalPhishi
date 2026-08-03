-- Which shows a user was physically at.
--
-- Self-reported: there is no ticket integration and no geofence, so a row here is a
-- claim, not a verified fact. Nothing downstream should treat it as proof of anything.
--
-- Presence of the row IS the attendance — unmarking deletes it rather than flipping a
-- boolean, so there is no second source of truth to drift out of sync.
--
-- Not constrained to shows that exist in the setlist data: users can mark shows the
-- app doesn't know about yet (the pipeline's caches lag phish.net), and marking is
-- allowed retroactively since people forget until after the fact.
CREATE TABLE attendance (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  showdate TEXT NOT NULL,              -- YYYY-MM-DD
  created  TEXT NOT NULL,              -- ISO 8601
  PRIMARY KEY (user_id, showdate)
);

-- Supports "who else was at this show", which the friends phase will want.
CREATE INDEX idx_attendance_showdate ON attendance(showdate);
