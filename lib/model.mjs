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
 * @param {string}   recency        'shows' (default, production behaviour) applies the
 *                                  show-gap proximity penalties. 'off' omits them so an
 *                                  experiment can substitute a different recency signal
 *                                  without double-counting. Only the proximity terms are
 *                                  affected — tour saturation and the absent-this-tour
 *                                  bonus describe rotation, not recency, and always apply.
 */
export function buildModel({ rows, target, tourName, venueSongCounts = new Map(), scheduleRows = [], recency = 'shows' }) {
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

  for (const s of songs.values()) {
    const idxs = [...new Set(s.plays)].map(d => showIndex.get(d)).sort((a, b) => a - b);
    s.playCount = idxs.length;
    s.freq = idxs.length / totalShows;
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

  const scored = [];
  for (const s of songs.values()) {
    if (s.freq < 0.03 && !venueSongCounts.has(s.slug)) continue;
    const t = tourSongs.get(s.slug);
    const lastTourIdx = t ? tourShowIdx.get([...new Set(t.dates)].sort().pop()) : null;
    const gapAtNext = t ? nextShowTourIdx - lastTourIdx : null;

    let score = 0;
    const why = [];

    // base rotation strength
    score += s.freq * 30;

    // dueness vs personal cadence
    if (s.medianInterval) {
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

    // venue affinity
    if (venueSongCounts.has(s.slug)) { score += 2.5 * venueSongCounts.get(s.slug); why.push(`played at ${target.venue} ${venueSongCounts.get(s.slug)}x before`); }

    // leg-end jam intensity — quiet nudge, no why-string
    if (legEndWindow) score += (s.jamRate || 0) * 10;

    scored.push({
      slug: s.slug, name: s.name, score: +score.toFixed(1), why,
      eraFreq: +s.freq.toFixed(3), currentGap: s.currentGap,
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
