// Prediction scoring (lib/scoring.mjs). Pure, and the thing users' track records
// are built from — a silent change here rewrites everyone's accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyName, scoreSetlistPrediction, scoreBingoPrediction, bingoLine, FREE, LINES,
} from '../lib/scoring.mjs';

const song = slug => ({ slug, name: slug });
const played = (slug, set) => ({ slug, name: slug, set });

test('slugifyName: lowercases, collapses punctuation, trims dashes', () => {
  assert.equal(slugifyName('  Mike\'s Song  '), 'mike-s-song');
  assert.equal(slugifyName('46 Days'), '46-days');
  assert.equal(slugifyName('Say It To Me S.A.N.T.O.S.'), 'say-it-to-me-s-a-n-t-o-s');
  assert.equal(slugifyName('rguempel@gmail.com'), 'rguempel-gmail-com');
  assert.equal(slugifyName('!!!'), '', 'punctuation-only collapses to empty');
});

test('setlist: an empty prediction scores zero rather than dividing by zero', () => {
  const r = scoreSetlistPrediction({ set1: [], set2: [], encore: [] }, [played('tweezer', '1')]);
  assert.equal(r.score, 0);
  assert.deepEqual(r.hits, []);
});

test('setlist: all songs hit with no stressors scores the full song weight', () => {
  const r = scoreSetlistPrediction(
    // 'a' and 'b' must sit mid-set, or they would also earn closer stressors.
    { set1: [song('a')], set2: [song('b')], encore: [] },
    [played('x', '1'), played('a', '1'), played('w', '1'),
     played('y', '2'), played('b', '2'), played('z', '2')],
  );
  assert.equal(r.score, 70);
  assert.deepEqual(r.hits.sort(), ['a', 'b']);
  assert.deepEqual(r.misses, []);
  assert.deepEqual(Object.values(r.stressors), [false, false, false, false, false]);
});

test('setlist: half the songs hit scores half the song weight', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('a'), song('miss1')], set2: [song('b'), song('miss2')], encore: [] },
    [played('q', '1'), played('a', '1'), played('r', '1'),
     played('s', '2'), played('b', '2'), played('t', '2')],
  );
  assert.equal(r.score, 35);
  assert.deepEqual(r.misses.sort(), ['miss1', 'miss2']);
});

test('setlist: a perfect call earns song weight plus all five stressors', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('a'), song('b')], set2: [song('c'), song('d')], encore: [song('e')] },
    [played('a', '1'), played('b', '1'), played('c', '2'), played('d', '2'), played('e', 'e')],
  );
  assert.deepEqual(r.stressors,
    { opener: true, s1closer: true, s2opener: true, s2closer: true, encore: true });
  assert.equal(r.score, 100, '70 + 5 stressors x 6');
});

test('setlist: a single-song set is both the opener and the closer', () => {
  const r = scoreSetlistPrediction(
    { set1: [song('a')], set2: [], encore: [] },
    [played('a', '1'), played('z', '1')],
  );
  assert.equal(r.stressors.opener, true);
  assert.equal(r.stressors.s1closer, false, 'closer must match the real set closer, which is z');
});

test('setlist: the second encore counts as encore', () => {
  const r = scoreSetlistPrediction(
    { set1: [], set2: [], encore: [song('e2song')] },
    [played('other', 'e'), played('e2song', 'e2')],
  );
  assert.equal(r.stressors.encore, true);
});

test('setlist: soundcheck-style sets do not become openers', () => {
  // Only sets '1' and '2' feed the opener/closer stressors.
  const r = scoreSetlistPrediction(
    { set1: [song('a')], set2: [], encore: [] },
    [played('a', '3')],
  );
  assert.equal(r.stressors.opener, false);
  assert.equal(r.score, 70, 'still a song hit');
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
