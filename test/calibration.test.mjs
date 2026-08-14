// Guards on the score -> probability map.
//
// Unlike most of this repo's tests these exercise real behaviour rather than asserting on
// source text, because the thing that can go wrong here is arithmetic. The failure mode is
// not a crash: it is a number that looks plausible and is wrong, which nobody notices until
// somebody trusts a 70% that was really a 40%.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fitPlatt, plattProb, fitIsotonic, isoProb, brier, logLoss, reliability,
} from '../lib/calibration.mjs';

// A deterministic sample whose true relationship is known, so the fit can be checked
// against an answer rather than against itself. Higher score really is more likely.
function synth(n = 2000) {
  const out = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    const score = -20 + (i % 70);
    const truth = 1 / (1 + Math.exp(-(score - 25) / 8));
    out.push({ score, y: rnd() < truth ? 1 : 0 });
  }
  return out;
}

test('a higher score always maps to a higher probability', () => {
  // Monotonicity is the property that makes this safe to add at all: it cannot reorder
  // candidates, so the predicted setlist, precision and recall are untouched. If this ever
  // fails, calibration has silently become a model change.
  const params = fitPlatt(synth());
  let prev = -Infinity;
  for (let s = -30; s <= 60; s += 0.5) {
    const p = plattProb(params, s);
    assert.ok(p >= prev, `p must not decrease as score rises (score ${s})`);
    prev = p;
  }
});

test('probabilities stay inside (0, 1)', () => {
  const params = fitPlatt(synth());
  for (const s of [-1e6, -100, 0, 100, 1e6]) {
    const p = plattProb(params, s);
    assert.ok(p > 0 && p < 1, `p out of range at score ${s}: ${p}`);
  }
  // A hard 0 or 1 makes log-loss infinite the first time it is wrong, and no model that has
  // watched a band improvise for 174 shows has earned certainty.
  assert.ok(plattProb(params, 1e6) <= 0.999);
  assert.ok(plattProb(params, -1e6) >= 0.001);
});

test('the fit recovers a known relationship', () => {
  // The synthetic truth crosses 50% at score 25. A fit that cannot find that is not
  // calibrating anything.
  const params = fitPlatt(synth());
  let cross = null;
  for (let s = -20; s <= 60; s += 0.1) {
    if (plattProb(params, s) >= 0.5) { cross = s; break; }
  }
  assert.ok(cross != null, 'never reaches 50%');
  assert.ok(Math.abs(cross - 25) < 4, `50% crossing should land near score 25, got ${cross.toFixed(1)}`);
});

test('calibrated output beats the base rate it was fitted on', () => {
  // The floor any calibrator must clear: predicting the overall play rate for every song,
  // ignoring the score entirely. Failing this means the map is adding nothing.
  const data = synth();
  const params = fitPlatt(data);
  const base = data.reduce((a, d) => a + d.y, 0) / data.length;
  const calibrated = data.map(d => ({ p: plattProb(params, d.score), y: d.y }));
  const flat = data.map(d => ({ p: base, y: d.y }));
  assert.ok(brier(calibrated) < brier(flat),
    `Brier ${brier(calibrated).toFixed(4)} must beat base rate ${brier(flat).toFixed(4)}`);
  assert.ok(logLoss(calibrated) < logLoss(flat), 'log loss must beat the base rate too');
});

test('a one-class sample degrades to the base rate instead of diverging', () => {
  // Early in a walk-forward there may be a handful of shows and no negative examples yet.
  // Maximum likelihood there wants A at infinity; a flat, honest base rate is the correct
  // answer and is what keeps the first shows of a backtest from emitting 0.999s.
  const allPositive = Array.from({ length: 20 }, (_, i) => ({ score: i, y: 1 }));
  const params = fitPlatt(allPositive);
  assert.equal(params.degenerate, true);
  const ps = [0, 10, 20].map(s => plattProb(params, s));
  assert.ok(ps.every(p => p > 0.5 && p < 1), 'a one-class fit must be flat and uncertain');
  assert.ok(Math.abs(ps[0] - ps[2]) < 1e-9, 'a degenerate fit must not vary with score');
});

test('separable data does not produce runaway confidence', () => {
  // Nearly everything at the very top of the candidate list gets played, which makes this
  // feature close to separable. Without Platt's target smoothing the fit chases the last
  // scrap of log-loss and reports 0.999 off a few dozen shows.
  const sep = [];
  for (let i = 0; i < 200; i++) sep.push({ score: i < 100 ? -10 : 40, y: i < 100 ? 0 : 1 });
  const params = fitPlatt(sep);
  assert.ok(Number.isFinite(params.A) && Number.isFinite(params.B), 'the fit must stay finite');
  assert.ok(plattProb(params, 40) < 0.999, 'smoothing must hold the top back from certainty');
  assert.ok(plattProb(params, -10) > 0.001);
});

test('reliability reports observed against predicted', () => {
  const data = synth();
  const params = fitPlatt(data);
  const pairs = data.map(d => ({ p: plattProb(params, d.score), y: d.y }));
  const rows = reliability(pairs);
  assert.ok(rows.length >= 3, 'expected several populated buckets');
  for (const r of rows) {
    assert.ok(r.n > 0);
    // Fitted and measured on the same sample, so these should track closely. This is the
    // in-sample check; the walk-forward version in the backtest is the honest one.
    assert.ok(Math.abs(r.predicted - r.observed) < 0.15,
      `bucket ${r.lo}-${r.hi}: predicted ${r.predicted.toFixed(2)} vs observed ${r.observed.toFixed(2)}`);
  }
});

// ---- isotonic: the one that actually ships ----

test('isotonic output never decreases as score rises', () => {
  // Same guarantee as Platt, and the same reason it matters: monotonic means it cannot
  // reorder candidates, so the predicted setlist is untouched by calibrating.
  const m = fitIsotonic(synth(), { minBin: 50 });
  let prev = -Infinity;
  for (let s = -30; s <= 60; s += 0.25) {
    const p = isoProb(m, s);
    assert.ok(p >= prev, `p must not decrease as score rises (score ${s})`);
    prev = p;
  }
});

test('isotonic tracks the real shape better than a forced sigmoid', () => {
  // The finding that decided which one ships. Built deliberately non-logistic: the top of
  // the range flattens out instead of continuing up, which is what the real scores do —
  // even the best candidate only plays about a third of the time. Platt cannot represent
  // that and extrapolates confidence it has not earned.
  const data = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 6000; i++) {
    const score = (i % 60);
    const truth = score < 30 ? 0.02 + score * 0.004 : 0.14 + Math.min(0.16, (score - 30) * 0.006);
    data.push({ score, y: rnd() < truth ? 1 : 0 });
  }
  const iso = fitIsotonic(data, { minBin: 100 });
  const platt = fitPlatt(data);
  const worst = pairs => {
    const rows = reliability(pairs);
    return rows.reduce((m, r) => Math.max(m, Math.abs(r.observed - r.predicted)), 0);
  };
  const isoPairs = data.map(d => ({ p: isoProb(iso, d.score), y: d.y }));
  const plattPairs = data.map(d => ({ p: plattProb(platt, d.score), y: d.y }));
  assert.ok(worst(isoPairs) <= worst(plattPairs),
    `isotonic worst bucket ${(worst(isoPairs) * 100).toFixed(1)}pp should not exceed ` +
    `Platt's ${(worst(plattPairs) * 100).toFixed(1)}pp`);
  assert.ok(brier(isoPairs) <= brier(plattPairs), 'isotonic should not be worse on Brier');
});

test('no isotonic bin rests on a handful of samples', () => {
  // The tail of the score range is thin — a few dozen candidate-outcomes out of tens of
  // thousands. Unconstrained, isotonic would report whatever those few did as fact, which is
  // how a 100% bucket built from three shows reaches somebody's screen.
  const m = fitIsotonic(synth(), { minBin: 200 });
  for (const b of m.bins) {
    assert.ok(b.n >= 200 || m.bins.length === 1, `bin at x=${b.x} has only ${b.n} samples`);
  }
});

test('isotonic degrades safely on thin or empty input', () => {
  assert.equal(isoProb(fitIsotonic([]), 10), null);
  assert.equal(isoProb(null, 10), null);
  const tiny = fitIsotonic([{ score: 1, y: 1 }, { score: 2, y: 0 }], { minBin: 100 });
  const p = isoProb(tiny, 1.5);
  assert.ok(p > 0 && p < 1, 'a pooled single-bin fit must still return a usable probability');
});

test('the shipped calibration file matches what the code expects', () => {
  // data/calibration.json is produced by the backtest and read by analyze.js. The two
  // agreeing is not enforced anywhere else, and a shape change would surface as every
  // candidate silently losing its probability.
  const url = new URL('../data/calibration.json', import.meta.url);
  let raw;
  try { raw = JSON.parse(readFileSync(url, 'utf8')); } catch { return; } // not fitted here yet
  assert.equal(raw.method, 'isotonic');
  assert.ok(Array.isArray(raw.bins) && raw.bins.length, 'bins must be a non-empty array');
  let prevX = -Infinity, prevP = -Infinity;
  for (const b of raw.bins) {
    assert.ok(typeof b.x === 'number' && typeof b.p === 'number' && typeof b.n === 'number');
    assert.ok(b.x > prevX, 'bin upper bounds must ascend');
    assert.ok(b.p >= prevP, 'bin probabilities must not decrease');
    assert.ok(b.p >= 0 && b.p <= 1);
    prevX = b.x; prevP = b.p;
  }
  assert.ok(isoProb(raw, 48) > 0 && isoProb(raw, 48) < 1, 'the shipped bins must be usable directly');
});
