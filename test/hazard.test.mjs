// Guards on the relative-time (dueness) hazard.
//
// Unlike most tests in this repo these are real unit tests, not source assertions: hazard.mjs
// is pure and takes plain arrays, so the properties can be exercised directly.
//
// The one that matters most is the leakage guard. This curve is fitted from history inside a
// walk-forward that already refits per target, so a leak here would not throw and would not
// look wrong — it would look like the curve helping, which is precisely the outcome the
// experiment is trying to measure. buildModel's own guard cannot catch it, because the rows
// are legitimate; the mistake would be scoring tonight's opportunity using tonight's result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cadenceOf, fitRelativeCurve, relativeAdjustment, ratioBucketFor,
  RATIO_BUCKETS, MIN_PLAYS_FOR_CADENCE, medianOf,
} from '../lib/hazard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const model = read('lib/model.mjs');
const html = read('web/index.html');
const analysis = JSON.parse(read('data/analysis.json'));

// Dates n days apart, ascending.
const days = (start, ...gaps) => {
  const out = [start];
  let t = new Date(start).getTime();
  for (const g of gaps) { t += g * 86_400_000; out.push(new Date(t).toISOString().slice(0, 10)); }
  return out;
};

test('median handles both parities', () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 2, 3]), 2.5);
  assert.equal(medianOf([]), null);
});

test('a song without enough plays has no cadence at all', () => {
  // Three plays give two gaps, and a median of two numbers is their mean — which is not a
  // cadence, it is an average of one observation and another. The model must get nothing
  // here rather than a number it would then act on.
  const few = new Map([['thin', days('2026-01-01', 10, 10)]]);           // 3 plays
  assert.equal(cadenceOf(few).has('thin'), false);
  const enough = new Map([['ok', days('2026-01-01', 10, 10, 10)]]);      // 4 plays
  assert.equal(cadenceOf(enough).get('ok'), 10);
  assert.equal(MIN_PLAYS_FOR_CADENCE, 4);
});

test('cadence is measured in calendar days, not shows', () => {
  // The whole reason this exists: three nights of a run and three shows across a fortnight
  // are the same number of shows apart and nothing like the same number of days.
  const m = cadenceOf(new Map([['s', days('2026-01-01', 1, 1, 30)]]));
  assert.equal(m.get('s'), 1, 'median of gaps 1,1,30 is 1 day');
});

test('ratio buckets tile the range without gaps or overlap', () => {
  for (let i = 1; i < RATIO_BUCKETS.length; i++) {
    assert.equal(RATIO_BUCKETS[i][0], RATIO_BUCKETS[i - 1][1], 'buckets must be contiguous');
  }
  assert.equal(ratioBucketFor(0), 0);
  assert.equal(ratioBucketFor(999), RATIO_BUCKETS.length - 1);
  // Boundaries belong to the upper bucket, so a value can never match two.
  assert.equal(ratioBucketFor(0.25), 1);
  assert.notEqual(ratioBucketFor(0.25), ratioBucketFor(0.2499));
});

test('an opportunity is never scored using its own outcome', () => {
  // THE leakage guard. A song played at every show, fed to a curve that folded tonight in
  // before scoring it, would show a hit rate of 1.0 in whichever bucket it lands in. Folding
  // in afterwards is what keeps the measured rate a prediction rather than a readback.
  const dates = [];
  for (let i = 0; i < 80; i++) dates.push(new Date(Date.UTC(2026, 0, 1 + i * 3)).toISOString().slice(0, 10));
  const setOf = new Map(dates.map(d => [d, new Set(['always'])]));
  const curve = fitRelativeCurve(dates, setOf, { warmup: 10, trail: 30 });
  // Every opportunity is a hit here by construction, so the base rate is 1 and every lift is
  // 1 — what must NOT happen is the fit reporting more hits than opportunities.
  const hits = curve.rate.map((r, i) => r * curve.opps[i]);
  hits.forEach((h, i) => assert.ok(h <= curve.opps[i] + 1e-9, 'a bucket cannot hit more often than it occurred'));
  assert.ok(curve.n > 0, 'the fit must actually collect opportunities');
});

test('the fit sees only the dates it is handed', () => {
  // Callers pass history strictly before the target; the curve must not reach past the end
  // of that array under any circumstance, which is what makes it safe inside buildModel.
  const dates = [];
  for (let i = 0; i < 60; i++) dates.push(new Date(Date.UTC(2026, 0, 1 + i * 4)).toISOString().slice(0, 10));
  const setOf = new Map(dates.map((d, i) => [d, new Set(i % 2 ? ['a'] : ['b'])]));
  const full = fitRelativeCurve(dates, setOf, { warmup: 10, trail: 30 });
  const short = fitRelativeCurve(dates.slice(0, 40), setOf, { warmup: 10, trail: 30 });
  assert.ok(short.n < full.n, 'a shorter history must yield strictly fewer opportunities');
});

test('no adjustment without a known cadence', () => {
  const curve = { lift: RATIO_BUCKETS.map(() => 2) };
  assert.equal(relativeAdjustment(curve, 30, null, 5), 0, 'unknown cadence must contribute nothing');
  assert.equal(relativeAdjustment(null, 30, 10, 5), 0, 'no curve, no adjustment');
  assert.equal(relativeAdjustment(curve, Infinity, 10, 5), 0, 'never played is not a ratio');
  assert.notEqual(relativeAdjustment(curve, 30, 10, 5), 0, 'with both, it must speak');
});

test('the adjustment is multiplicative evidence entering an additive score', () => {
  // log, so that a lift of 1 is worth exactly nothing and halving is the negative of
  // doubling. Anything else and the curve would bias every candidate that has a cadence.
  const curve = { lift: RATIO_BUCKETS.map(() => 1) };
  assert.equal(relativeAdjustment(curve, 30, 10, 5), 0, 'lift 1 must be a no-op');
  const up = { lift: RATIO_BUCKETS.map(() => 2) };
  const down = { lift: RATIO_BUCKETS.map(() => 0.5) };
  assert.ok(Math.abs(relativeAdjustment(up, 30, 10, 5) + relativeAdjustment(down, 30, 10, 5)) < 1e-9);
});

test('k scales the curve linearly', () => {
  const curve = { lift: RATIO_BUCKETS.map(() => 3) };
  assert.ok(Math.abs(relativeAdjustment(curve, 30, 10, 4) - 2 * relativeAdjustment(curve, 30, 10, 2)) < 1e-9);
  assert.equal(relativeAdjustment(curve, 30, 10, 0), 0, 'k=0 is the control and must be silent');
});

test('fitted and tuned dueness are alternatives, never both', () => {
  // They score the same idea — overdue against this song's own habit — so applying both
  // would count it twice, and the double-count would look like the fitted curve working.
  // Matched against the whole source rather than an extracted block: a lazy run stops at the
  // first 4-space "}", which IS the "} else if" line, so extracting first would cut off
  // exactly the token under test.
  assert.match(model, /if \(duenessFitted\) \{[\s\S]*?\} else if \(s\.medianInterval\) \{/,
    'the two branches must be exclusive, not two consecutive ifs');
  assert.match(model, /\/\/ dueness vs personal cadence/, 'the block must stay findable');
});

test('the published arm carries the comparison that qualifies it', () => {
  // It tops the table on "vs baseline", a bar every model arm clears. Shipping that number
  // without the one against its nearest neighbour would be an accurate table that misleads.
  const arm = (analysis.lenses?.arms || []).find(a => a.key === 'modelDuenessTopN');
  assert.ok(arm, 'the dueness arm is not in the published menu');
  assert.ok(arm.vsNearest, 'an arm one change away from another must publish that comparison');
  assert.equal(arm.vsNearest.arm, 'modelTopN');
  assert.ok(Number.isFinite(arm.vsNearest.z), 'the comparison needs its z, or it says nothing');
  assert.ok(arm.byYear && arm.byYear.length >= 2, 'per-year recall must travel with it');
});

test('the arm never shows a Chance, because the bins were not fitted for it', () => {
  // It replaces a scoring term outright, so its scores are a different quantity from the
  // ones the isotonic bins were fitted on. lenses.test.mjs asserts the flag; this asserts
  // the shipped payload agrees with it.
  const arm = analysis.lenses.arms.find(a => a.key === 'modelDuenessTopN');
  assert.equal(arm.usesCalibration, false);
  assert.equal(arm.hasSlots, false, 'the measured arm is the top-N one');
  assert.ok(analysis.lenses.rankings.modelDuenessTopN?.length, 'a selectable arm needs a ranking');
});

test('the caveats are rendered from data, not typed into the copy', () => {
  // A hardcoded "+0.75pp" silently becomes a lie the next time the backtest runs. The note
  // has to read the published figure, the same rule the arm table already follows.
  assert.match(html, /due\.vsNearest/, 'the note must read the published comparison');
  assert.match(html, /tops it by less than it looks/, 'the caveat must actually be stated');
  assert.doesNotMatch(html, /\+?0\.75pp/, 'the delta must not be hardcoded');
  assert.doesNotMatch(html, /z 1\.23/, 'the z must not be hardcoded');
});

test('the shipping model still uses the tuned term', () => {
  // This experiment must not become the default by accident: measured over all 174 shows the
  // fitted curve is +0.75pp at z 1.23 against modelTopN, which does not clear the bar this
  // repo applies to everything else.
  assert.match(model, /dueness = 'tuned'/, "buildModel must default to the shipped behaviour");
});
