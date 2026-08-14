// How likely a song is to be played tonight given how long it has been RELATIVE TO ITS OWN
// cadence — elapsed days divided by that song's median day-gap.
//
// This is not a replacement for lib/dayrepeat.mjs and must not be read as one. The two
// condition on different things and measure differently shaped effects:
//
//   dayrepeat (absolute)  0-1 days -> lift 0.00.  Nothing repeats two nights running. This
//                         is a fact about the band, identical for every song.
//   hazard    (relative)  r < 0.25 -> lift 0.41.  Soon FOR THIS SONG. Fifteen days is soon
//                         for a song that comes round every sixty and overdue for one that
//                         comes round every eight, and the absolute curve cannot tell those
//                         apart because it sees the same fifteen days in both.
//
// What this DOES replace is the hand-tuned dueness term in model.mjs:
//
//     const due = s.currentGap / s.medianInterval;              // in SHOWS
//     if (due >= 0.8 && due <= 3) score += Math.min(due, 2) * 6;
//     if (due > 4 && s.freq > 0.1) score -= 3;
//
// Same idea, three problems. It counts SHOWS, so it cannot tell a three-night run from three
// shows across a fortnight — the exact argument that moved the recency term to days. Its
// five constants were chosen by hand. And it is silent over two whole stretches of the range:
// a song at 0.5x its cadence and one at 3.5x both score nothing, while the measured curve
// says those are lift 0.97 and lift 1.66 — a song at 3.5x is nearly twice as likely as base.
//
// Measured over the 2022+ era, ~25k opportunities, base rate 10.5%:
//
//     r < 0.25     4.25%   lift 0.41
//     0.25 - 0.5  15.04%        1.44
//     0.5 - 0.75  10.14%        0.97
//     0.75 - 1    11.82%        1.13
//     1 - 1.5     14.10%        1.35
//     1.5 - 2     18.01%        1.72
//     2 - 3       20.43%        1.95   <- peak
//     3 - 5       17.40%        1.66
//     5+          19.10%        1.82
//
// The 0.25-0.5 bump is real and is not noise (n=2506). It is the second night of a run
// behaving differently from the first, showing up here because a run compresses r.
//
// ---------------------------------------------------------------------------------------
// MEASURED. PROMISING. NOT SHIPPED AS THE DEFAULT — and the reason is worth reading before
// anyone promotes it, because the obvious reading of these numbers is too generous.
//
// At the tuned k=2, over the same 174 shows:
//
//   arm                                precision   recall   hits/show
//   MODEL top-N (no slot logic)           30.1%     28.5%      5.12
//   MODEL fitted dueness, no slot logic   30.9%     29.2%      5.25
//
// Against the naive baseline it is the strongest arm ever measured here: +5.01pp, z 4.47,
// ahead of the shipping model's +3.45pp at z 2.82. That comparison is real and is the one
// the Nerd Zone table reports.
//
// Against its OWN closest comparator it is not established:
//
//   modelDuenessTopN vs modelTopN   +0.75pp  se 0.61pp  z 1.23   57 better / 64 tied / 53 worse
//
// z 1.23 does not clear the |z| >= 2 bar this repo applies to everything else, so the curve
// is not demonstrably better than the hand-tuned band it replaces. It is merely not worse,
// while being fitted rather than chosen.
//
// THE TRAP, and it caught this experiment first time round. Tuned by the standard protocol —
// choose k on shows through 2024, confirm on the 78 after — it reports +1.95pp at z 2.25 and
// prints CONFIRMED. That protocol assumes the held-out shows are exchangeable with training.
// Here they are not: they are a LATER PERIOD, and the effect is time-varying.
//
//   year    modelTopN   +fitted dueness    gain
//   2023      29.0%          29.5%        +0.5pp
//   2024      30.4%          29.0%        -1.4pp
//   2025      27.8%          29.6%        +1.7pp
//   2026      26.1%          28.4%        +2.3pp
//
// The held-out window IS the stretch where the effect is positive, so the confirmation is
// confounded with the drift the diagnostics already document: as the rotation churns faster,
// a curve refitted at every show gains on constants fixed by hand years ago. That is a
// plausible mechanism and a genuinely interesting hypothesis. It is not a confirmed finding,
// and the only honest test of it is the next period, not this one re-sliced.
// ---------------------------------------------------------------------------------------

import { daysBetween } from './dayrepeat.mjs';

// Ratio buckets. Finer below 1 than above it, because that is where the decision is: the
// difference between 0.2x and 0.8x of a song's cadence is the difference between "they just
// played it" and "it is about due", while 3x and 5x are both simply "overdue".
export const RATIO_BUCKETS = [
  [0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.0],
  [1.0, 1.5], [1.5, 2.0], [2.0, 3.0], [3.0, 5.0], [5.0, Infinity],
];

export const ratioBucketFor = r => RATIO_BUCKETS.findIndex(([lo, hi]) => r >= lo && r < hi);

// Below this a song has too few gaps for a median to mean anything, and it gets no
// adjustment at all rather than a guess. Three plays give two gaps; four give three, which
// is the fewest where a median is not simply one of two arbitrary numbers.
export const MIN_PLAYS_FOR_CADENCE = 4;

const MIN_LIFT = 0.01;

export function medianOf(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Each song's median gap between plays, in calendar days.
 *
 * @param {Map<string,string[]>} playDates  slug -> play dates, ascending.
 * @returns {Map<string,number>} slug -> median day gap. Songs under the play threshold are
 *   absent rather than present with a guess, so callers must handle "no cadence known".
 */
export function cadenceOf(playDates) {
  const out = new Map();
  for (const [slug, dates] of playDates) {
    if (dates.length < MIN_PLAYS_FOR_CADENCE) continue;
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i], dates[i - 1]));
    const m = medianOf(gaps);
    if (m > 0) out.set(slug, m);
  }
  return out;
}

/**
 * Fit the relative-time curve from history only.
 *
 * Walks the same shape as fitRepeatCurve: for each historical show past the warmup, every
 * song played in the trailing window is one opportunity, scored by whether it appeared.
 *
 * Cadence is recomputed only when a song is actually played, and cached otherwise. Without
 * that this is a median over a growing array per candidate per show per fit — and the fit
 * itself runs once per target in the walk-forward, so the cost compounds three deep.
 *
 * @param {string[]} dates  Chronological show dates, ALL strictly before the target.
 * @param {Map}      setOf  date -> Set of slugs played.
 * @returns {{lift:number[], rate:number[], opps:number[], base:number, n:number}}
 */
export function fitRelativeCurve(dates, setOf, { warmup = 40, trail = 30 } = {}) {
  const opps = RATIO_BUCKETS.map(() => 0);
  const hits = RATIO_BUCKETS.map(() => 0);
  let totOpp = 0, totHit = 0;

  const playDates = new Map();   // slug -> ascending play dates seen so far
  const cadence = new Map();     // slug -> median day gap, recomputed only on a play

  for (let i = 0; i < dates.length; i++) {
    const target = dates[i];

    if (i >= warmup) {
      // Candidate universe: anything played in the trailing window, with its latest play.
      const lastPlay = new Map();
      for (const d of dates.slice(Math.max(0, i - trail), i)) {
        for (const s of setOf.get(d)) lastPlay.set(s, d);
      }
      const played = setOf.get(target);
      for (const [slug, d] of lastPlay) {
        const med = cadence.get(slug);
        if (!med) continue; // no cadence known — contributes nothing rather than a guess
        const bi = ratioBucketFor(daysBetween(target, d) / med);
        if (bi < 0) continue;
        opps[bi]++;
        totOpp++;
        if (played.has(slug)) { hits[bi]++; totHit++; }
      }
    }

    // Fold tonight in, AFTER scoring it, so no opportunity is ever judged using its own
    // outcome. Same discipline as the model's leakage guard, one level down.
    for (const slug of setOf.get(target) || []) {
      if (!playDates.has(slug)) playDates.set(slug, []);
      const list = playDates.get(slug);
      list.push(target);
      if (list.length >= MIN_PLAYS_FOR_CADENCE) {
        const gaps = [];
        for (let j = 1; j < list.length; j++) gaps.push(daysBetween(list[j], list[j - 1]));
        const m = medianOf(gaps);
        if (m > 0) cadence.set(slug, m);
      }
    }
  }

  const base = totOpp ? totHit / totOpp : 0;
  const rate = opps.map((o, i) => (o ? hits[i] / o : base));
  const lift = rate.map(r => (base ? Math.max(r / base, MIN_LIFT) : 1));
  return { lift, rate, opps, base, n: totOpp };
}

/**
 * Score adjustment, in the model's additive units. Multiplicative evidence enters an
 * additive score as a log, matching repeatAdjustment().
 *
 * Returns 0 when the song has no known cadence, which is the whole point of the threshold:
 * a song with three plays gets the population day curve and nothing else, rather than a
 * dueness verdict derived from two gaps.
 */
export function relativeAdjustment(curve, days, cadenceDays, k) {
  if (!curve || !cadenceDays || !Number.isFinite(days)) return 0;
  const bi = ratioBucketFor(days / cadenceDays);
  if (bi < 0) return 0;
  return k * Math.log(curve.lift[bi]);
}
