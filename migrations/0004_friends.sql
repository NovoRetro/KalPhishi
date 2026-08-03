-- Friends, established by redeeming an invite link.
--
-- Symmetric and accept-free (roadmap Design Decision 4): redeeming creates the
-- friendship in BOTH directions at once, so there is no pending state and no "X wants to
-- be your friend" queue. Every read is therefore a simple lookup on user_id — no need to
-- check both columns — and removal has to delete both rows or the two people would
-- disagree about whether they are friends.
CREATE TABLE friendships (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created   TEXT NOT NULL,              -- ISO 8601
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)          -- nobody is their own friend
);

-- Invite links. The code is a bearer token: anyone holding the link can redeem it, the
-- same way a Discord invite works. That is the intent — the owner shares it deliberately
-- — so codes must be unguessable, not merely unique.
--
-- expires/max_uses are nullable rather than defaulted so "no limit" is representable
-- without a sentinel value. uses is incremented in the same batch as the friendship
-- write, so a redeem can never succeed without also being counted.
CREATE TABLE invites (
  code     TEXT PRIMARY KEY,            -- random, URL-safe
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created  TEXT NOT NULL,
  expires  INTEGER,                     -- epoch ms, NULL = never expires
  max_uses INTEGER,                     -- NULL = unlimited
  uses     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_invites_owner ON invites(owner_id);
