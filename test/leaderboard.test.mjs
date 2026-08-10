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
const board = predictor.match(/async function renderLeaderboard\(\)[\s\S]*?\n  }\n/);

test('the leaderboard is its own view, not a tail on My History', () => {
  assert.ok(board, 'renderLeaderboard not found');
  assert.ok(history, 'renderHistory not found');
  assert.match(board[0], /\/api\/leaderboard/, 'the board view must be the thing that fetches the board');
  assert.ok(!/\/api\/leaderboard/.test(history[0]),
    'My History must not render a leaderboard of its own — that is the burial this undid');
});

test('the predictor exposes goTo, so the tab can actually switch to it', () => {
  // The tab shipped inert once already: goTo lived only on menuActions, which the page never
  // receives, so predictor.goTo was undefined and pressing the tab threw a TypeError into
  // the console while the bar sat there looking fine. Nothing about the rendered markup was
  // wrong, which is exactly why this needs a test rather than a glance.
  const api = predictor.match(/\n  return \{\n    setMode[\s\S]*?\n  \};/);
  assert.ok(api, 'the returned predictor API was not found');
  assert.match(api[0], /goTo/, 'the page needs goTo to reach a non-game view');
  assert.match(index, /predictor\.goTo\('leaderboard'\)/,
    'the Leaderboard tab must drive the predictor, not only paint itself active');
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
  // Measured: the bar is 327px at 375px wide and four full-length labels need 378px, so a
  // fourth tab wraps to a second row and pushes the games down — on exactly the viewport the
  // landing view was cut to ~2,700px for. The short labels are what buy the fourth slot.
  assert.match(index, /SHORT_LABELS/, 'the narrow-viewport labels are gone');
  assert.match(index, /Leaderboard: 'Board'/, 'Leaderboard has no short form to fall back on');
  assert.match(index, /matchMedia\('\(max-width: 460px\)'\)/, 'the breakpoint that selects them is gone');
  // Labels are chosen in JS at render time, not by CSS, so nothing rebuilds them on rotate
  // unless something listens.
  assert.match(index, /narrowTabs\.addEventListener\('change', renderTabs\)/,
    'crossing the breakpoint without a reload must rebuild the row');
});
