// The day-since-last-play repeat curve (lib/dayrepeat.mjs).
//
// Synthetic fixtures again — data/setlists-*.json is gitignored, so a test that fitted
// the curve on real data would pass locally and fail in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKETS, bucketFor, daysBetween, fitRepeatCurve, repeatAdjustment, isSuppressed,
} from '../lib/dayrepeat.mjs';

test('bucketFor covers every non-negative day count exactly once', () => {
  for (const days of [0, 1, 2, 3, 5, 7, 9, 13, 20, 30, 50, 100, 500, 10_000]) {
    const matches = BUCKETS.filter(([lo, hi]) => days >= lo && days <= hi);
    assert.equal(matches.length, 1, `${days} days matched ${matches.length} buckets`);
    assert.ok(bucketFor(days) >= 0);
  }
});

test('bucketFor rejects a negative gap — a song cannot have been played in the future', () => {
  assert.equal(bucketFor(-1), -1);
});

test('daysBetween is whole days and order-independent', () => {
  assert.equal(daysBetween('2026-08-01', '2026-07-31'), 1);
  assert.equal(daysBetween('2026-07-31', '2026-08-01'), 1);
  assert.equal(daysBetween('2026-08-01', '2026-08-01'), 0);
  assert.equal(daysBetween('2026-08-15', '2026-08-01'), 14);
});

// A band that plays 'nightly' every show and 'rare' only far apart. The curve should
// separate them: short gaps carry the nightly song, long gaps carry the rare one.
function fixture() {
  const dates = [];
  const setOf = new Map();
  for (let i = 0; i < 60; i++) {
    // Consecutive days, so "shows ago" and "days ago" coincide and are easy to reason about.
    const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    dates.push(d);
    const songs = new Set(['nightly']);
    if (i % 10 === 0) songs.add('rare');
    setOf.set(d, songs);
  }
  return { dates, setOf };
}

test('fitRepeatCurve returns one lift per bucket and a sane base rate', () => {
  const { dates, setOf } = fixture();
  const c = fitRepeatCurve(dates, setOf, { warmup: 10, trail: 30 });
  assert.equal(c.lift.length, BUCKETS.length);
  assert.equal(c.rate.length, BUCKETS.length);
  assert.ok(c.base > 0 && c.base <= 1, `base rate ${c.base} out of range`);
  assert.ok(c.n > 0);
});

test('a song played every night shows a high lift at a one-day gap', () => {
  const { dates, setOf } = fixture();
  const c = fitRepeatCurve(dates, setOf, { warmup: 10, trail: 30 });
  // 'nightly' is always exactly 1 day since its last play and always played, so the
  // 0-1 bucket must land above the overall base rate.
  assert.ok(c.rate[bucketFor(1)] > c.base, `0-1 rate ${c.rate[bucketFor(1)]} <= base ${c.base}`);
});

test('lift is never zero, so the log adjustment stays finite', () => {
  // A corpus where nothing ever repeats quickly would otherwise produce log(0).
  const dates = [];
  const setOf = new Map();
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    dates.push(d);
    setOf.set(d, new Set([`song-${i}`])); // every song played exactly once, ever
  }
  const c = fitRepeatCurve(dates, setOf, { warmup: 5, trail: 30 });
  for (const l of c.lift) assert.ok(l > 0, 'a zero lift would make repeatAdjustment -Infinity');
  assert.ok(Number.isFinite(repeatAdjustment(c, 1, 6)));
});

test('repeatAdjustment scales with k and is signed by the lift', () => {
  const c = { lift: BUCKETS.map(() => 1) };
  c.lift[bucketFor(1)] = 0.04;  // suppressed
  c.lift[bucketFor(40)] = 1.75; // elevated
  assert.ok(repeatAdjustment(c, 1, 6) < 0);
  assert.ok(repeatAdjustment(c, 40, 6) > 0);
  assert.equal(repeatAdjustment(c, 1, 12), 2 * repeatAdjustment(c, 1, 6));
  assert.equal(repeatAdjustment(c, 200, 6), 0); // lift 1 -> no opinion
});

test('repeatAdjustment is neutral for an impossible gap', () => {
  const c = { lift: BUCKETS.map(() => 2) };
  assert.equal(repeatAdjustment(c, -5, 6), 0);
});

test('isSuppressed flags only buckets below the threshold', () => {
  const c = { lift: BUCKETS.map(() => 1) };
  c.lift[bucketFor(1)] = 0.01;
  c.lift[bucketFor(3)] = 0.04;
  c.lift[bucketFor(9)] = 1.64;
  assert.equal(isSuppressed(c, 1), true);
  assert.equal(isSuppressed(c, 3), true);
  assert.equal(isSuppressed(c, 9), false);
  assert.equal(isSuppressed(c, 3, 0.01), false); // threshold is respected
});

test('fitRepeatCurve never looks past the dates it is given', () => {
  // The backtest hands it history only; if it reached into setOf for a date outside
  // `dates` the curve would be fitted on the future.
  const { dates, setOf } = fixture();
  const history = dates.slice(0, 30);
  const seen = new Set();
  const spy = new Map(setOf);
  spy.get = key => { seen.add(key); return Map.prototype.get.call(setOf, key); };
  fitRepeatCurve(history, spy, { warmup: 10, trail: 30 });
  for (const d of seen) assert.ok(history.includes(d), `read ${d}, which is outside the given history`);
});
