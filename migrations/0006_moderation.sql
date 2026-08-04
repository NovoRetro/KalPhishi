-- Moderation: the ability to rename or ban an account after the fact.
--
-- Registration is open and unverified, so an offensive name can appear at any time. The
-- sanitiser in lib/identity.mjs stops lookalike and invisible-character tricks, but a
-- plainly offensive yet well-formed name passes it, and until now the only remedy was
-- editing D1 by hand.
--
-- banned_at is a timestamp rather than a flag: knowing WHEN an account was banned is
-- worth having, and NULL is an unambiguous "active".
--
-- Nothing is deleted by a ban. Predictions stay, so already-graded shows and the model's
-- own track record remain consistent; the account simply stops authenticating and stops
-- appearing in public listings.
ALTER TABLE users ADD COLUMN banned_at     TEXT;
ALTER TABLE users ADD COLUMN banned_reason TEXT;

-- Every read path filters on this, and it is the hot check on session resolution.
CREATE INDEX idx_users_banned ON users(banned_at);
