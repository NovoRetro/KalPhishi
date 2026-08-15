// Guards on Crew Night Phase 0 and 1 (SOCIAL-PLAN.md).
//
// Phase 0 seals GET /api/predictions: before a show locks, anyone but the predictor gets
// the fact of a prediction and nothing else. This is the game's integrity model — the
// moment picks are shareable, an unsealed read API is a copy machine. Phase 1 gives every
// group member the roster plus per-game "in for the show" booleans.
//
// Same source-assertion pattern and same reason as reach/moderation: the queries need D1,
// so the properties are asserted against the source. Behaviour was verified separately
// against a real local D1 (two accounts, friendship, group, pre- and post-lock reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = readFileSync(join(root, 'src/worker.mjs'), 'utf8');
const index = readFileSync(join(root, 'web/index.html'), 'utf8');
const predictor = readFileSync(join(root, 'web/predictor.js'), 'utf8');

// No trailing "\n" after the brace — CRLF checkout, see reach.test.mjs. The route
// snippet is literal worker source, so escape it before it becomes a regex.
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const handlerFor = (route, method) => {
  const re = new RegExp(
    `if \\(${reEsc(route)} && m === '${method}'\\) \\{[\\s\\S]*?\\n  \\}`);
  const h = worker.match(re);
  assert.ok(h, `${method} ${route} handler not found`);
  return h[0];
};
const stripComments = s => s.replace(/\/\/[^\n]*/g, '');

// ---- Phase 0: the seal ----

const predsGet = () => handlerFor(`p === '/api/predictions'`, 'GET');

test('the sealed shape carries no payload key at all', () => {
  // Not a nulled payload — no key. A client that trusts `'payload' in p` must get the
  // honest answer, and a future serializer change cannot leak by reviving a null.
  const sealed = predsGet().match(/return \{ ([^}]*)sealed: true \};/);
  assert.ok(sealed, 'the sealed return shape is gone');
  assert.doesNotMatch(sealed[1], /payload|result|liveChecked|score/,
    'the sealed shape must carry identity fields only');
});

test('your own predictions are always fully visible', () => {
  const c = stripComments(predsGet());
  // The own check must run BEFORE the lock check: a signed-in player reloading mid-show
  // reads their own live card through this route.
  const own = c.indexOf('r.user_id === me.id');
  const lock = c.indexOf('lockState(');
  assert.ok(own !== -1, 'the own-prediction check is gone');
  assert.ok(lock !== -1, 'the lock check is gone');
  assert.ok(own < lock, 'own-ness must be decided before the lock is even consulted');
});

test('the seal opens through the same lock the save route enforces', () => {
  const c = stripComments(predsGet());
  assert.match(c, /lockState\(r\.showdate\)/);
  assert.doesNotMatch(c, /Date\.now\(\)|new Date\(/,
    'compare through lockState, not by hand — an unknown showtime must fail sealed');
});

test('post-lock visibility is friends and shared groups, in one query', () => {
  const c = stripComments(predsGet());
  assert.match(c, /FROM friendships WHERE user_id = \?1/);
  assert.match(c, /UNION/);
  assert.match(c, /friend_group_members/);
  // A per-row friendship query would be a query per prediction on the history read.
  assert.match(c, /new Set\(/, 'visibility must collapse to a Set lookup per row');
});

test('a stranger stays sealed even after the lock', () => {
  const c = stripComments(predsGet());
  assert.match(c, /open \|\| !circle\.has\(r\.user_id\)/,
    'the sealed branch must catch both the unlocked show and the unconnected reader');
});

// ---- Phase 1: the roster ----

const membersGet = () => handlerFor(`p.startsWith('/api/groups/') && p.endsWith('/members')`, 'GET');

test('the members route stays membership-gated', () => {
  // Phase 1 widens what the UI shows, not what the API allows — this was already
  // member-readable and must not accidentally become public while being extended.
  const c = stripComments(membersGet());
  assert.match(c, /friend_group_members WHERE group_id = \?1 AND user_id = \?2/);
  assert.match(c, /404/);
});

test('the roster dots are booleans, never payloads', () => {
  const c = stripComments(membersGet());
  assert.match(c, /setlist: false, bingo: false/, 'the boolean default shape is gone');
  assert.doesNotMatch(c, /payload/,
    'this route must never grow a payload column, or it becomes a way around the seal');
  assert.doesNotMatch(c, /\bemail\b/, 'rosters are handle-only, like every other listing');
});

test('the group listing counts participation only when asked', () => {
  const c = stripComments(handlerFor(`p === '/api/groups'`, 'GET'));
  assert.match(c, /COUNT\(DISTINCT pr\.user_id\)/);
  assert.match(c, /q\.get\('showdate'\)/);
  assert.doesNotMatch(c, /payload/, 'a count of who is in, never of what they picked');
});

// ---- Phase 1: the UI ----

test('every member can open the roster, not just the owner', () => {
  // The original complaint: members could not see who was in their own group, because
  // the only member list lived inside the owner's Add picker.
  assert.match(index, /async function drawMembers\(/, 'the roster view is gone');
  assert.match(index, /open\.addEventListener\('click', \(\) => drawMembers\(g, friends\)\)/,
    'the group name must be the way in');
  const members = index.match(/async function drawMembers\([\s\S]*?\n      \}/);
  assert.doesNotMatch(members[0], /isOwner &&[\s\S]*?drawMembers/,
    'nothing about opening the roster may be owner-gated');
});

test('the roster dots come from the predictor’s idea of the open show', () => {
  assert.match(predictor, /showdate: \(\) => showdate/,
    'the predictor must hand the menu its showdate');
  assert.match(index, /state\.actions\?\.showdate\?\.\(\)/,
    'the menu must ask rather than compute its own date');
  // The weekday label derives from the show's date, never from today's.
  assert.match(index, /new Date\(showdate \+ 'T12:00:00'\)/);
});
