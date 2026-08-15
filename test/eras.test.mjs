// Guards on the era what-if lenses.
//
// Two properties here are load-bearing and both fail silently.
//
// THE LEAK. lib/model.mjs's guard inspects the ROWS it is handed. The era table arrives as a
// PARAMETER, so the guard is structurally incapable of seeing it. Safety comes entirely from
// the fact that every era offered ended before the first graded backtest target — which is a
// property of the data, not of the code, and therefore has to be asserted. An era touching the
// graded window would report inflated accuracy and pass every other test in this repo.
//
// THE FRAMING. These lenses do not try to predict better and two of the three measurably do
// not. If one ever loses its `whatIf` flag it becomes a peer of the shipping model in a table
// sorted by recall, and era 3.0 would sit second — reading as "predicting tonight as a 2015
// show works", which the control disproves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildModel, ERA_K } from '../lib/model.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const model = read('lib/model.mjs');
const analyze = read('scripts/analyze.js');
const backtest = read('scripts/backtest.js');
const buildEras = read('scripts/build-eras.js');
const html = read('web/index.html');
const eras = JSON.parse(read('data/eras.json'));
const analysis = JSON.parse(read('data/analysis.json'));

test('there is no era 4.0, anywhere', () => {
  // 4.0 spans 2021 to now and overlaps every graded target. It is also conceptually empty —
  // it is the era the model is already fitted on.
  assert.ok(!eras.eras['4.0'], 'data/eras.json must not contain a 4.0 table');
  assert.doesNotMatch(buildEras, /key: '4\.0'/, 'the generator must not define one');
  const armKeys = (analysis.lenses?.arms || []).map(a => a.key);
  assert.ok(!armKeys.includes('modelEra40TopN'), 'no 4.0 arm may reach the menu');
});

test('every era ends before the first graded show', () => {
  // THE assertion. This is the only thing making the table leak-free, and it is a fact about
  // the data rather than about the code, so nothing else can catch it.
  const start = eras.windowStart;
  assert.ok(start, 'eras.json must record the window start it was checked against');
  for (const [key, e] of Object.entries(eras.eras)) {
    assert.ok(e.lastShow < start,
      `era ${key} ends ${e.lastShow}, at or after the graded window start ${start} — it would leak`);
  }
});

test('the generator refuses to write an era that touches the window', () => {
  // The check above guards today's file; this guards the next person's edit.
  assert.match(buildEras, /lastShow >= WINDOW_START/);
  assert.match(buildEras, /refusing to write/);
  assert.match(buildEras, /process\.exit\(1\)/);
});

test('a missing era table throws rather than degrading to a no-op', () => {
  // Silently ignoring it would make the arm report the SHIPPING model's accuracy under an
  // era's name, which is worse than any crash.
  const rows = [
    { showdate: '2026-01-01', slug: 'a', song: 'A', set: '1', position: 1, tourname: 'T' },
    { showdate: '2026-01-05', slug: 'a', song: 'A', set: '1', position: 1, tourname: 'T' },
  ];
  const args = { rows, target: { date: '2026-02-01', venue: 'V' }, tourName: 'T' };
  assert.throws(() => buildModel({ ...args, era: '1.0' }), /no rates were supplied/);
  assert.throws(() => buildModel({ ...args, era: '4.0', eraRates: eras.eras }), /no rates were supplied/);
  // 'off' is the default and must stay silent.
  assert.doesNotThrow(() => buildModel(args));
});

test('the era term is centred, and centring is not decoration', () => {
  // Subtracting the pool mean cannot reorder anything — it shifts every candidate by one
  // constant. What it does is stop the term dragging the whole distribution negative, which is
  // the ONE way the score>0 gates in assembleSetlist can bite. Uncentred, era 1.0 at k=5
  // empties the opener pool on 44 of 174 shows; centred, no era at any k empties any pool.
  const block = model.match(/if \(era !== 'off'\) \{[\s\S]*?\n {2}\}/);
  assert.ok(block, 'era block not found');
  assert.match(block[0], /logRate\(s\) - mean/, 'the term must be centred on the pool mean');
  assert.match(block[0], /candidates\.reduce/, 'the mean must be taken over the candidate pool');
});

test('the era rate is add-half smoothed, not floored by a shared constant', () => {
  // dayrepeat/hazard use MIN_LIFT because their lift is measured over the whole universe. Here
  // a song can be genuinely absent from an era — 36% of the current pool never appeared in 1.0
  // — and a shared constant would BE the lens for a third of the songs. Add-half ties the
  // absent value to each era's own sample size instead.
  assert.match(buildEras, /dates\.size \+ 0\.5\) \/ \(n \+ 1\)/);
  for (const [key, e] of Object.entries(eras.eras)) {
    assert.ok(e.absentRate > 0, `era ${key} needs an absentRate for songs it never played`);
    assert.ok(Math.abs(e.absentRate - 0.5 / (e.shows + 1)) < 1e-12,
      `era ${key} absentRate must follow its own show count`);
  }
});

test('era lenses are flagged what-if and never claim a Chance', () => {
  const armsSrc = analyze.match(/const LENS_ARMS = \[[\s\S]*?\n\];/)[0];
  for (const line of armsSrc.split('\n').filter(l => /key: 'modelEra/.test(l))) {
    assert.match(line, /whatIf: true/, 'an era lens must be flagged, or it ranks as a peer');
    assert.match(line, /usesCalibration: false/, 'era scores are a different quantity');
    assert.match(line, /hasSlots: false/);
  }
  for (const a of (analysis.lenses?.arms || []).filter(x => /^modelEra/.test(x.key))) {
    assert.equal(a.whatIf, true);
    assert.equal(a.usesCalibration, false);
  }
});

test('the what-if rows sort below the approaches, never interleaved', () => {
  // Sorted together, era 3.0 lands second on recall — above the shipping model — and the table
  // then reads as an endorsement of a lens the control shows is doing nothing.
  assert.match(html, /arms\.filter\(a => !a\.whatIf\)\.sort\(byRecall\)/);
  assert.match(html, /arms\.filter\(a => a\.whatIf\)\.sort\(byRecall\)/);
  assert.match(html, /\[\.\.\.approaches, \.\.\.whatIfs\]/, 'what-ifs must come last');
});

test('the control is measured but never published as an arm', () => {
  // Nobody can select it, so it has no menu row for numbers to sit in — but its comparison is
  // published, because it is the only evidence that the era table did nothing.
  assert.match(backtest, /modelLogFreqTopN: \[\]/, 'the control arm must be graded');
  const pub = backtest.match(/const PUBLISHED_ARMS = \[[^\]]*\]/)[0];
  assert.doesNotMatch(pub, /modelLogFreqTopN/, 'the control is not selectable and must not be published');
  const armKeys = (analysis.lenses?.arms || []).map(a => a.key);
  assert.ok(!armKeys.includes('modelLogFreqTopN'));
  for (const a of (analysis.lenses?.arms || []).filter(x => /^modelEra/.test(x.key))) {
    assert.ok(a.vsControl, `${a.key} must publish its comparison against the control`);
    assert.equal(a.vsControl.arm, 'modelLogFreqTopN');
  }
});

test('the control finding is stated from data, not typed into the copy', () => {
  assert.match(html, /era30\.vsControl/, 'the note must read the published figure');
  assert.doesNotMatch(html, /z -0\.05/, 'the z must not be hardcoded');
});

test('ERA_K is declared, and says so', () => {
  // An accuracy sweep picks k=0 for two eras and k=0.5 for the third, so there is no optimum
  // to find. Anyone who "tunes" this later will make every lens invisible.
  assert.equal(typeof ERA_K, 'number');
  assert.match(model, /DECLARED, NOT TUNED/);
});
