-- Email login and public handles.
--
-- Three identifiers, three jobs (roadmap, Design Decision 1):
--   id     — internal PK and FK target; after this change it never leaves the server.
--   email  — login credential; unique, case-insensitive; NULL for accounts created
--            before this migration until they link one (or, for the passwordless
--            legacy shape, until the name is claimed).
--   handle — public profile identifier; unique, case-insensitive; assigned by the
--            backfill script for existing rows and at registration for new ones.
--            Never derived from the email.
--
-- Backfill of values is done by scripts/backfill-handles.js against live rows, not
-- here: a migration hardcoding account data would leak it into the repo.

ALTER TABLE users ADD COLUMN email  TEXT;
ALTER TABLE users ADD COLUMN handle TEXT;

CREATE UNIQUE INDEX idx_users_email  ON users(LOWER(email))  WHERE email  IS NOT NULL;
CREATE UNIQUE INDEX idx_users_handle ON users(LOWER(handle)) WHERE handle IS NOT NULL;
