// Guards on Wombat (WOMBAT.md).
//
// The resolver is the game. It lives in web/predictor.js because resolution is a
// property of (show, crew) computed at read time in the client — so the tests extract
// the function from the source and run fixtures against it directly. It is written
// self-contained for exactly this reason; if this extraction breaks, the function
// grew a closure dependency it must not have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scoreWombatPrediction } from '../lib/scoring.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const predictor = read('web/predictor.js');
const worker = read('src/worker.mjs');
const index = read('web/index.html');

const src = predictor.match(/function resolveWombat\(entries\) \{[\s\S]*?\n  \}/);
assert.ok(src, 'resolveWombat not found in predictor.js');
// eslint-disable-next-line no-new-func
const resolveWombat = new Function(`return ${src[0]}`)();

const E = (handle, ...slugs) => ({ handle, slugs });

test('the highest rank owns a song exclusively', () => {
  const { owners, outbid, cards } = resolveWombat([
    E('p1', 'tweezer', 'ghost'),
    E('p2', 'ghost', 'tweezer'),
  ]);
  // The symmetric case is the game working: contested chalk splits by conviction.
  assert.equal(owners.tweezer, 'p1');
  assert.equal(owners.ghost, 'p2');
  assert.deepEqual(outbid.tweezer, ['p2']);
  assert.deepEqual(cards.p1, ['tweezer']);
  assert.deepEqual(cards.p2, ['ghost']);
});

test('an exact tie nullifies the tied players and cascades to the next unique claim', () => {
  const { owners, nullified, dead } = resolveWombat([
    E('p1', 'a', 'b', 'c', 'wolfmans'),
    E('p2', 'd', 'e', 'f', 'wolfmans'),
    E('p3', 'g', 'h', 'i', 'j', 'k', 'l', 'wolfmans'),
  ]);
  assert.equal(owners.wolfmans, 'p3', 'the song falls through to the lower unique rank');
  assert.deepEqual(nullified.wolfmans.sort(), ['p1', 'p2']);
  assert.equal(dead.length, 0);
});

test('a song every level ties out is dead', () => {
  const { owners, dead, nullified } = resolveWombat([
    E('p1', 'x', 'wolfmans'),
    E('p2', 'y', 'wolfmans'),
  ]);
  assert.ok(!('wolfmans' in owners));
  assert.deepEqual(dead, ['wolfmans']);
  assert.deepEqual(nullified.wolfmans.sort(), ['p1', 'p2']);
});

test('a collision below a unique best claim cannot assassinate it', () => {
  // p2 and p3 tie at rank 2; p1 holds rank 0 uniquely. The walk stops at the top —
  // without this property two players could void a third player's song on purpose.
  const { owners, dead } = resolveWombat([
    E('p1', 'tweezer'),
    E('p2', 'a', 'b', 'tweezer'),
    E('p3', 'c', 'd', 'tweezer'),
  ]);
  assert.equal(owners.tweezer, 'p1');
  assert.equal(dead.length, 0);
});

test('the card is the top five survivors in the owner’s own rank order', () => {
  const ten = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];
  // p2's #1 and #2 outrank p1's #2 and #3 on the same songs, so p1 loses s2 and s3 and
  // the card slides down the bench: s1, then s4 through s7.
  const { cards } = resolveWombat([
    E('p1', ...ten),
    E('p2', 's2', 's3'),
  ]);
  assert.deepEqual(cards.p1, ['s1', 's4', 's5', 's6', 's7']);
  assert.deepEqual(cards.p2, ['s2', 's3']);
});

test('inherited songs arrive at the inheritor’s own rank — the bench, usually', () => {
  // p3 low-balled tweezer at rank 5 and inherits it via the p1/p2 tie — but their five
  // higher ranks survive, so the inherited chalk misses the card. WOMBAT.md's finding
  // that low-balling is a consolation, not a jackpot, made structural.
  const { owners, cards } = resolveWombat([
    E('p1', 'tweezer'),
    E('p2', 'tweezer'),
    E('p3', 'a', 'b', 'c', 'd', 'e', 'tweezer'),
  ]);
  assert.equal(owners.tweezer, 'p3');
  assert.deepEqual(cards.p3, ['a', 'b', 'c', 'd', 'e']);
});

test('the cron grades wombat as facts, never points', () => {
  const result = scoreWombatPrediction(
    { ranks: [{ slug: 'tweezer', name: 'Tweezer' }, { slug: 'fee', name: 'Fee' }] },
    [{ slug: 'tweezer', set: '1' }, { slug: 'ghost', set: '2' }],
  );
  assert.equal(result.score, null, 'points depend on the crew looking — no per-row score');
  assert.deepEqual(result.played, { tweezer: true, fee: false });
  // And the dispatcher must route wombat rows here, not into the bingo scorer.
  assert.match(worker, /r\.type === 'bingo' \? scoreBingoPrediction\(payload, actual\)\s*\n\s*: scoreWombatPrediction\(payload, actual\)/);
  assert.match(worker, /result\.score \?\? null/, 'a null score must survive the bind');
});

test('the wombat payload is validated as an ordered unique list', () => {
  assert.match(worker, /'setlist', 'bingo', 'wombat'/);
  assert.match(worker, /ranks\.length > 10/);
  assert.match(worker, /duplicate songs in ranks/);
});

test('migration 0009 widens the CHECK and keeps the schema whole', () => {
  const mig = read('migrations/0009_wombat.sql');
  assert.match(mig, /CHECK \(type IN \('setlist','bingo','wombat'\)\)/);
  // The rebuild must carry every column by name and put the index back.
  assert.match(mig, /INSERT INTO predictions_new\s*\n?\s*\(id, user_id, showdate, type, payload, created, updated, result, score, bingo, live_checked, scored_at\)/);
  assert.match(mig, /CREATE INDEX idx_pred_showdate ON predictions\(showdate\)/);
  assert.match(mig, /UNIQUE \(user_id, showdate, type\)/);
});

test('wombat is a game tab and the rig follows the game', () => {
  assert.match(index, /\{ name: 'Wombat', mode: 'wombat' \}/);
  assert.match(index, /document\.documentElement\.dataset\.rig = game\.mode/);
  // All three palettes exist, and the haze/glow retint with the beams.
  for (const rig of ['setlist', 'wombat']) {
    const block = index.match(new RegExp(`:root\\[data-rig="${rig}"\\] \\{([\\s\\S]*?)\\}`));
    assert.ok(block, `palette for ${rig} missing`);
    for (const v of ['--beam-1', '--beam-6', '--haze', '--glow']) {
      assert.match(block[1], new RegExp(v), `${rig} must set ${v}`);
    }
  }
});

test('the mobile banner text does not depend on the beam colour behind it', () => {
  // The per-game palettes made the beams brighter than the violet the scrim was tuned
  // for. The phone block deepens the scrim and puts a hard dark contact shadow under
  // the coloured glow, so legibility survives whatever the rig is playing.
  const phone = index.match(/@media \(max-width: 560px\) \{[\s\S]*?\.stage::before[\s\S]*?\n  \}/);
  assert.ok(phone, 'the phone banner block is gone');
  assert.match(phone[0], /rgba\(6,5,12,0\.86\)/, 'the deepened scrim is gone');
  assert.match(phone[0], /text-shadow: 0 1px 2px rgba\(0,0,0,0\.95\), 0 0 18px var\(--glow/,
    'the title needs its dark contact shadow under the glow');
});

test('the reveal keeps wombat out of the chalk and gives it the draft section', () => {
  const reveal = predictor.match(/async function renderReveal\([\s\S]*?\n  \}/);
  assert.match(reveal[0], /if \(p\.type === 'wombat'\) \{/,
    'wombat rows must not count as calls — ownership is its own section');
  assert.match(reveal[0], /resolveWombat\(wombatEntries\)/);
  assert.match(reveal[0], /wombatEntries\.length >= 2/, 'one list is not a draft');
});
