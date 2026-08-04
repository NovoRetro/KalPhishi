// How likely a song is to be played tonight given how many CALENDAR DAYS have passed
// since it was last played.
//
// The model's existing recency term counts shows, not days, which cannot tell a
// three-night run apart from three shows spread over a fortnight — very different
// situations for a band that does not repeat within a run. Measured over the 2022+ era
// the day curve is sharp and, notably, NOT monotone:
//
//     0-1 days    0.00%   lift 0.00   (2067 opportunities, zero plays)
//     2-3         0.29%        0.04
//     4-5         2.72%        0.34
//     6-7         7.28%        0.91   <- back to roughly the base rate
//     8-10       13.18%        1.64   <- peak: the rotation window opening
//     11-14      12.38%        1.54
//     15-21      10.33%        1.28
//     22-35      11.48%        1.43
//     36-60      14.08%        1.75   <- "due back up"
//     61-120     12.25%        1.52
//     121+        4.83%        0.60   <- genuinely shelved
//
// So there are three regimes, not one decay: a suppression zone under ~5 days, an
// elevated plateau from ~8 days to ~4 months, and a decline once a song is actually out
// of rotation. A single monotone penalty cannot express that shape.

export const BUCKETS = [
  [0, 1], [2, 3], [4, 5], [6, 7], [8, 10], [11, 14],
  [15, 21], [22, 35], [36, 60], [61, 120], [121, Infinity],
];

export const bucketFor = days => BUCKETS.findIndex(([lo, hi]) => days >= lo && days <= hi);

export const daysBetween = (a, b) => Math.round(Math.abs(new Date(a) - new Date(b)) / 86_400_000);

// Laplace-ish floor. The 0-1 bucket is a true zero in the data, and log(0) is not a
// usable score adjustment — this keeps it merely crushing rather than infinite, and
// stops a thin bucket in a short fitting window from producing a wild multiplier.
const MIN_LIFT = 0.01;

/**
 * Fit the curve from history only.
 *
 * @param {string[]} dates   Chronological show dates, ALL strictly before the target.
 * @param {Map}      setOf   date -> Set of slugs played.
 * @param {object}   opts    warmup: shows to skip before collecting; trail: how far back
 *                           the candidate universe for each show reaches.
 * @returns {{lift: number[], rate: number[], opps: number[], base: number, n: number}}
 */
export function fitRepeatCurve(dates, setOf, { warmup = 30, trail = 30 } = {}) {
  const opps = BUCKETS.map(() => 0);
  const hits = BUCKETS.map(() => 0);
  let totOpp = 0, totHit = 0;

  for (let i = warmup; i < dates.length; i++) {
    const target = dates[i];
    // Candidate universe: anything played in the trailing window, with the date of its
    // most recent play. A song outside this window has no meaningful "days since" to
    // condition on at this scale.
    const lastPlay = new Map();
    for (const d of dates.slice(Math.max(0, i - trail), i)) {
      for (const s of setOf.get(d)) lastPlay.set(s, d);
    }
    const played = setOf.get(target);
    for (const [slug, d] of lastPlay) {
      const bi = bucketFor(daysBetween(target, d));
      if (bi < 0) continue;
      opps[bi]++;
      totOpp++;
      if (played.has(slug)) { hits[bi]++; totHit++; }
    }
  }

  const base = totOpp ? totHit / totOpp : 0;
  const rate = opps.map((o, i) => (o ? hits[i] / o : base));
  const lift = rate.map(r => (base ? Math.max(r / base, MIN_LIFT) : 1));
  return { lift, rate, opps, base, n: totOpp };
}

// Score adjustment for a candidate, in the model's own additive units. Multiplicative
// evidence enters an additive score as a log, so k scales how much the curve is allowed
// to move a song relative to the existing terms.
export function repeatAdjustment(curve, days, k) {
  const bi = bucketFor(days);
  if (bi < 0) return 0;
  return k * Math.log(curve.lift[bi]);
}

// Buckets whose measured lift is negligible. Used by the hard-exclusion variant: at
// 0-3 days this is not a soft preference, it is something the band essentially never does.
export const isSuppressed = (curve, days, threshold = 0.1) => {
  const bi = bucketFor(days);
  return bi >= 0 && curve.lift[bi] < threshold;
};
