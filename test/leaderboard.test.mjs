// Guards on where the leaderboard lives.
//
// It spent its life rendered at the foot of My History, which meant friends, groups and
// invites all fed a view reachable only by opening the account menu and scrolling past
// somebody's prediction history. Moving it to its own tab is easy to undo by accident —
// re-add one `wrap.appendChild` in renderHistory and it is quietly in two places, or in the
// wrong one. Source-property assertions, same reason as password-reset.test.mjs: none of
// this can be exercised without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Newlines normalised because the working copy is CRLF on Windows and LF on CI, and an
// anchor like `\n  }` silently stops matching against `\r\n  }` — the assertion fails on one
// machine and passes on the other, which is worse than not having it.
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const predictor = read('web/predictor.js');
const index = read('web/index.html');

const history = predictor.match(/async function renderHistory\(\)[\s\S]*?\n  }\n/);
const board = predictor.match(/async function renderLeaderboard\(game, wrap\)[\s\S]*?\n  }\n/);

test('the leaderboard is not a tail on My History', () => {
  assert.ok(board, 'renderLeaderboard not found');
  assert.ok(history, 'renderHistory not found');
  assert.match(board[0], /\/api\/leaderboard/, 'the board must be the thing that fetches the board');
  assert.ok(!/\/api\/leaderboard/.test(history[0]),
    'My History must not render a leaderboard of its own — that is the burial this undid');
});

test('the board is per game and ranked by that game', () => {
  // The API orders by setlist points because that is the main game. A bingo board that
  // rendered the response as-is would be a setlist ranking under a bingo heading — right
  // numbers, wrong order, and nothing about it looks broken.
  assert.match(board[0], /const G = game === 'bingo'/, 'the per-game descriptor is gone');
  assert.match(board[0], /board\.filter\(G\.played\)\.sort\(G\.rank\)/,
    'the board must be re-ranked and filtered for the game it belongs to');
  // Filtered, not just sorted: somebody with only setlist scores is absent from the bingo
  // board, not last on it.
  assert.match(board[0], /bingoScored \|\| 0\) > 0/, 'the bingo board must exclude non-players');
  assert.match(board[0], /setlistScored \|\| 0\) > 0/, 'the setlist board must exclude non-players');
});

test('both games can reach their standings, including a scored bingo card', () => {
  // A scored card has no Actions menu — it is the one screen where the controls row is gone,
  // and the screen most likely to prompt "so where did that put me".
  // Counted, not matched. Asserting the entry merely exists passed while only Setlist Bets
  // had it — one call site is indistinguishable from two to a bare regex, and the missing
  // one was the game that opens by default.
  const entries = [...predictor.matchAll(/^\s*boardMenuItem\(\),$/gm)];
  assert.equal(entries.length, 2, 'both games must carry the Actions entry, not just one');
  assert.match(predictor, /if \(boardOpen\) mount\.appendChild\(boardPanel\('setlist'\)\)/,
    'Setlist Bets must render its own board');
  assert.match(predictor, /if \(boardOpen\) mount\.appendChild\(boardPanel\('bingo'\)\)/,
    'Phish Bingo must render its own board');
  assert.match(predictor, /row\.appendChild\(boardButton\(\)\)/,
    'a scored bingo card must still offer the standings');
});

test('the standings are not a tab', () => {
  // A fourth tab cost a permanent slot in the row a phone can least afford, for something
  // read occasionally. Re-adding one is a two-line change, so it is worth a guard.
  assert.ok(!/Leaderboard: 'Board'/.test(index), 'the Leaderboard tab label is back');
  assert.ok(!/predictor\.goTo\('leaderboard'\)/.test(index), 'the Leaderboard tab is back');
  assert.ok(!/mode === 'leaderboard'/.test(predictor), 'leaderboard is a panel now, not a view');
});

test('a signed-out visitor gets the open scope and no 401s', () => {
  // The everyone scope is deliberately public (see the route in worker.mjs) — showing the
  // standings to somebody deciding whether to register is the point. Offering Friends to a
  // visitor who has no session would be offering a guaranteed error.
  assert.match(board[0], /if \(!user\) leaderboardScope = 'everyone'/,
    'a stale scope from before a sign-out must fall back rather than 401');
  assert.match(board[0], /scopes = user\s*\n?\s*\?/,
    'the scope list must be conditional on having a session');
});

test('the tab row stays one line on a phone', () => {
  // Measured: the bar is 327px at 375px wide, and the full labels plus Play a Show do not
  // fit there. Shortening them is what keeps this to one line — two rows of tabs push the
  // games down on exactly the viewport the landing view was cut to ~2,700px for.
  assert.match(index, /SHORT_LABELS/, 'the narrow-viewport labels are gone');
  // Labels are chosen in JS at render time, not by CSS, so nothing rebuilds them on rotate
  // unless something listens.
  assert.match(index, /narrowTabs\.addEventListener\('change', renderTabs\)/,
    'crossing the breakpoint without a reload must rebuild the row');
});

test('the account menu is ordered for a returning player', () => {
  // Identity, then what you did, then who you are playing against. Friends sits inside that
  // loop rather than below the reference material, and the reference material sits just
  // above the way out.
  const tail = index.match(/panel\.appendChild\(item\('My History'[\s\S]*?'danger'\)\);/);
  assert.ok(tail, 'the menu list was not found');
  const order = [...tail[0].matchAll(/item\('([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(order, ['My History', 'Friends', 'How scoring works', 'Sign out'],
    'the account menu order changed');
  // The identity block is the Profile button — a separate Profile row was a second way to
  // say the same thing, and the block looked like a header you could not press.
  assert.match(index, /const id = el\('button', 'menu-id menu-item'/,
    'the identity block must be the Profile button');
  assert.match(index, /id\.addEventListener\('click', \(\) => \{ close\(\); actions\?\.goTo\('profile'\); \}\)/,
    'pressing it must go to Profile');
});

test('changing a password lives in Profile, not the menu', () => {
  const profile = predictor.match(/function renderProfile\(\)[\s\S]*?\n  }\n/);
  assert.ok(profile, 'renderProfile not found');
  assert.match(profile[0], /'\/api\/password', 'PUT'/, 'Profile must own the password form');
  assert.ok(!/view === 'password'/.test(index),
    'the menu must not keep a password view that nothing can reach');
  // The consequence, not just the confirmation: every other session is gone.
  assert.match(profile[0], /Other devices were signed out/,
    'the result must say what it did to other sessions');
});

test('the label breakpoint matches the CSS that shrinks the same row', () => {
  // These size one row between them, so they have to agree. They did not once: labels
  // switched at 460px while the full-length set needs ~522px to fit, leaving 461–530 —
  // tablet widths — wrapping to two rows. Swept 320px to 1440px to find it, because it is
  // invisible at both ends.
  const js = index.match(/matchMedia\('\(max-width: (\d+)px\)'\)/);
  assert.ok(js, 'the tab-label breakpoint is gone');
  assert.equal(js[1], '560', 'the JS breakpoint moved without the CSS');
  const css = index.match(/@media \(max-width: (\d+)px\) \{\s*\n\s*\.btn-play \{ min-width: 44px/);
  assert.ok(css, 'the icon-only Play a Show rule is gone');
  assert.equal(css[1], js[1],
    'the button and the labels must shorten at the same width or the row wraps between them');
});

test('Play a Show sits in the tab row and keeps its name when it loses its label', () => {
  // It used to float on the banner above the row, which read as elevated above the things
  // it is a peer of. Below 560px it is the glyph alone — 44x44, no text — so the accessible
  // name has to be attached explicitly or the control becomes unnamed on exactly the
  // devices where it is hardest to guess at.
  assert.match(index, /tabBar\.appendChild\(playBtn\)/, 'the button must be in the tab row');
  assert.match(index, /playBtn\.setAttribute\('aria-label', 'Play a Show'\)/,
    'the icon-only form must carry its name');
  assert.match(index, /\.btn-play \{ margin-left: auto;/, 'it must stay pinned to the right of the row');
});
