// Estimating how often a song gets played, when songs have not all been available equally
// long.
//
// MEASURED AND NOT SHIPPED. Kept for the same reason lib/calibration.mjs keeps fitPlatt: it
// is the record of something principled that did not work, so the next person does not
// re-derive it from scratch. It has no menu entry, and should not get one unless the numbers
// below change. Walk-forward over the same 174 shows as everything else:
//
//   arm                                  precision   recall   hits/show
//   MODEL (shipping)                        29.3%     27.7%      4.98
//   MODEL shrunk rate (own window)          29.0%     27.4%      4.94
//   MODEL top-N (no slot logic)             30.1%     28.5%      5.12
//   MODEL shrunk rate, no slot logic        29.7%     28.2%      5.06
//
// Paired directly against its own unshrunk twin, which is the only comparison that matters
// because the two arms are otherwise identical:
//
//   modelShrunk     vs model      -0.24pp  se 0.32pp  z -0.76   33 better / 104 tied / 37 worse
//   modelShrunkTopN vs modelTopN  -0.34pp  se 0.29pp  z -1.16   25 better / 120 tied / 29 worse
//
// Not distinguishable from chance, trending slightly negative, in both shapes. For scale the
// day curve shipped on +2.57pp at z 3.08.
//
// WHY it failed is the useful part, and it generalises. The estimator reorders 322 of 342
// songs, yet 104 of 174 shows score exactly the same — because it moves the tail, not the
// top. Songs played 40-60 times in the era have nearly identical era-wide and own-window
// rates (they differ by about 5%), so the top 17 barely changes. What it does move is the
// thin end: bustouts and returns, whose rate the common denominator genuinely understates.
//
// But those are the same songs the reachability diagnostic counts as unreachable — 2.13 a
// night — and they are rare precisely BECAUSE they do not come back soon. Ranking them more
// accurately does not help, because the accurate answer is still "probably not tonight". A
// better frequency estimate cannot buy recall at the top of a list it does not change, so
// future work should attack the top of the ranking rather than the estimate feeding it.
//
// The shipping model uses plays / totalShows. That is the right estimator only if every song
// could have been played at every show, and 53 of 342 songs in the era window first appear
// past its halfway point — debuts, and bustouts returning after years away. For those the
// common denominator understates badly: `devotion-to-a-dream` reads 0.0140 across the era and
// 0.0536 across the stretch it has actually been in rotation.
//
// Two corrections are needed and NEITHER works alone:
//
//   1. Count each song over its own window. Without this a song in rotation for 40 shows is
//      scored as though it had been passed over for 214.
//   2. Shrink toward a prior fitted from the whole population. Without this correction 1 is
//      far worse than the bug it fixes — a song played twice in the three shows since it came
//      back reads 0.67 and outranks everything the band actually plays.
//
// Shrinkage alone, on a COMMON denominator, is not worth doing and is not offered here:
// (k + a) / (n + a + b) is affine in k, so it cannot reorder anything. Applied to this model
// its only effect is rescaling the frequency term from freq*30 to an effective freq*28.2 plus
// a constant shared by every candidate. That is a hyperparameter nudge, not a model.
//
// The prior is fitted by method of moments rather than by maximum likelihood. With a few
// hundred songs the two agree closely, and MoM has no iteration to fail to converge — which
// matters because this runs inside the walk-forward, once per historical show.

/** Prior mean when the population is too degenerate to fit one. */
const FALLBACK = { alpha: 1, beta: 19, degenerate: true };

/**
 * Fit Beta(alpha, beta) to a population of per-song rates by method of moments.
 *
 * @param {{k:number, n:number}[]} obs  plays and opportunities per song.
 * @returns {{alpha:number, beta:number, mean:number, strength:number, degenerate?:boolean}}
 *   `strength` is alpha+beta, readable as "how many shows' worth of evidence the prior is
 *   worth" — the number that decides how hard a thin song gets pulled back.
 */
export function fitBetaPrior(obs) {
  // A song with no opportunities carries no information about the population; including it
  // would be dividing by zero to learn nothing.
  const rates = obs.filter(o => o.n > 0).map(o => o.k / o.n);
  if (rates.length < 2) return { ...FALLBACK, mean: FALLBACK.alpha / (FALLBACK.alpha + FALLBACK.beta) };

  const m = rates.reduce((a, b) => a + b, 0) / rates.length;
  const v = rates.reduce((a, b) => a + (b - m) ** 2, 0) / rates.length;

  // Beyond this range the moment equations give a negative concentration, which is not a
  // Beta distribution. It means the spread is wider than any Beta can produce — real when a
  // population is bimodal — so fall back rather than emit nonsense parameters.
  if (v <= 0 || v >= m * (1 - m) || m <= 0 || m >= 1) {
    return { ...FALLBACK, mean: FALLBACK.alpha / (FALLBACK.alpha + FALLBACK.beta) };
  }

  const strength = (m * (1 - m)) / v - 1;
  return { alpha: m * strength, beta: (1 - m) * strength, mean: m, strength };
}

/**
 * Posterior mean rate for one song.
 *
 * With n = 0 this returns the prior mean, which is the point: a song that debuted at the most
 * recent show has produced no evidence about what it does NEXT, and the honest estimate is
 * "whatever an unknown song does".
 */
export function shrunkRate(k, n, prior) {
  if (!prior) return n > 0 ? k / n : 0;
  return (k + prior.alpha) / (n + prior.alpha + prior.beta);
}

/**
 * Per-song opportunity windows, counted from the show AFTER each song's first appearance.
 *
 * Excluding the debut show itself is what keeps this unbiased. Counted inclusively, every
 * song has by construction been played at least once in its own window, so a song that
 * debuted last night reads 1-for-1 and every debut is born at the top of the rankings.
 * Conditioning on "it has appeared, now what does it do" removes that by construction rather
 * than by a correction factor.
 *
 * @param {string[]} showDates    every show in the window, sorted.
 * @param {Map<string,Set<string>>} playedOn  slug -> set of dates it was played.
 * @returns {Map<string,{k:number,n:number}>}
 */
export function opportunityWindows(showDates, playedOn) {
  const index = new Map(showDates.map((d, i) => [d, i]));
  const out = new Map();
  for (const [slug, dates] of playedOn) {
    const idxs = [...dates].map(d => index.get(d)).filter(i => i != null).sort((a, b) => a - b);
    if (!idxs.length) continue;
    const first = idxs[0];
    out.set(slug, {
      k: idxs.length - 1,                       // plays after the debut
      n: showDates.length - 1 - first,          // shows available after the debut
    });
  }
  return out;
}
