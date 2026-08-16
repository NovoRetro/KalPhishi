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

// ---- Phases 1-2: the UI ----

test('every member can open the crew page, not just the owner', () => {
  // The original complaint: members could not see who was in their own group, because
  // the only member list lived inside the owner's Add picker. Phase 1 answered it with a
  // drawer roster; Phase 2 promoted that roster into the Crew page, and the group's name
  // in the drawer is the way in for everyone.
  assert.match(index, /open\.addEventListener\('click', \(\) => \{ close\(\); actions\?\.goToCrew\?\.\(g\.id\); \}\)/,
    'the group name must open the crew page');
  assert.match(predictor, /async function renderCrew\(/, 'the crew page renderer is gone');
  const crew = predictor.match(/async function renderCrew\([\s\S]*?\n  \}/);
  assert.doesNotMatch(crew[0], /isOwner[\s\S]{0,80}?return/,
    'nothing about seeing the room may be owner-gated — owner-ness only adds tools');
  // The roster inside the room must stay facts-about-participation, never content.
  assert.doesNotMatch(stripComments(crew[0]), /payload/, 'the room shows who is in, not what they picked');
});

test('the roster dots come from the predictor’s idea of the open show', () => {
  assert.match(predictor, /showdate: \(\) => showdate/,
    'the predictor must hand the menu its showdate');
  assert.match(index, /state\.actions\?\.showdate\?\.\(\)/,
    'the menu must ask rather than compute its own date');
  // The weekday label derives from the show's date, never from today's.
  assert.match(index, /new Date\(showdate \+ 'T12:00:00'\)/);
});

// ---- Phase 2: the room's server surface ----

test('rename is owner-scoped in the query itself', () => {
  const c = stripComments(handlerFor(`p.startsWith('/api/groups/') && !p.includes('/members')`, 'PATCH'));
  // Scoped UPDATE, same shape as the DELETE: renaming someone else's group is a silent
  // no-op rather than a confirmation that the id exists.
  assert.match(c, /UPDATE friend_groups SET name = \?1 WHERE id = \?2 AND owner_id = \?3/);
  // Same cap as create — a second, looser validator for the same column is how limits rot.
  assert.match(c, /slice\(0, 40\)/);
});

test('the crew boards are the existing leaderboard, pinned', () => {
  // The room must not grow its own ranking machinery — one scorer, one board renderer.
  assert.match(predictor, /renderLeaderboard\(crewBoardGame, boardHost, `group:\$\{crewId\}`\)/,
    'the crew page must reuse renderLeaderboard with a fixed group scope');
  assert.match(predictor, /if \(!fixedScope\) \{/,
    'a pinned board must not offer the scope picker — a way to leave the room while standing in it');
});

// ---- the provenance tag ----

test('the applied-prediction tag requires the board to still match the fill', () => {
  // The tag says "this board IS that approach's call". It appears when Our Prediction
  // fills a board and disappears the moment an edit deviates — checked by snapshot
  // comparison on every render, so nothing has to remember to remove it.
  assert.match(predictor, /appliedFill = \{ mode: 'setlist', label: fillLabel\(\), snap: setlistSnap\(build\) \}/);
  assert.match(predictor, /appliedFill = \{ mode: 'bingo', label: fillLabel\(\), snap: gridSnap\(grid\) \}/);
  assert.match(predictor, /const live = mode === 'setlist' \? setlistSnap\(build\)\s*\n?\s*: mode === 'bingo' \? gridSnap\(grid\) : wombatSnap\(wombatRanks\);/,
    'the tag must be gated on a live comparison, not on a flag an edit could forget to clear');
  assert.match(predictor, /if \(live === appliedFill\.snap\)/);
  // The old behaviour — wearing the tag merely because a lens was selected — must not return.
  assert.doesNotMatch(predictor, /&& !lensIsDefault\(\)\) \{\s*\n\s*const arm = lensArm\(\);\s*\n\s*const chip/,
    'the tag is provenance, not a settings indicator');
});

test('the arm labels are named for players, keys unchanged', () => {
  const analyze = readFileSync(join(root, 'scripts/analyze.js'), 'utf8');
  for (const [key, label] of [
    ['model', 'House Model'], ['modelTopN', 'Straight Ranking'],
    ['modelDuenessTopN', 'Native Model'], ['modelShowGap', 'Classic Recency'],
  ]) {
    assert.match(analyze, new RegExp(`key: '${key}', label: '${label}'`),
      `${key} must be labelled "${label}" — the key stays, the label is for people`);
  }
});

// ---- Phase 3: reveal night ----

test('the reveal is gated on the lock and adds no server surface', () => {
  // The whole design: Phase 0's seal is the only server rule, and the reveal is a client
  // read of the same route everything else reads. If this ever grows its own endpoint,
  // there are two visibility rules to keep consistent instead of one.
  assert.match(predictor, /if \(L\.locked\) await renderReveal\(wrap, members\)/,
    'the reveal must render only once the show is locked');
  const reveal = predictor.match(/async function renderReveal\([\s\S]*?\n  \}/);
  assert.ok(reveal, 'renderReveal not found');
  assert.match(reveal[0], /api\(`\/api\/predictions\?showdate=/,
    'the reveal must read the predictions route, not a new one');
  assert.match(reveal[0], /p\.payload\)/,
    'sealed rows carry no payload and must drop out of every count');
});

test('consensus needs at least two callers and half the crew', () => {
  const reveal = predictor.match(/async function renderReveal\([\s\S]*?\n  \}/)[0];
  assert.match(reveal, /Math\.max\(2, Math\.ceil\(callers\.length \/ 2\)\)/,
    'a consensus of one person agreeing with themselves is just their pick twice');
  assert.match(reveal, /callers\.length >= 2/,
    'nothing comparative renders for a crew of one caller');
});

test('the share card is built from SVG in-document, nothing fetched', () => {
  const share = predictor.match(/async function shareRevealCard\([\s\S]*?\n  \}/);
  assert.ok(share, 'shareRevealCard not found');
  assert.match(share[0], /data:image\/svg\+xml/, 'the SVG must travel as a data URI');
  // The xmlns is exempt: it is a namespace IDENTIFIER the parser never dereferences,
  // not a URL anything loads.
  assert.doesNotMatch(share[0], /fetch\(|https?:\/\/(?!www\.w3\.org)/,
    'the card must be self-contained — no fetched fonts, images or libraries');
  // The fallback chain, in the order of fewest taps to the group chat.
  const order = ['navigator.canShare', 'navigator.clipboard', 'a.download'];
  let last = -1;
  for (const step of order) {
    const at = share[0].indexOf(step);
    assert.ok(at > last, `${step} must come after ${order[order.indexOf(step) - 1] || 'the start'}`);
    last = at;
  }
  // Every user-supplied string that reaches the SVG is escaped — a crew name is free text.
  assert.match(share[0], /escXml\(crewName\)/, 'the crew name must be XML-escaped');
});

// ---- the invite door (2026-08-16) ----

test('the invite preview needs no session and leaks nothing', () => {
  const c = stripComments(handlerFor(`p.startsWith('/api/invites/') && p.endsWith('/preview')`, 'GET'));
  // The one invite route without a session check — the reader has no account yet, which
  // is the entire point. Holding a 16-byte code IS the authorisation.
  assert.doesNotMatch(c, /currentUser/, 'the preview must not require a session');
  // Three answers, and no fourth.
  assert.match(c, /publicName\(owner\)/, 'a legacy email-as-name must not leak here either');
  assert.doesNotMatch(c, /\bemail\b/);
  assert.doesNotMatch(c, /handle/, 'the preview names a person, it does not identify an account');
  assert.doesNotMatch(c, /group\.id|id: group/, 'the group id belongs to whoever actually joins');
  // Same verdicts as redeem, so one link cannot read two ways.
  for (const v of ['that invite link is not valid', 'that invite link has expired', 'that invite link has been used up']) {
    assert.ok(c.includes(v), `preview must report "${v}" the way redeem does`);
  }
});

test('a ban reaches the links the account already minted', () => {
  // Otherwise moderation is one old URL away from being bypassed: a banned account keeps
  // recruiting friends and filling its groups while invisible everywhere else.
  for (const route of [
    `p.startsWith('/api/invites/') && p.endsWith('/preview')`,
    `p.startsWith('/api/invites/') && p.endsWith('/redeem')`,
  ]) {
    const c = stripComments(handlerFor(route, route.includes('preview') ? 'GET' : 'POST'));
    assert.match(c, /!owner \|\| isBanned\(owner\)/, `${route} must refuse a banned owner's link`);
  }
});

test('the invite door names who is behind it, and opens into the crew', () => {
  const fn = predictor.match(/async function redeemPendingInvite\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, 'redeemPendingInvite not found');
  // Asked BEFORE the signup form is offered, not after.
  assert.match(fn[0], /\/preview`\)[\s\S]*?authPrompt = \{ tab: 'register', message/,
    'the preview must resolve before the auth prompt is built');
  assert.match(fn[0], /invited you to \$\{inv\.group\.name\}/);
  // A dead link still offers signup — the person arrived through a friend either way.
  assert.match(fn[0], /catch \(e\) \{\s*\n?\s*message = e\.message \|\| message;/);
  // And a successful group redeem lands them in the room rather than in a 2.5s toast.
  assert.match(fn[0], /menuActions\.goToCrew\(j\.group\.id\)/);
});

test('the invite flash survives the navigation that follows it', () => {
  // goToCrew re-renders, and render() empties the mount a flash was appended to — so
  // announcing before navigating destroys the announcement. Order is load-bearing, and
  // its failure mode is silent (a toast that simply never appears).
  const fn = predictor.match(/async function redeemPendingInvite\(\)[\s\S]*?\n  \}/)[0];
  const nav = fn.indexOf('menuActions.goToCrew(j.group.id)');
  const say = fn.indexOf('`You\'re in ${j.group.name}.`');
  assert.ok(nav !== -1 && say !== -1, 'the group branch of the redeem is gone');
  assert.ok(nav < say, 'navigate first, then flash — the reverse wipes the flash');
});
