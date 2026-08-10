// Guards on invite links that carry a group.
//
// Redeeming one does two writes — a friendship and a group membership — and the second is
// only legitimate because the first happened. Every property below protects that ordering
// or the bound on how far a link reaches. Like the password-reset guards, none of this can
// be exercised without D1, so these assert the properties are present in the source. The
// failures they catch are the quiet kind: a link that still works perfectly by hand while
// having stopped joining anyone to anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const worker = read('src/worker.mjs');
const migration = read('migrations/0008_invite_groups.sql');
const page = read('web/index.html');

const create = worker.match(/if \(p === '\/api\/invites' && m === 'POST'\)[\s\S]*?\n  }/);
const redeem = worker.match(/if \(p\.startsWith\('\/api\/invites\/'\) && p\.endsWith\('\/redeem'\)[\s\S]*?\n  }/);

test('deleting a group does not revoke links people are already holding', () => {
  // CASCADE here would delete the invite row outright, so a link shared with thirty people
  // would start returning "not valid" because the owner tidied up a group. SET NULL leaves
  // the friend invite it always also was.
  assert.match(migration, /ALTER TABLE invites ADD COLUMN group_id TEXT REFERENCES friend_groups\(id\) ON DELETE SET NULL/,
    'group_id must be a nullable FK that nulls out rather than cascading');
  assert.ok(!/ON DELETE CASCADE/.test(migration), 'a group invite must survive its group');
});

test('only the group owner can mint a link into their group', () => {
  // Redeeming a group link IS the add-a-member act, which is owner-only on
  // /api/groups/:id/members. Minting had to inherit that or it would be the way around it.
  assert.ok(create, 'invite creation handler not found');
  assert.match(create[0], /FROM friend_groups WHERE id = \?1 AND owner_id = \?2/,
    'creation must scope the group lookup to the caller as owner');
  assert.match(create[0], /err\(404, 'no such group'\)/,
    'an unowned or missing group must be refused');
});

test('redemption re-resolves the group against the invite owner', () => {
  // The group could have been deleted, and the check at mint time is minutes-to-weeks old
  // by the time anyone opens the link. Same reasoning as re-checking bans at reset
  // redemption: the authorising fact has to hold now, not when the link was made.
  assert.ok(redeem, 'invite redemption handler not found');
  assert.match(redeem[0], /SELECT id, name FROM friend_groups WHERE id = \?1 AND owner_id = \?2/,
    'redeem must re-resolve the group and pin it to the invite owner');
});

test('an existing friend still gets joined to the group', () => {
  // The early return used to fire on friendship alone. With a group attached that would
  // report success while doing nothing — the exact failure where someone is told they are
  // in the group and is not. The no-op path must require BOTH.
  assert.match(redeem[0], /if \(alreadyFriends && alreadyMember\)/,
    'the no-op early return must require membership as well as friendship');
  const early = redeem[0].match(/if \(alreadyFriends && alreadyMember\) \{[\s\S]*?\n    \}/);
  assert.ok(early, 'early-return block not found');
  assert.match(early[0], /already: true/, 'the no-op path must still report success');
});

test('the group join cannot land without the friendship that authorises it', () => {
  // Membership is drawn from the owner's friends (0005_groups.sql). One batch is what makes
  // that true at redemption: a partial write leaving a membership without the friendship
  // would put a non-friend on a group leaderboard, which is the thing a standalone
  // join-by-group code was rejected for.
  assert.match(redeem[0], /await env\.DB\.batch\(stmts\)/,
    'redemption writes must go out as one batch');
  assert.match(redeem[0], /INSERT INTO friend_group_members[\s\S]*?ON CONFLICT DO NOTHING/,
    'the membership insert must be idempotent');
  const batchIdx = redeem[0].indexOf('await env.DB.batch(stmts)');
  const memberIdx = redeem[0].indexOf('INSERT INTO friend_group_members');
  const usesIdx = redeem[0].indexOf('UPDATE invites SET uses');
  assert.ok(memberIdx > -1 && memberIdx < batchIdx,
    'the membership insert must be queued into the batch, not run separately');
  assert.ok(usesIdx > -1 && usesIdx < batchIdx,
    'a redeem that does work must be counted against max_uses in the same batch');
});

test('a new invite link is bounded unless its creator says otherwise', () => {
  // An unlimited link is one forum post away from strangers in a tester's friends list and
  // on the leaderboard they meant to compare against. The schema always honoured limits;
  // nothing ever set them.
  assert.match(worker, /const DEFAULT_INVITE_USES = \d+;/, 'a default use count must exist');
  assert.match(worker, /const DEFAULT_INVITE_DAYS = \d+;/, 'a default expiry must exist');
  assert.match(create[0], /pickLimit\(maxUses, DEFAULT_INVITE_USES\)/, 'uses must default');
  assert.match(create[0], /pickLimit\(expiresInDays, DEFAULT_INVITE_DAYS\)/, 'expiry must default');
});

test('an omitted limit takes the default while an explicit 0 opts out', () => {
  // Collapsing the two is how every link ended up unlimited: the old code treated a missing
  // field and a zero identically and fell through to NULL for both.
  const pick = worker.match(/const pickLimit = \(v, fallback\) => \{[\s\S]*?\n};/);
  assert.ok(pick, 'pickLimit not found');
  assert.match(pick[0], /v === undefined \|\| v === null.*\n?.*return fallback/,
    'a missing limit must fall back to the default, never to unlimited');
  assert.match(pick[0], /n <= 0\) return null/, 'an explicit 0 must mean no limit');
});

test('the invite UI offers only groups the caller owns', () => {
  // The server refuses the rest; not offering them is what keeps the refusal from being
  // something a tester has to discover by hitting it.
  assert.match(page, /groups\.filter\(g => g\.isOwner\)/,
    'the group selector must be built from owned groups only');
  assert.match(page, /maxUses: Number\(uses\.value\), expiresInDays: Number\(days\.value\)/,
    'the creation form must send the limits it displays');
});

test('a group name reaches the DOM as text, never as markup', () => {
  // Group names are free text their owner typed, and el() assigns innerHTML. Everywhere
  // else in this panel goes through esc(); these two paths use textContent instead, so a
  // name containing a tag renders as the name.
  // \s* rather than \n\s*: local files are CRLF and CI builds on Linux with LF, so any
  // pattern anchored on a literal newline passes on one and not the other.
  const scope = page.match(/const scope = el\('select', 'invite-limit'\);[\s\S]*?scope\.appendChild\(opt\);\s*\}/);
  assert.ok(scope, 'group selector block not found');
  assert.ok(!/el\('option'[^)]*,\s*[`'"]/.test(scope[0]),
    'option labels must not be passed through el()\'s innerHTML argument');
  assert.match(scope[0], /opt\.textContent = /, 'the option label must be set as text');
  assert.match(page, /copy\.textContent = label;/, 'the copy button label must be set as text');
});
