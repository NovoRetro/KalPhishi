// The prediction model, extracted from scripts/analyze.js so that analyze.js (which
// predicts the *next* show) and scripts/backtest.js (which re-predicts every past show)
// run literally the same code. A backtest against a copy of the model is worthless — the
// copy drifts, and then the measured accuracy describes something that isn't shipping.
//
// Everything here is pure: it reads the rows it is handed and returns a result. It does
// no file IO and knows nothing about "now", so the caller is fully responsible for
// passing only rows the model is allowed to have seen. That is the whole leakage
// contract, and buildModel() enforces its half of it by throwing (see `target.date`).

import { isNearTourGap, isResetVenue } from './tourleg.mjs';
import { fitRepeatCurve, repeatAdjustment, daysBetween } from './dayrepeat.mjs';
import { fitBetaPrior, shrunkRate, opportunityWindows } from './shrinkage.mjs';
import { fitRelativeCurve, cadenceOf, relativeAdjustment } from './hazard.mjs';

// Weight on the day-repeat curve, in the score's own units. Chosen on shows through
// 2024 only, by the one-standard-error rule: the training curve plateaus from about k=5
// to k=30, so the smallest k statistically indistinguishable from the peak wins, which
// assumes least. Confirmed afterwards on the 78 shows from 2025 on that took no part in
// choosing it: recall 24.7% -> 27.2%, +2.57pp paired, se 0.83pp, z 3.08.
// Reproduce with: npm run backtest -- --tune
export const DAY_CURVE_K = 5;

// Weight on the fitted dueness curve, in the score's own units, when dueness is 'fitted'.
// Same role DAY_CURVE_K plays for the absolute curve: the two are multiplicative evidence
// entering an additive score as logs, so this scales how far dueness may move a song against
// the other terms.
//
// Chosen on the 96 shows through 2024 only, by the one-standard-error rule — the training
// curve peaks at k=3 and is flat either side, so the smallest k indistinguishable from the
// peak wins, which assumes least. Confirmed afterwards on the 78 shows from 2025 on that
// took no part in choosing it: 29.1% recall against modelTopN's 27.1%, +1.95pp paired,
// se 0.87pp, z 2.25.
//
// Reproduce with: npm run backtest -- --tune-dueness
export const DUENESS_K = 2;

// Weight on the era lens. DECLARED, NOT TUNED — and that distinction is the whole point. An
// accuracy sweep picks k=0 for eras 1.0 and 2.0 and k=0.5 for 3.0, because none of them beats
// the shipping model, so the accuracy-optimal weight is "switch it off". There is no optimum
// to find here and tuning it would be theatre.
//
// 3 is the smallest whole weight at which the lens visibly re-ranks in every era — it changes
// 6.45 / 4.85 / 3.19 of the 17 predicted songs for 1.0 / 2.0 / 3.0 — while leaving all four
// slot pools non-empty. For scale: the base `freq * 30` term has sd 1.74 across the pool and
// the centred era term has sd 2.63 / 1.37 / 1.51, so k=3 gives era roughly two to four times
// the base term's voice. Deliberately loud: a lens that whispers is indistinguishable from the
// model it exists to contrast with, which defeats the point of offering it.
export const ERA_K = 3;

// The curve needs a stretch of history behind it before its buckets mean anything.
// Below this the model simply skips the term rather than scoring on a curve fitted to
// a handful of shows.
const MIN_SHOWS_FOR_CURVE = 40;

export const MIN_PLAYS_FOR_JAMRATE = 5; // below this, a song's jam-chart rate is noise, not signal
export const RESET_VENUE_PENALTY_SCALE = 0.3;
export const MIN_SET_PLAYS = 6;
export const SET_LEAN = 0.7;

export function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// The canonical row filter. Phish only, no excluded rows, no soundchecks ('s'), sorted
// chronologically then by position within the show. Both entry points use this so a
// backtest can never accidentally score against a differently-shaped row set.
export function prepareRows(rawRows) {
  return rawRows
    .filter(r => r.artistid === 1 && !r.exclude && r.set !== 's')
    .sort((a, b) => a.showdate.localeCompare(b.showdate) || a.position - b.position);
}

// Why-strings surface on hover in the dashboard, so these say what the gap is and which
// way it cuts rather than quoting the arithmetic behind it.
function dayGapReason(days, adj) {
  const ago = days === 1 ? 'yesterday' : `${days} days ago`;
  if (adj < 0) {
    return days <= 5
      ? `played ${ago} — almost never repeats this soon`
      : `${days} days since last — outside the usual repeat window`;
  }
  return `${days} days since last — in the repeat window`;
}

/**
 * Score every candidate song and assemble a slot-aware predicted setlist.
 *
 * @param {object[]} rows           Already run through prepareRows(). MUST contain only
 *                                  shows strictly before target.date.
 * @param {object}   target         { date, venue, venueid } of the show being predicted.
 * @param {string}   tourName       Tour whose rotation forms the horizontal slice.
 * @param {Map}      venueSongCounts slug -> times played at this venue, historically.
 * @param {object[]} scheduleRows   Forward schedule, for tour-leg-gap detection. Not a
 *                                  leak: tour dates are announced well in advance.
 * @param {string}   recency        Which recency signal to score on.
 *                                  'days'  (default) — the measured day-repeat curve.
 *                                  'shows' — the older show-gap penalties, kept so the
 *                                            backtest can still show the before/after.
 *                                  'off'   — neither, for experiments that supply their
 *                                            own recency term and must not double-count.
 *                                  Only the proximity terms are affected — tour saturation
 *                                  and the absent-this-tour bonus describe rotation, not
 *                                  recency, and always apply.
 * @param {number}   dayCurveK      Weight on the day curve when recency is 'days'.
 * @param {string}   freqEstimator  How the base rotation rate is estimated.
 *                                  'raw'    (default) — plays / totalShows, as shipped.
 *                                  'shrunk' — plays over each song's OWN availability
 *                                             window, shrunk toward a fitted Beta prior.
 *                                             See lib/shrinkage.mjs for why neither half
 *                                             of that works without the other.
 * @param {string}   dueness        How "overdue against its own habit" is scored.
 *                                  'tuned'  (default) — the hand-picked show-based band.
 *                                  'fitted' — a measured hazard on elapsed days over the
 *                                             song's own median day-gap. Replaces the
 *                                             tuned term rather than joining it; the two
 *                                             score the same idea. See lib/hazard.mjs.
 * @param {number}   duenessK       Weight on that curve when dueness is 'fitted'.
 * @param {string}   era            What-if lens: re-rank by prevalence in a past Phish era.
 *                                  'off' (default), '1.0', '2.0' or '3.0'. There is no '4.0'
 *                                  and there must never be one — it overlaps the graded
 *                                  window and would leak invisibly. See scripts/build-eras.js.
 * @param {number}   eraK           Weight on the era lens. Declared, not tuned — see ERA_K.
 * @param {object}   eraRates       The era table from data/eras.json, supplied by the caller.
 *                                  Required when era is not 'off'; buildModel throws without
 *                                  it rather than degrading to a silent no-op.
 */
export function buildModel({
  rows, target, tourName, venueSongCounts = new Map(), scheduleRows = [],
  recency = 'days', dayCurveK = DAY_CURVE_K, freqEstimator = 'raw',
  dueness = 'tuned', duenessK = DUENESS_K,
  era = 'off', eraK = ERA_K, eraRates = null,
}) {
  // Hard leakage guard. A backtest that quietly includes the show it is predicting will
  // report spectacular accuracy and mean nothing, and the failure is invisible in the
  // output — so it fails loudly here instead.
  const leaked = rows.filter(r => r.showdate >= target.date);
  if (leaked.length) {
    throw new Error(
      `buildModel: ${leaked.length} row(s) dated on/after the target show ${target.date} ` +
      `(first: ${leaked[0].showdate} ${leaked[0].slug}). The caller must filter these out.`
    );
  }

  const showDates = [...new Set(rows.map(r => r.showdate))].sort();
  const showIndex = new Map(showDates.map((d, i) => [d, i]));
  const totalShows = showDates.length;

  // ---- per-song aggregation over the era window
  const songs = new Map();
  for (const r of rows) {
    if (!songs.has(r.slug)) {
      songs.set(r.slug, { slug: r.slug, name: r.song, plays: [], sets: [] });
    }
    const s = songs.get(r.slug);
    s.plays.push(r.showdate);
    s.sets.push(r.set);
  }

  // Position of each row within its own set, for opener/closer detection. Held in a
  // side map rather than assigned onto the rows: the backtest calls this function
  // hundreds of times over overlapping slices of one shared array, and mutating the
  // rows would let one iteration's state bleed into the next.
  const setPos = new Map();
  const bySet = new Map();
  for (const r of rows) {
    const key = `${r.showdate}|${r.set}`;
    if (!bySet.has(key)) bySet.set(key, []);
    bySet.get(key).push(r);
  }
  for (const list of bySet.values()) {
    list.sort((a, b) => a.position - b.position);
    list.forEach((r, i) => setPos.set(r, { pos: i, len: list.length }));
  }

  // ---- slot stats per song
  for (const r of rows) {
    const s = songs.get(r.slug);
    if (!s.slots) s.slots = { s1open: 0, s2open: 0, closer: 0, encore: 0, set1: 0, set2: 0, total: 0 };
    const { pos, len } = setPos.get(r);
    s.slots.total++;
    if (r.set === '1' && pos === 0) s.slots.s1open++;
    if (r.set === '2' && pos === 0) s.slots.s2open++;
    if ((r.set === '1' || r.set === '2' || r.set === '3') && pos === len - 1) s.slots.closer++;
    if (r.set === 'e' || r.set === 'e2') s.slots.encore++;
    // Plain set-1 vs set-2 counts. Many songs are effectively set-exclusive (Stash 38/38
    // set 1, Light 33/33 set 2), which the opener/closer stats above don't capture — they
    // only describe the edges of a set, not which set a song belongs in at all.
    if (r.set === '1') s.slots.set1++;
    if (r.set === '2') s.slots.set2++;
    if (r.isjamchart === 1) s.jamchartPlays = (s.jamchartPlays || 0) + 1;
  }

  // Frequency estimator. Fitted from the same rows the model is allowed to see, so it
  // inherits the leakage guard above rather than needing one of its own.
  //
  // `freq` is used in TWO places — the score's base term and the candidate-pool gate below
  // — and this deliberately changes both. Gating on the raw rate while scoring on the shrunk
  // one would exclude precisely the songs this estimator exists to rescue: a bustout back in
  // rotation is under the 0.03 gate on its era-wide rate no matter what the score would have
  // made of it.
  let prior = null;
  let windows = null;
  if (freqEstimator === 'shrunk') {
    windows = opportunityWindows(showDates, new Map([...songs.values()].map(s => [s.slug, new Set(s.plays)])));
    prior = fitBetaPrior([...windows.values()]);
  }

  for (const s of songs.values()) {
    const idxs = [...new Set(s.plays)].map(d => showIndex.get(d)).sort((a, b) => a - b);
    s.playCount = idxs.length;
    s.freq = idxs.length / totalShows;
    if (windows) {
      // Kept alongside rather than discarded: the raw rate is what every other part of this
      // file's output means by "how often", and the dashboard prints it.
      s.rawFreq = s.freq;
      const w = windows.get(s.slug);
      if (w) s.freq = shrunkRate(w.k, w.n, prior);
    }
    s.intervals = idxs.slice(1).map((v, i) => v - idxs[i]);
    s.medianInterval = median(s.intervals);
    s.lastPlayed = s.plays[s.plays.length - 1];
    s.currentGap = totalShows - 1 - showIndex.get(s.lastPlayed);
    // Share of a song's performances that phish.net's editors flagged as jam-chart-worthy
    // (an extended/notable jam) — how reliably it "goes big" when it's played at all,
    // independent of how often it gets played.
    s.jamRate = s.playCount >= MIN_PLAYS_FOR_JAMRATE ? (s.jamchartPlays || 0) / s.playCount : 0;
  }

  // ---- HORIZONTAL SLICE: the tour in progress
  const tourRows = rows.filter(r => r.tourname === tourName);
  const tourShows = [...new Set(tourRows.map(r => r.showdate))].sort();
  const tourSongs = new Map();
  for (const r of tourRows) {
    if (!tourSongs.has(r.slug)) tourSongs.set(r.slug, { slug: r.slug, name: r.song, dates: [], sets: [] });
    const t = tourSongs.get(r.slug);
    t.dates.push(r.showdate);
    t.sets.push(r.set);
  }

  const tourShowIdx = new Map(tourShows.map((d, i) => [d, i]));
  const intraTourGaps = [];
  for (const t of tourSongs.values()) {
    const uniq = [...new Set(t.dates)].map(d => tourShowIdx.get(d)).sort((a, b) => a - b);
    for (let i = 1; i < uniq.length; i++) intraTourGaps.push(uniq[i] - uniq[i - 1]);
  }
  const medianRepeatGap = median(intraTourGaps) ?? 4;
  const nextShowTourIdx = tourShows.length; // index the upcoming show would occupy

  // ---- PREDICTION SCORING
  const legEndWindow = isNearTourGap(target.date, scheduleRows);
  const nextShowIsResetVenue = isResetVenue(target.venue);
  const lastTourShow = tourShows[tourShows.length - 1];
  const playedAtLastTourShow = new Set(tourRows.filter(r => r.showdate === lastTourShow).map(r => r.slug));

  // Days since a song was last played predicts far better than shows since, because it
  // separates a three-night run from three shows spread over a fortnight. Fitted from the
  // same history the model is allowed to see, so it inherits the leakage guard above.
  const useDayCurve = recency === 'days';
  const duenessFitted = dueness === 'fitted';
  let curve = null;
  let relCurve = null;
  let cadenceDays = null;
  if ((useDayCurve || duenessFitted) && showDates.length >= MIN_SHOWS_FOR_CURVE) {
    const playedOn = new Map(showDates.map(d => [d, new Set()]));
    for (const r of rows) playedOn.get(r.showdate).add(r.slug);
    if (useDayCurve) curve = fitRepeatCurve(showDates, playedOn, { warmup: 30, trail: 30 });
    if (duenessFitted) {
      // Fitted on the same history, so it inherits the leakage guard rather than needing
      // its own. Conditions on elapsed-over-own-cadence, which is a different quantity from
      // the absolute curve above — see the header of lib/hazard.mjs for why both can apply.
      relCurve = fitRelativeCurve(showDates, playedOn, { warmup: 40, trail: 30 });
      cadenceDays = cadenceOf(new Map(
        [...songs.values()].map(s => [s.slug, [...new Set(s.plays)].sort()]),
      ));
    }
  }

  // The candidate pool, hoisted out of the scoring loop so the era lens below has an explicit
  // set to centre over. Membership is byte-identical to the `continue` this replaces — it is
  // the same predicate, negated.
  const candidates = [...songs.values()].filter(s => s.freq >= 0.03 || venueSongCounts.has(s.slug));

  // ---- era lens ----
  //
  // A what-if, not an attempt to predict better: it re-ranks by how often each song turned up
  // in a chosen past era. Every era offered has ENDED before the first graded backtest target,
  // so the table is a constant across the whole walk-forward — see scripts/build-eras.js for
  // the leakage argument and for why there is no 4.0.
  //
  // CENTRING IS STRUCTURAL, NOT COSMETIC, and must not be "simplified" away. Subtracting the
  // pool's mean log-rate cannot reorder anything — it shifts every candidate by one constant —
  // but it is the only thing keeping the term from dragging the whole score distribution
  // negative. Measured over 174 shows: centred, every era at k=3/5/8 leaves all four slot
  // pools non-empty; UNCENTRED, era 1.0 at k=5 empties the opener pool on 44 shows and the
  // encore pool on 7. That is the one way the `score > 0` gates in assembleSetlist can
  // actually bite (they are otherwise inert — deleting all four changes nothing).
  let eraAdj = null;
  if (era !== 'off') {
    const table = eraRates && eraRates[era];
    // Throwing beats degrading. A missing table would silently make this a no-op and the arm
    // would report the shipping model's accuracy under an era's name.
    if (!table || !table.rates) throw new Error(`buildModel: era '${era}' requested but no rates were supplied`);
    const logRate = s => Math.log(table.rates[s.slug] ?? table.absentRate);
    const mean = candidates.length
      ? candidates.reduce((a, s) => a + logRate(s), 0) / candidates.length
      : 0;
    eraAdj = new Map(candidates.map(s => [s.slug, {
      adj: eraK * (logRate(s) - mean),
      rate: table.rates[s.slug] ?? null,
    }]));
  }

  const scored = [];
  for (const s of candidates) {
    const t = tourSongs.get(s.slug);
    const lastTourIdx = t ? tourShowIdx.get([...new Set(t.dates)].sort().pop()) : null;
    const gapAtNext = t ? nextShowTourIdx - lastTourIdx : null;

    let score = 0;
    const why = [];

    // base rotation strength
    score += s.freq * 30;

    // dueness vs personal cadence
    //
    // The two branches are alternatives, never both: they score the same idea — overdue
    // against this song's own habit — and applying them together would count it twice.
    if (duenessFitted) {
      const cad = cadenceDays ? cadenceDays.get(s.slug) : null;
      const days = daysBetween(target.date, s.lastPlayed);
      const adj = relativeAdjustment(relCurve, days, cad, duenessK);
      if (adj) {
        score += adj;
        const ratio = days / cad;
        why.push(ratio < 0.5
          ? `${days} days since last — soon for a song that comes round every ~${Math.round(cad)}`
          : `${days} days since last — ${ratio.toFixed(1)}x its own ~${Math.round(cad)}-day cadence`);
      }
    } else if (s.medianInterval) {
      const due = s.currentGap / s.medianInterval;
      if (due >= 0.8 && due <= 3) { score += Math.min(due, 2) * 6; why.push(`due (${s.currentGap} shows since last, cadence ~${s.medianInterval})`); }
      if (due > 4 && s.freq > 0.1) { score -= 3; why.push('possibly shelved'); }
    }

    // tour recency penalties — softened at reset venues
    const recencyScale = nextShowIsResetVenue ? RESET_VENUE_PENALTY_SCALE : 1;
    const useShowGap = recency === 'shows';
    if (t && gapAtNext !== null) {
      if (useShowGap) {
        if (gapAtNext <= 2) { score -= 15 * recencyScale; why.push(`just played ${t.dates[t.dates.length - 1]}`); }
        else if (gapAtNext <= 3) { score -= 6 * recencyScale; why.push('played recently this tour'); }
        else { score += 3; why.push(`tour repeat window open (gap ${gapAtNext})`); }
      }
      if ([...new Set(t.dates)].length >= 3) { score -= 5; why.push('already 3+ tour plays'); }
    } else {
      if (s.freq >= 0.15) { score += 8; why.push('conspicuously absent this tour'); }
    }
    if (useShowGap && playedAtLastTourShow.has(s.slug)) { score -= 10; }

    if (curve) {
      const days = daysBetween(target.date, s.lastPlayed);
      const adj = repeatAdjustment(curve, days, dayCurveK);
      if (adj) {
        score += adj;
        why.push(dayGapReason(days, adj));
      }
    }

    // Era lens, sitting with the other two k*log(lift) terms rather than apart from them.
    if (eraAdj) {
      const e = eraAdj.get(s.slug);
      if (e && e.adj) {
        score += e.adj;
        why.push(e.rate === null
          ? `never played in ${era}`
          : `played ${(e.rate * 100).toFixed(0)}% of ${era} shows`);
      }
    }

    // venue affinity
    if (venueSongCounts.has(s.slug)) { score += 2.5 * venueSongCounts.get(s.slug); why.push(`played at ${target.venue} ${venueSongCounts.get(s.slug)}x before`); }

    // leg-end jam intensity — quiet nudge, no why-string
    if (legEndWindow) score += (s.jamRate || 0) * 10;

    scored.push({
      slug: s.slug, name: s.name, score: +score.toFixed(1), why,
      windowFreq: +s.freq.toFixed(3), currentGap: s.currentGap,
      medianInterval: s.medianInterval, tourPlays: t ? [...new Set(t.dates)].length : 0,
      lastTourPlay: t ? [...new Set(t.dates)].sort().pop() : null,
      slots: s.slots,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  return {
    showDates, showIndex, totalShows,
    songs, tourRows, tourShows, tourSongs, tourShowIdx,
    intraTourGaps, medianRepeatGap, nextShowTourIdx,
    legEndWindow, nextShowIsResetVenue,
    scored,
    prediction: assembleSetlist(scored, target),
  };
}

// Set placement. Songs lean hard here — of 137 songs with enough set-1/set-2 plays to
// judge, 91 lean at least 70% one way, and plenty are effectively set-exclusive. Without
// this, set 1 and set 2 were both filled from the same score-ranked list, which put
// set-1-only songs (555, Stash) into set 2 purely because they scored well.
//
// Applied as an exclusion of strong contradictions rather than a hard split: a song only
// gets blocked from a set if its record clearly says it doesn't go there, so score still
// drives ordering everywhere else. Songs without enough plays to judge stay eligible for
// both — no evidence isn't the same as evidence of no lean.
export function assembleSetlist(scored, target) {
  function pick(pool, n, used, slotFilter) {
    const out = [];
    for (const c of pool) {
      if (out.length >= n) break;
      if (used.has(c.slug)) continue;
      if (slotFilter && !slotFilter(c)) continue;
      used.add(c.slug);
      out.push(c);
    }
    return out;
  }
  const set1Rate = c => {
    if (!c.slots) return null;
    const n = c.slots.set1 + c.slots.set2;
    return n >= MIN_SET_PLAYS ? c.slots.set1 / n : null;
  };
  const fitsSet = (c, which) => {
    const r = set1Rate(c);
    if (r === null) return true;
    return which === 1 ? r > 1 - SET_LEAN : r < SET_LEAN;
  };
  const notEncoreSong = c => !c.slots || c.slots.encore / c.slots.total < 0.5;

  // ---- what `c.score > 0` in the four pools below actually does ----
  //
  // Measured over 174 shows, because the repo documented the opposite for months and two
  // separate pieces of work were shaped around avoiding a hazard that does not exist.
  //
  // These gates are INERT in the direction people worry about. `scored` is sorted descending
  // and pick() walks a pool from the FRONT taking one or two entries, so a `> 0` filter can
  // only ever remove candidates from the BOTTOM of a list nothing was going to reach.
  // Deleting all four outright changes the predicted setlist on 0 of 174 shows — despite an
  // average of 41 candidates per show scoring <= 0. So "a new term has no negatives, therefore
  // the gates go vacuous, therefore the setlist changes silently" is backwards: vacuous gates
  // provably change nothing.
  //
  // They bind in exactly ONE way, and only downward: if a term pushes scores far enough
  // negative to EMPTY a pool, the `pool.length ? pool : scored` fallbacks fire and that slot
  // is filled from the whole ranked list instead. Measured, shifting every score down by 10
  // moves 10 of 174 shows; by 20, it moves 121 and costs about a point of recall.
  //
  // So the real constraint on any new scoring term is: do not drag the distribution negative.
  // That is why the era lens above is centred on the pool mean — uncentred, era 1.0 at k=5
  // empties this opener pool on 44 shows. Centring is the guard; the gates are not.
  const used = new Set();
  const openerPool = scored.filter(c => c.slots && c.slots.s1open / c.slots.total > 0.2 && c.score > 0 && fitsSet(c, 1));
  const opener = pick(openerPool.length ? openerPool : scored, 1, used);
  const set1mid = pick(scored, 6, used, c => notEncoreSong(c) && fitsSet(c, 1));
  const closerPool = scored.filter(c => c.slots && c.slots.closer / c.slots.total > 0.25 && c.score > 0);
  const set1close = pick(closerPool.filter(c => fitsSet(c, 1)).length ? closerPool.filter(c => fitsSet(c, 1)) : scored, 1, used);
  const s2openPool = scored.filter(c => c.slots && c.slots.s2open / c.slots.total > 0.15 && c.score > 0 && fitsSet(c, 2));
  const set2open = pick(s2openPool.length ? s2openPool : scored, 1, used);
  const set2mid = pick(scored, 5, used, c => notEncoreSong(c) && fitsSet(c, 2));
  const set2close = pick(closerPool.filter(c => fitsSet(c, 2)).length ? closerPool.filter(c => fitsSet(c, 2)) : scored, 1, used);
  const encorePool = scored.filter(c => c.slots && c.slots.encore / c.slots.total > 0.3 && c.score > 0);
  const encore = pick(encorePool.length ? encorePool : scored, 2, used);

  const strip = c => ({ name: c.name, slug: c.slug, score: c.score, why: c.why });
  return {
    show: target,
    set1: [...opener, ...set1mid, ...set1close].map(strip),
    set2: [...set2open, ...set2mid, ...set2close].map(strip),
    encore: encore.map(strip),
  };
}
