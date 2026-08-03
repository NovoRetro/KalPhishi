-- Friend groups: named subsets of your friend list, used to scope leaderboards.
--
-- Owner-managed (roadmap open question 1): whoever created the group is the only one who
-- can rename it, add people, or remove them. Members can leave on their own — being
-- unable to exit a group someone else put you in would be worse than the simplicity is
-- worth.
--
-- Membership is drawn from the owner's friends (roadmap open question 3), so the invite
-- link stays the single way to connect. There is no FK enforcing that, because a
-- friendship can be removed after the fact — the route checks it at add time, and the
-- friends-removal path deletes the corresponding memberships.
CREATE TABLE friend_groups (
  id       TEXT PRIMARY KEY,            -- random, like invite codes
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  created  TEXT NOT NULL                -- ISO 8601
);

-- The owner is stored as a member too, so leaderboard queries are a plain join rather
-- than "members UNION the owner" everywhere.
CREATE TABLE friend_group_members (
  group_id TEXT NOT NULL REFERENCES friend_groups(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created  TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_groups_owner ON friend_groups(owner_id);
CREATE INDEX idx_group_members_user ON friend_group_members(user_id);
