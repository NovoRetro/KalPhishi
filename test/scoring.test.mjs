// Prediction scoring (lib/scoring.mjs). Pure, and the thing users' track records
// are built from — a silent change here rewrites everyone's accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyName, scoreSetlistPrediction, scoreBingoPrediction, bingoLine, FREE, LINES,
  SETLIST_POINTS, SETLIST_SOFT_CAP,
} from '../lib/scoring.mjs';

const song = slug => ({ slug, name: slug });
const played = (slug, set) => ({ slug, name: slug, set });

test('slugifyName: lowercases, collapses punctuation, trims dashes', () => {
  assert.equal(slugifyName('  Mike\'s Song  '), 'mike-s-song');
  assert.equal(slugifyName('46 Days'), '46-days');
  assert.equal(slugifyName('Say It To Me S.A.N.T.O.S.'), 'say-it-to-me-s-a-n-t-o-s');
  assert.equal(slugifyName('someone@example.com'), 'someone-example-com');
  assert.equal(slugifyName('!!!'), '', 'punctuation-only collapses to empty');
});

test('setlist: an empty prediction scores zero rather than dividing by zero', () => {
  const r = scoreSetlistPrediction({ set1: [], set2: [], encore: [] }, [played('tweezer', '1')]);
  assert.equal(r.score, 0);
  assert.deepEqual(r.hits, []);
});

test('setlist: calling a song earns a point wherever it lands', () => {
  const r = scoreSetlistPrediction(
    // 'a' and 'b' sit mid-set so they earn neither an opener nor a closer, and neither
    // is at the index it was predicted at, so neither earns placement.
    { set1: [song('a')], set2: [song('b')], encore: [] },
    [played('x', '1'), played('a', '1'), played('w', '1'),
     played('y', '2'), played('b', '2'), played('z', '2')],
  );
  assert.equal(r.score, 2, 'two calls, nothing else');
  assert.deepEqual(r.hits.sort(), ['a', 'b']);
  assert.deepEqual(r.misses, []);
  assert.deepEqual(r.stressors, { opener: false, s1closer: false, s2opener: false, s2closer: false });
});

test('setlist: a song at the exact index earns its call plus placement', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('x'), song('a')], set2: [], encore: [] },
    [played('x', '1'), played('a', '1'), played('w', '1')],
  );
  // x: call + placement + opener. a: call + placement. Neither is the real closer (w).
  assert.equal(r.breakdown.placements.length, 2);
  assert.equal(r.score, 2 * SETLIST_POINTS.call + 2 * SETLIST_POINTS.placement + SETLIST_POINTS.opener);
});

test('setlist: a called song at the wrong index earns the call only', () => {
  // The worked example: two songs displaced by exactly one slot must score identically.
  const actual = ['carini', 'bathtub-gin', 'meatstick', 'blaze-on', 'piper', 'twist', 'first-tube']
    .map(s => played(s, '1'));
  const r = scoreSetlistPrediction(
    { set1: ['ghost', 'bathtub-gin', 'sand', 'meatstick', 'blaze-on'].map(song), set2: [], encore: [] },
    actual,
  );
  assert.deepEqual(r.hits.sort(), ['bathtub-gin', 'blaze-on', 'meatstick']);
  assert.deepEqual(r.breakdown.placements.map(p => p.slug), ['bathtub-gin'],
    'meatstick and blaze-on are both one slot late — neither is placed');
  assert.equal(r.score, 5, '3 calls + 1 placement');
});

test('setlist: calls stop paying at the cap', () => {
  const many = Array.from({ length: 14 }, (_, i) => song('s' + i));
  const r = scoreSetlistPrediction(
    { set1: many, set2: [], encore: [] },
    // Played in a different order, so nothing earns placement and only calls are measured.
    [...many].reverse().map(s => played(s.slug, '1')),
  );
  assert.equal(r.breakdown.calls, 14);
  assert.equal(r.breakdown.callsCounted, SETLIST_POINTS.callCap);
  assert.equal(r.breakdown.callsCapped, true);
  assert.equal(r.breakdown.callPoints, 10);
});

test('setlist: openers and closers are priced apart', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('a'), song('b')], set2: [song('c'), song('d')], encore: [] },
    [played('a', '1'), played('b', '1'), played('c', '2'), played('d', '2')],
  );
  assert.deepEqual(r.stressors, { opener: true, s1closer: true, s2opener: true, s2closer: true });
  const expected =
    4 * SETLIST_POINTS.call + 4 * SETLIST_POINTS.placement +
    2 * SETLIST_POINTS.opener + SETLIST_POINTS.s1closer + SETLIST_POINTS.s2closer;
  assert.equal(r.score, expected);
});

test('setlist: a one-song list is the opener but not also the closer', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('a')], set2: [], encore: [] },
    [played('a', '1'), played('z', '1')],
  );
  assert.equal(r.stressors.opener, true);
  assert.equal(r.stressors.s1closer, false, 'the real closer is z, and one entry cannot be both');
});

test('setlist: encore songs pay per song, and the second encore counts', () => {
  const r = scoreSetlistPrediction(
    { set1: [], set2: [], encore: [song('e2song'), song('other')] },
    [played('other', 'e'), played('e2song', 'e2')],
  );
  assert.deepEqual(r.breakdown.encoreHits.sort(), ['e2song', 'other']);
  assert.equal(r.breakdown.encorePoints, 2 * SETLIST_POINTS.encoreSong);
  assert.equal(r.score, 2 * SETLIST_POINTS.call + 2 * SETLIST_POINTS.encoreSong);
});

test('setlist: an encore call that was played elsewhere earns the call but not the encore bonus', () => {
  const r = scoreSetlistPrediction(
    { set1: [], set2: [], encore: [song('a')] },
    [played('a', '1'), played('z', 'e')],
  );
  assert.equal(r.breakdown.encoreHits.length, 0);
  assert.equal(r.score, SETLIST_POINTS.call);
});

test('setlist: a third-set song is a call but never an opener', () => {
  // Only sets '1' and '2' feed the opener/closer stressors.
  const r = scoreSetlistPrediction(
    { set1: [song('a')], set2: [], encore: [] },
    [played('a', '3')],
  );
  assert.equal(r.stressors.opener, false);
  assert.equal(r.score, SETLIST_POINTS.call, 'still a call');
});

test('setlist: the same song listed twice is one call', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('a')], set2: [song('a')], encore: [] },
    [played('z', '1'), played('a', '1'), played('y', '1')],
  );
  assert.equal(r.breakdown.calls, 1);
  assert.equal(r.score, SETLIST_POINTS.call);
});

test('setlist: nothing is deducted at or under the soft cap', () => {
  const ten = Array.from({ length: SETLIST_SOFT_CAP.set1 }, (_, i) => song('miss' + i));
  const r = scoreSetlistPrediction({ set1: ten, set2: [], encore: [] }, [played('z', '1')]);
  assert.deepEqual(r.breakdown.overCap, []);
  assert.equal(r.score, 0, 'ten wrong guesses inside the cap are free');
});

test('setlist: only the wrong guesses PAST the cap are deducted', () => {
  // 13 entries: the first 10 are free. Of the 3 beyond, one was played.
  const list = [
    ...Array.from({ length: SETLIST_SOFT_CAP.set1 }, (_, i) => song('miss' + i)),
    song('over-miss-1'), song('over-hit'), song('over-miss-2'),
  ];
  const r = scoreSetlistPrediction({ set1: list, set2: [], encore: [] },
    [played('z', '1'), played('over-hit', '1')]);
  assert.equal(r.breakdown.overCap.length, 1);
  assert.equal(r.breakdown.overCap[0].count, 2, 'over-hit was played, so it is not deducted');
  assert.equal(r.breakdown.penaltyPoints, 2 * SETLIST_POINTS.overCap);
  assert.equal(r.score, SETLIST_POINTS.call - 2, 'one call, minus two wrong over-cap guesses');
});

test('setlist: the encore has its own, lower soft cap', () => {
  const list = Array.from({ length: SETLIST_SOFT_CAP.encore + 2 }, (_, i) => song('e' + i));
  const r = scoreSetlistPrediction({ set1: [], set2: [], encore: list }, [played('z', 'e')]);
  assert.equal(r.breakdown.penaltyPoints, 2 * SETLIST_POINTS.overCap);
});

test('setlist: a padded list can score below zero, which is what deters padding', () => {
  const list = Array.from({ length: 30 }, (_, i) => song('miss' + i));
  const r = scoreSetlistPrediction({ set1: list, set2: [], encore: [] }, [played('z', '1')]);
  assert.equal(r.score, -(30 - SETLIST_SOFT_CAP.set1) * SETLIST_POINTS.overCap);
  assert.ok(r.score < 0);
});

test('bingo: the free centre never counts as a hit', () => {
  const grid = Array.from({ length: 25 }, (_, i) => (i === FREE ? null : song('s' + i)));
  const r = scoreBingoPrediction({ grid }, []);
  assert.equal(r.hitCount, 0);
  assert.equal(r.checked[FREE], false);
  assert.equal(r.score, 0);
});

test('bingo: all 24 fillable squares hit scores 80 plus the 20 line bonus', () => {
  const grid = Array.from({ length: 25 }, (_, i) => (i === FREE ? null : song('s' + i)));
  const actual = grid.filter(Boolean).map(c => played(c.slug, '1'));
  const r = scoreBingoPrediction({ grid }, actual);
  assert.equal(r.hitCount, 24);
  assert.equal(r.bingo, true);
  assert.equal(r.score, 100);
});

test('bingo: a completed line through the free centre wins with only 4 hits', () => {
  const grid = Array.from({ length: 25 }, (_, i) => (i === FREE ? null : song('s' + i)));
  const diagonal = [0, 6, 18, 24]; // 12 is FREE
  const r = scoreBingoPrediction({ grid }, diagonal.map(i => played('s' + i, '1')));
  assert.equal(r.hitCount, 4);
  assert.equal(r.bingo, true);
  assert.deepEqual(r.line, [0, 6, 12, 18, 24]);
  assert.equal(r.score, +(4 / 24 * 80 + 20).toFixed(1));
});

test('bingo: four in a row without the fifth is not a line', () => {
  const grid = Array.from({ length: 25 }, (_, i) => (i === FREE ? null : song('s' + i)));
  const r = scoreBingoPrediction({ grid }, [0, 1, 2, 3].map(i => played('s' + i, '1')));
  assert.equal(r.bingo, false);
  assert.equal(r.line, null);
});

test('bingo: empty squares cannot be hits', () => {
  const grid = Array.from({ length: 25 }, () => null);
  const r = scoreBingoPrediction({ grid }, [played('anything', '1')]);
  assert.equal(r.hitCount, 0);
  assert.equal(r.bingo, false);
});

test('bingoLine: 12 lines exist and the free centre alone does not win', () => {
  assert.equal(LINES.length, 12, '5 rows + 5 columns + 2 diagonals');
  assert.equal(bingoLine(Array(25).fill(false)), null);
});

test('bingoLine: each of the 12 lines is detected', () => {
  for (const line of LINES) {
    const checked = Array(25).fill(false);
    for (const i of line) if (i !== FREE) checked[i] = true;
    assert.deepEqual(bingoLine(checked), line, `line ${line} not detected`);
  }
});
