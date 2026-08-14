// The naive baselines the model is measured against.
//
// These exist to answer "is the model doing anything?" — the honest floor for setlist
// prediction is "play the songs they have been playing lately", and anything that cannot
// beat that is not earning its complexity.
//
// Extracted from scripts/backtest.js so that scripts/analyze.js can publish these rankings
// from the SAME code that produced the accuracy numbers printed beside them. Two
// implementations would be two chances to drift, and the drift would be invisible: a
// baseline ranking that disagrees slightly with the precision figure under it still looks
// entirely reasonable.

/** date -> Set of slugs played that night. Built once; the baselines read it per target. */
export function setsByDate(rows) {
  const setOf = new Map();
  for (const r of rows) {
    if (!setOf.has(r.showdate)) setOf.set(r.showdate, new Set());
    setOf.get(r.showdate).add(r.slug);
  }
  return setOf;
}

/**
 * Two baselines over the trailing window.
 *
 * @param {Map<string,Set<string>>} setOf      from setsByDate()
 * @param {string[]} priorDates                sorted show dates STRICTLY before the target
 * @param {string}   targetDate                the show being predicted
 * @param {number}   trail                     how many shows back to count over
 * @returns {{trail:string[], recentlyPlayed:Set<string>, freq:string[], freqNoRepeat:string[]}}
 *   `freq` — most-played across the window, most first.
 *   `freqNoRepeat` — the same order, minus anything played within 3 days of the target.
 */
export function trailingFrequency(setOf, priorDates, targetDate, { trail = 30 } = {}) {
  const window = priorDates.slice(-trail);

  const tally = new Map();
  for (const d of window) for (const s of setOf.get(d) || []) tally.set(s, (tally.get(s) || 0) + 1);
  // Tie-broken by slug so the ranking is deterministic. Without it the order of equally
  // played songs depends on Map insertion, which depends on the order rows were read —
  // and a baseline that shuffles between runs cannot be compared to anything.
  const freq = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(e => e[0]);

  // Calendar days, not shows: this baseline is meant to capture "they just played it", and
  // two shows on consecutive nights are much closer than two shows a fortnight apart.
  const recentlyPlayed = new Set();
  for (const d of window) {
    const days = (new Date(targetDate) - new Date(d)) / 86_400_000;
    if (days <= 3) for (const s of setOf.get(d) || []) recentlyPlayed.add(s);
  }

  return {
    trail: window,
    recentlyPlayed,
    freq,
    freqNoRepeat: freq.filter(s => !recentlyPlayed.has(s)),
  };
}
