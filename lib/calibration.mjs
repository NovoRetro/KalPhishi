// Turning a model score into a probability.
//
// `score` in model.mjs is an unnormalised tally: base freq*30, plus and minus a set of
// hand-tuned adjustments. It ranks well and means nothing in itself — 44.1 is not "twice as
// likely" as 22, the units are arbitrary, and two shows' scores are not comparable. This
// maps it onto [0,1] against what actually happened.
//
// Platt scaling: a logistic regression on the single feature `score`, so exactly two
// parameters. It is MONOTONIC by construction, which is the property that makes it safe to
// add here — it cannot reorder candidates, so the predicted setlist, precision and recall
// are all untouched. The only thing that changes is the number attached to each song.
//
// Fitted with the Newton + line-search formulation from Lin, Weng & Lin (2007) rather than
// the 1999 original, for its two practical fixes: the log-sum-exp branch below avoids
// exp() overflowing on the wide score range, and the line search stops the step from
// diverging on separable data — which this nearly is, since almost nothing at the very top
// of the list fails to get played.
//
// The +1/+2 target smoothing is Platt's own and is not optional here. With raw 0/1 targets
// and a strongly separable feature the fit runs A off to infinity to squeeze the last
// fraction of log-loss, producing confident 0.99s off a handful of shows. Smoothing pulls
// the targets in by an amount that vanishes as the sample grows.

const MAX_ITER = 100;
const MIN_STEP = 1e-10;
const SIGMA = 1e-12;   // Hessian ridge, so a degenerate fit cannot divide by zero
const TOL = 1e-5;

// log(1 + exp(x)), without overflowing for large positive x.
const log1pExp = x => (x >= 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x)));

/**
 * Fit score -> probability on labelled outcomes.
 *
 * @param {{score:number, y:(0|1|boolean)}[]} samples  One per candidate per historical show.
 * @returns {{A:number, B:number, n:number, pos:number}} p = 1 / (1 + exp(A*score + B)).
 *   A comes out NEGATIVE for a feature that predicts positively, so a higher score is a
 *   higher probability.
 */
export function fitPlatt(samples) {
  const deci = [], label = [];
  for (const s of samples) {
    if (!Number.isFinite(s.score)) continue;
    deci.push(s.score);
    label.push(s.y ? 1 : 0);
  }
  const n = deci.length;
  const pos = label.reduce((a, b) => a + b, 0);
  const neg = n - pos;
  // Nothing to learn from one class alone: the maximum-likelihood answer is the base rate,
  // and returning it as a flat fit is more honest than an A of +/-Infinity.
  if (!n || !pos || !neg) {
    const base = n ? (pos + 1) / (n + 2) : 0.5;
    return { A: 0, B: Math.log((1 - base) / base), n, pos, degenerate: true };
  }

  const hi = (pos + 1) / (pos + 2);
  const lo = 1 / (neg + 2);
  const t = label.map(l => (l ? hi : lo));

  let A = 0;
  let B = Math.log((neg + 1) / (pos + 1));

  const objective = (a, b) => {
    let f = 0;
    for (let i = 0; i < n; i++) {
      const fApB = deci[i] * a + b;
      // Same value either way; the branch is only about which exp() is safe to take.
      f += fApB >= 0
        ? t[i] * fApB + log1pExp(-fApB)
        : (t[i] - 1) * fApB + log1pExp(fApB);
    }
    return f;
  };

  let fval = objective(A, B);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let h11 = SIGMA, h22 = SIGMA, h21 = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < n; i++) {
      const fApB = deci[i] * A + B;
      let p, q;
      if (fApB >= 0) {
        const e = Math.exp(-fApB);
        p = e / (1 + e); q = 1 / (1 + e);
      } else {
        const e = Math.exp(fApB);
        p = 1 / (1 + e); q = e / (1 + e);
      }
      const d2 = p * q;
      h11 += deci[i] * deci[i] * d2;
      h22 += d2;
      h21 += deci[i] * d2;
      const d1 = t[i] - p;
      g1 += deci[i] * d1;
      g2 += d1;
    }
    if (Math.abs(g1) < TOL && Math.abs(g2) < TOL) break;

    const det = h11 * h22 - h21 * h21;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    const gd = g1 * dA + g2 * dB;

    let step = 1;
    let moved = false;
    while (step >= MIN_STEP) {
      const nA = A + step * dA;
      const nB = B + step * dB;
      const nf = objective(nA, nB);
      if (nf < fval + 1e-4 * step * gd) { A = nA; B = nB; fval = nf; moved = true; break; }
      step /= 2;
    }
    // Line search exhausted: already at the optimum to within floating point.
    if (!moved) break;
  }

  return { A, B, n, pos };
}

/** p = 1 / (1 + exp(A*score + B)). Clamped away from the endpoints — see below. */
export function plattProb(params, score) {
  if (!params || !Number.isFinite(score)) return null;
  const z = params.A * score + params.B;
  const p = z >= 0 ? Math.exp(-z) / (1 + Math.exp(-z)) : 1 / (1 + Math.exp(z));
  // Never exactly 0 or 1. A model that has seen 174 shows has not earned certainty about
  // a band that improvises, and a hard 0 makes log-loss infinite the first time it is wrong.
  return Math.min(0.999, Math.max(0.001, p));
}

// ---- isotonic regression (pool-adjacent-violators) ----
//
// Platt assumes the relationship between score and probability is a logistic curve. Measured
// against 145 walk-forward shows, it is not: Platt's Brier and log loss both beat the base
// rate, and its reliability was still badly overconfident above ~20% — 74.6% predicted
// against 35.0% observed. Better aggregate numbers, useless probabilities, which is the
// exact failure this whole exercise exists to catch.
//
// Isotonic regression assumes only that the relationship is non-decreasing and fits whatever
// shape the data actually has. It is still monotonic, so it still cannot reorder candidates.
// The cost is variance in thin regions, which is what MIN_BIN is for: the top of the score
// range holds a few dozen samples out of 31,000, and an unconstrained fit there would report
// whatever those few did as gospel.
const MIN_BIN = 250;

function pav(blocks) {
  const stack = [];
  for (const b of blocks) {
    let cur = { x: b.x, sum: b.sum, n: b.n };
    while (stack.length && stack[stack.length - 1].sum / stack[stack.length - 1].n >= cur.sum / cur.n) {
      const prev = stack.pop();
      cur = { x: cur.x, sum: prev.sum + cur.sum, n: prev.n + cur.n };
    }
    stack.push(cur);
  }
  return stack;
}

/**
 * Fit a monotonic step function from score to probability.
 * @returns {{bins:{x:number,p:number,n:number}[], n:number}} x is each bin's upper bound.
 */
export function fitIsotonic(samples, { minBin = MIN_BIN } = {}) {
  const pts = samples.filter(s => Number.isFinite(s.score)).sort((a, b) => a.score - b.score);
  if (!pts.length) return { bins: [], n: 0 };

  // Identical scores must share a bin, or the fit would claim to tell them apart.
  const blocks = [];
  for (const s of pts) {
    const y = s.y ? 1 : 0;
    const last = blocks[blocks.length - 1];
    if (last && last.x === s.score) { last.sum += y; last.n += 1; }
    else blocks.push({ x: s.score, sum: y, n: 1 });
  }

  let bins = pav(blocks);
  // Fold anything too thin into its neighbour and re-pool, so no bin's probability rests on
  // a handful of shows. Repeated because a merge can create a new violation.
  for (let guard = 0; guard < 50; guard++) {
    const i = bins.findIndex(b => b.n < minBin);
    if (i < 0) break;
    const j = i + 1 < bins.length ? i + 1 : i - 1;
    if (j < 0) break;
    const merged = { x: Math.max(bins[i].x, bins[j].x), sum: bins[i].sum + bins[j].sum, n: bins[i].n + bins[j].n };
    bins.splice(Math.min(i, j), 2, merged);
    bins = pav(bins);
  }
  return { bins: bins.map(b => ({ x: b.x, p: b.sum / b.n, n: b.n })), n: pts.length };
}

/** Look up a score on the fitted step function. Clamped, for the same reason plattProb is. */
export function isoProb(model, score) {
  if (!model || !model.bins || !model.bins.length || !Number.isFinite(score)) return null;
  const { bins } = model;
  let p = bins[bins.length - 1].p;
  for (const b of bins) {
    if (score <= b.x) { p = b.p; break; }
  }
  return Math.min(0.999, Math.max(0.001, p));
}

/** Mean squared error of probability against outcome. Lower is better; 0.25 is a coin flip. */
export function brier(pairs) {
  if (!pairs.length) return null;
  let s = 0;
  for (const { p, y } of pairs) s += (p - (y ? 1 : 0)) ** 2;
  return s / pairs.length;
}

/** Mean negative log-likelihood. Punishes confident mistakes far harder than Brier does. */
export function logLoss(pairs) {
  if (!pairs.length) return null;
  let s = 0;
  for (const { p, y } of pairs) s += y ? -Math.log(p) : -Math.log(1 - p);
  return s / pairs.length;
}

/**
 * Observed frequency against predicted probability, bucketed. This is the whole point of
 * calibrating: of everything called 60%, roughly 60% should have happened. Ranking metrics
 * cannot see this at all — a model can rank perfectly and still be wildly overconfident.
 */
export function reliability(pairs, buckets = 10) {
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets, hi = (b + 1) / buckets;
    const inBucket = pairs.filter(x => x.p >= lo && (b === buckets - 1 ? x.p <= hi : x.p < hi));
    if (!inBucket.length) continue;
    out.push({
      lo, hi,
      n: inBucket.length,
      predicted: inBucket.reduce((a, x) => a + x.p, 0) / inBucket.length,
      observed: inBucket.reduce((a, x) => a + (x.y ? 1 : 0), 0) / inBucket.length,
    });
  }
  return out;
}
