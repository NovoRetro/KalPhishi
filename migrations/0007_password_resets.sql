-- Admin-issued password reset links.
--
-- Registration takes an email but nothing is ever sent to it, so there is no self-service
-- recovery and a forgotten password was permanent: the account could not be re-entered and
-- its predictions stopped being gradeable. With a tester cohort playing through to Dick's
-- that is the one failure that loses a person and their data at the same time.
--
-- Full email delivery is the eventual answer. This is the cheap one that closes the hole
-- now: an operator mints a single-use link out of band and hands it over.
--
-- token_hash is the PRIMARY KEY and stores sha256 of the secret, never the secret itself —
-- exactly as sessions do. Someone reading this table cannot reset anybody's password;
-- lookup is a hash of what the visitor presents, which is also why it can be an indexed
-- equality match rather than a scan.
--
-- expires is epoch milliseconds, matching sessions.expires, so both are compared against
-- Date.now() without a units conversion sitting between them.
--
-- used_at is a timestamp rather than a flag for the same reason banned_at is: knowing WHEN
-- a link was redeemed is worth having, and NULL is an unambiguous "still open".
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created    TEXT NOT NULL,
  expires    INTEGER NOT NULL,
  used_at    TEXT
);

-- Issuing a new link supersedes any outstanding one for that account, which is a delete
-- scoped by user_id.
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

-- The cron sweeps expired rows alongside expired sessions.
CREATE INDEX idx_password_resets_expires ON password_resets(expires);
