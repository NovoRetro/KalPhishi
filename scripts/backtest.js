// Walk-forward backtest. For every show in the era window, re-predict it using only the
// shows that came before it, then grade against what was actually played.
//
// Why this exists: the live track record grows by one show per concert, so tuning the
// model against it would take years, and a single graded show cannot distinguish a good
// model from a lucky one. This replays the whole era instead — ~200 graded predictions
// in a few seconds.
//
// This is a development tool and its output is deliberately NOT the public track record.
// Backtested predictions are made with hindsight available in ways the live model never
// had (see LEAKAGE NOTES below), and publishing them as if they were real calls would
// inflate the record with shows the model never actually predicted. data/backtest.json is
// gitignored; data/archive/*.json remains the only source for the public record.
//
// Usage:
//   node scripts/backtest.js                 # full era window
//   node scripts/backtest.js --from 2025-01-01
//   node scripts/backtest.js --n 17 --json
//
// LEAKAGE NOTES — what the backtest can and cannot see:
//   * Setlist rows are hard-filtered to showdate < target, and lib/model.mjs throws if
//     any survive. This is the guarantee that matters.
//   * The forward schedule IS visible. That is not leakage: tour dates are announced
//     months ahead, so the live model knows them too.
//   * Venue history uses the same cached per-venue files production reads, filtered to
//     shows before the target — so it reaches back past the 2022 era window (Fenway's
//     2009 and 2019 stands, for instance). Those files only exist for venues fetch.js has
//     visited; everywhere else it falls back to in-window rows, which UNDERSTATES venue
//     affinity. The report prints the coverage split so this is never invisible.
//   * songs.json (all-time gap / times_played) is never consulted. It reflects fetch
//     time, so using it would be reading the future. The model does not score on it.

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const load = n => JSON.parse(fs.readFileSync(path.join(dataDir, `${n}.json`), 'utf8'));

const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const FROM = arg('--from', '0000-00-00');
const TO = arg('--to', '9999-99-99');
const N = +arg('--n', 17);          // prediction budget, matching the model's 8 + 7 + 2
const WARMUP = +arg('--warmup', 40); // era shows required before we start grading
const TRAIL = +arg('--trail', 30);   // baseline lookback window, in shows
const WRITE_JSON = argv.includes('--json');
const EXPERIMENTS = argv.includes('--experiments');
// Score-unit weights for the day-repeat curve, tested side by side. The curve supplies
// multiplicative evidence; k decides how loudly it speaks next to the existing terms.
const K_VALUES = [3, 6, 10];

// ---------------------------------------------------------------- metrics

function grade(predictedSlugs, actualSet) {
  const uniq = [...new Set(predictedSlugs)];
  const hits = uniq.filter(s => actualSet.has(s));
  return {
    predicted: uniq.length,
    actual: actualSet.size,
    hits: hits.length,
    precision: uniq.length ? hits.length / uniq.length : 0,
    recall: actualSet.size ? hits.length / actualSet.size : 0,
    hitSlugs: hits,
  };
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = x => (x * 100).toFixed(1) + '%';

// Paired comparison against a reference arm. Reporting a bare mean difference invites
// reading noise as signal, so this also gives the standard error and the share of shows
// won — with ~200 paired observations, a difference under about 2 standard errors is
// not distinguishable from chance.
function paired(armVals, refVals) {
  const d = armVals.map((v, i) => v - refVals[i]);
  const m = mean(d);
  const sd = Math.sqrt(mean(d.map(x => (x - m) ** 2)) * (d.length / Math.max(1, d.length - 1)));
  const se = sd / Math.sqrt(d.length);
  return {
    delta: m,
    se,
    z: se ? m / se : 0,
    winRate: d.filter(x => x > 0).length / d.length,
    ties: d.filter(x => x === 0).length / d.length,
  };
}

// ---------------------------------------------------------------- main

(async () => {
const { prepareRows, buildModel } = await import('../lib/model.mjs');
const { fitRepeatCurve, repeatAdjustment, isSuppressed, daysBetween, BUCKETS } =
  await import('../lib/dayrepeat.mjs');

const years = [2022, 2023, 2024, 2025, 2026];
let rawRows = [];
for (const y of years) rawRows.push(...load(`setlists-${y}`));
const rows = prepareRows(rawRows);

let scheduleRows = [];
for (const y of years) {
  try { scheduleRows.push(...load(`schedule-${y}`)); } catch { /* not fetched */ }
}

const showDates = [...new Set(rows.map(r => r.showdate))].sort();
const rowsByDate = new Map();
for (const r of rows) {
  if (!rowsByDate.has(r.showdate)) rowsByDate.set(r.showdate, []);
  rowsByDate.get(r.showdate).push(r);
}
const setOf = new Map(showDates.map(d => [d, new Set(rowsByDate.get(d).map(r => r.slug))]));

// Venue history, mirroring the vertical slice in analyze.js: the cached per-venue show
// list plus each of those shows' cached setlists. Built once per venue and filtered per
// target, since the files are the same for every show at that venue.
const venueCache = new Map();
function venueHistory(venueid) {
  if (venueCache.has(venueid)) return venueCache.get(venueid);
  let entries = null;
  try {
    const dates = load(`shows-venue-${venueid}`).filter(s => s.artistid === 1).map(s => s.showdate).sort();
    entries = [];
    for (const d of dates) {
      try {
        const rs = load(`setlist-${d}`).filter(r => r.artistid === 1 && r.set !== 's');
        entries.push({ date: d, slugs: rs.map(r => r.slug) });
      } catch { /* that show's setlist isn't cached */ }
    }
  } catch { entries = null; } // no cache for this venue at all
  venueCache.set(venueid, entries);
  return entries;
}

const arms = {
  model: [],        // full model: score + slot-aware assembly
  modelTopN: [],    // same scores, but just take the top N — isolates the slot logic
  freq: [],         // baseline A: most-played in the trailing window
  freqNoRepeat: [], // baseline B: same, minus anything played in the last 3 days
};
if (EXPERIMENTS) {
  arms.dayHard = [];                              // model + hard-drop suppressed buckets
  for (const k of K_VALUES) arms[`dayCurve${k}`] = []; // model + curve, on top of show-gap
  for (const k of K_VALUES) arms[`dayOnly${k}`] = [];  // curve INSTEAD of show-gap
}
const perShow = [];
const venueCoverage = { cache: 0, 'in-window': 0 };
let skipped = 0;

for (let i = 0; i < showDates.length; i++) {
  const target = showDates[i];
  if (i < WARMUP) continue;
  if (target < FROM || target > TO) continue;

  const targetRows = rowsByDate.get(target);
  const meta = targetRows[0];
  const actual = setOf.get(target);
  if (!actual.size) { skipped++; continue; }

  // Everything the model is allowed to see.
  const history = rows.filter(r => r.showdate < target);
  const priorDates = showDates.slice(0, i);

  // Venue history: cached per-venue files where available (matching production), else
  // in-window rows (see LEAKAGE NOTES).
  const venueSongCounts = new Map();
  const cachedVenue = venueHistory(meta.venueid);
  const venueSource = cachedVenue ? 'cache' : 'in-window';
  if (cachedVenue) {
    for (const e of cachedVenue) {
      if (e.date >= target) continue;
      for (const s of e.slugs) venueSongCounts.set(s, (venueSongCounts.get(s) || 0) + 1);
    }
  } else {
    for (const r of history) {
      if (r.venueid === meta.venueid) venueSongCounts.set(r.slug, (venueSongCounts.get(r.slug) || 0) + 1);
    }
  }
  venueCoverage[venueSource]++;

  let M;
  try {
    M = buildModel({
      rows: history,
      target: { date: target, venue: meta.venue, city: [meta.city, meta.state].filter(Boolean).join(', '), venueid: meta.venueid },
      tourName: meta.tourname,
      venueSongCounts,
      scheduleRows,
    });
  } catch (e) {
    console.error(`  ${target}: model failed — ${e.message}`);
    skipped++;
    continue;
  }

  const predSlugs = [...M.prediction.set1, ...M.prediction.set2, ...M.prediction.encore].map(s => s.slug);
  const topNSlugs = M.scored.slice(0, N).map(c => c.slug);

  // Baselines, computed from the same history.
  const trail = priorDates.slice(-TRAIL);
  const freqTally = new Map();
  for (const d of trail) for (const s of setOf.get(d)) freqTally.set(s, (freqTally.get(s) || 0) + 1);
  const byFreq = [...freqTally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0]);

  const recentlyPlayed = new Set();
  for (const d of trail) {
    const days = (new Date(target) - new Date(d)) / 86_400_000;
    if (days <= 3) for (const s of setOf.get(d)) recentlyPlayed.add(s);
  }

  const g = {
    model: grade(predSlugs, actual),
    modelTopN: grade(topNSlugs, actual),
    freq: grade(byFreq.slice(0, N), actual),
    freqNoRepeat: grade(byFreq.filter(s => !recentlyPlayed.has(s)).slice(0, N), actual),
  };

  if (EXPERIMENTS) {
    // The curve is refitted from history at every step, so it never sees the show it is
    // being used to predict — the same discipline as the model itself.
    const curve = fitRepeatCurve(priorDates, setOf, { warmup: 30, trail: TRAIL });

    // Days since each candidate's most recent play, over all available history.
    const lastPlay = new Map();
    for (const d of priorDates) for (const s of setOf.get(d)) lastPlay.set(s, d);
    const daysFor = slug => (lastPlay.has(slug) ? daysBetween(target, lastPlay.get(slug)) : Infinity);

    const rerank = (list, k) => [...list]
      .map(c => ({ slug: c.slug, s: c.score + repeatAdjustment(curve, daysFor(c.slug), k) }))
      .sort((a, b) => b.s - a.s || a.slug.localeCompare(b.slug))
      .slice(0, N).map(c => c.slug);

    g.dayHard = grade(
      M.scored.filter(c => !isSuppressed(curve, daysFor(c.slug))).slice(0, N).map(c => c.slug),
      actual,
    );
    for (const k of K_VALUES) g[`dayCurve${k}`] = grade(rerank(M.scored, k), actual);

    // Replacement arm: the show-gap penalty off, the day curve in its place.
    const Moff = buildModel({
      rows: history,
      target: { date: target, venue: meta.venue, venueid: meta.venueid },
      tourName: meta.tourname,
      venueSongCounts,
      scheduleRows,
      recency: 'off',
    });
    for (const k of K_VALUES) g[`dayOnly${k}`] = grade(rerank(Moff.scored, k), actual);
  }

  for (const k of Object.keys(arms)) arms[k].push(g[k]);

  // Slot accuracy for the model arm — the one thing the baselines structurally cannot do.
  const bySet = {};
  for (const r of targetRows) (bySet[r.set] = bySet[r.set] || []).push(r);
  for (const k in bySet) bySet[k].sort((a, b) => a.position - b.position);
  const actualOpener = bySet['1']?.[0]?.slug ?? null;
  const actualS2Opener = bySet['2']?.[0]?.slug ?? null;
  const actualEncore = new Set([...(bySet['e'] || []), ...(bySet['e2'] || [])].map(r => r.slug));

  // How much of tonight was even reachable: songs with no play in the trailing window
  // cannot be predicted by any rotation-based approach, so they cap recall.
  const trailSongs = new Set();
  for (const d of trail) for (const s of setOf.get(d)) trailSongs.add(s);
  const unreachable = [...actual].filter(s => !trailSongs.has(s)).length;

  perShow.push({
    date: target, venue: meta.venue, tour: meta.tourname,
    actualSize: actual.size,
    arms: Object.fromEntries(Object.keys(arms).map(k => [k, { p: g[k].precision, r: g[k].recall, hits: g[k].hits }])),
    slots: {
      opener: actualOpener ? M.prediction.set1[0]?.slug === actualOpener : null,
      s2opener: actualS2Opener ? M.prediction.set2[0]?.slug === actualS2Opener : null,
      encoreOverlap: actualEncore.size ? M.prediction.encore.some(e => actualEncore.has(e.slug)) : null,
    },
    unreachable,
    reachableCeiling: actual.size ? (actual.size - unreachable) / actual.size : 0,
  });
}

// ---------------------------------------------------------------- report

if (!perShow.length) {
  console.error('no shows graded — check --from/--to/--warmup');
  process.exit(1);
}

const LABELS = {
  model: 'MODEL (score + slot assembly)',
  modelTopN: 'MODEL top-N (no slot logic)',
  freq: `baseline: top-${N} by trailing-${TRAIL} frequency`,
  freqNoRepeat: `baseline: same, minus played <=3d ago`,
};
if (EXPERIMENTS) {
  LABELS.dayHard = 'EXP day-repeat: drop suppressed buckets';
  for (const k of K_VALUES) LABELS[`dayCurve${k}`] = `EXP day-curve k=${k} (on top of show-gap)`;
  for (const k of K_VALUES) LABELS[`dayOnly${k}`] = `EXP day-curve k=${k} (replacing show-gap)`;
}
const ARM_ORDER = ['model', 'modelTopN', 'freqNoRepeat', 'freq',
  ...(EXPERIMENTS ? ['dayHard', ...K_VALUES.map(k => `dayCurve${k}`), ...K_VALUES.map(k => `dayOnly${k}`)] : [])];

console.log(`\nWalk-forward backtest — ${perShow.length} shows graded` +
  (skipped ? ` (${skipped} skipped)` : '') +
  `\nwindow ${perShow[0].date} .. ${perShow[perShow.length - 1].date}` +
  `  |  budget ${N} songs/show  |  mean actual set size ${mean(perShow.map(s => s.actualSize)).toFixed(1)}\n`);

const W = Math.max(...Object.values(LABELS).map(s => s.length));
console.log('ARM'.padEnd(W), 'PRECISION'.padStart(10), 'RECALL'.padStart(9), 'HITS/SHOW'.padStart(11));
console.log('-'.repeat(W + 32));
for (const k of ARM_ORDER) {
  const a = arms[k];
  console.log(
    LABELS[k].padEnd(W),
    pct(mean(a.map(x => x.precision))).padStart(10),
    pct(mean(a.map(x => x.recall))).padStart(9),
    mean(a.map(x => x.hits)).toFixed(2).padStart(11),
  );
}

const ref = EXPERIMENTS ? 'model' : 'freqNoRepeat';
console.log(`\nPaired vs "${LABELS[ref]}" (recall):`);
for (const k of ARM_ORDER.filter(a => a !== ref)) {
  const p = paired(arms[k].map(x => x.recall), arms[ref].map(x => x.recall));
  const verdict = Math.abs(p.z) < 2 ? 'not distinguishable from chance'
    : p.delta > 0 ? 'BETTER' : 'WORSE';
  console.log(
    `  ${k.padEnd(14)} delta ${(p.delta * 100 >= 0 ? '+' : '') + (p.delta * 100).toFixed(2)}pp` +
    `  se ${(p.se * 100).toFixed(2)}pp  z ${p.z.toFixed(2)}` +
    `  wins ${pct(p.winRate)}  ties ${pct(p.ties)}   ${verdict}`
  );
}

if (EXPERIMENTS) {
  // Fitted over the whole window purely for display — the arms above each used a curve
  // refitted from history at their own step.
  const full = fitRepeatCurve(showDates, setOf, { warmup: 30, trail: TRAIL });
  console.log(`\nDay-repeat curve (whole window, base rate ${pct(full.base)} per candidate-show, n=${full.n}):`);
  console.log('  DAYS SINCE LAST'.padEnd(20), 'OPPS'.padStart(7), 'RATE'.padStart(8), 'LIFT'.padStart(7));
  BUCKETS.forEach(([lo, hi], i) => {
    if (!full.opps[i]) return;
    const label = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
    console.log(`  ${label}`.padEnd(20), String(full.opps[i]).padStart(7),
      pct(full.rate[i]).padStart(8), full.lift[i].toFixed(2).padStart(7));
  });
}

const slotStat = key => {
  const vals = perShow.map(s => s.slots[key]).filter(v => v !== null);
  return vals.length ? `${pct(vals.filter(Boolean).length / vals.length)} (${vals.filter(Boolean).length}/${vals.length})` : 'n/a';
};
console.log('\nModel slot accuracy:');
console.log('  show opener   ', slotStat('opener'));
console.log('  set 2 opener  ', slotStat('s2opener'));
console.log('  encore overlap', slotStat('encoreOverlap'));

console.log('\nRecall ceiling:');
console.log(`  mean share of each show reachable from the trailing ${TRAIL} shows: ${pct(mean(perShow.map(s => s.reachableCeiling)))}`);
console.log(`  mean unpredictable songs per show: ${mean(perShow.map(s => s.unreachable)).toFixed(2)}`);

// Per-year breakdown catches a model that is only good on the era it was hand-tuned
// against — the weights were chosen while looking at 2026, so 2026 doing well and the
// earlier years doing badly would be overfitting, not skill.
// With experiments on, the interesting question is whether the winning variant holds up
// across eras — a gain concentrated in one year is a tuned constant, not a finding.
const YEAR_REF = EXPERIMENTS ? `dayOnly${K_VALUES[1]}` : 'freqNoRepeat';
console.log(`\nBy year (recall) — MODEL vs ${YEAR_REF}:`);
const yrs = [...new Set(perShow.map(s => s.date.slice(0, 4)))].sort();
console.log('  YEAR  SHOWS'.padEnd(16), 'MODEL'.padStart(8), YEAR_REF.toUpperCase().padStart(12), 'GAIN'.padStart(8));
for (const y of yrs) {
  const sub = perShow.filter(s => s.date.startsWith(y));
  const m = mean(sub.map(s => s.arms.model.r)), b = mean(sub.map(s => s.arms[YEAR_REF].r));
  console.log(
    `  ${y}  ${String(sub.length).padStart(4)}`.padEnd(16),
    pct(m).padStart(8), pct(b).padStart(12),
    // Signed so positive always means "the comparison arm beat the model".
    (((b - m) * 100 >= 0 ? '+' : '') + ((b - m) * 100).toFixed(1) + 'pp').padStart(8),
  );
}

console.log('\nVenue-slice coverage:');
console.log(`  ${venueCoverage.cache} shows used cached full venue history (as production does),` +
  ` ${venueCoverage['in-window']} fell back to 2022+ rows only.`);
if (venueCoverage['in-window']) {
  console.log('  Fallback shows give the model a weaker venue signal than it has in production.');
}

if (WRITE_JSON) {
  const outPath = path.join(dataDir, 'backtest.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    params: { N, WARMUP, TRAIL, FROM, TO },
    summary: Object.fromEntries(Object.keys(arms).map(k => [k, {
      precision: mean(arms[k].map(x => x.precision)),
      recall: mean(arms[k].map(x => x.recall)),
      hitsPerShow: mean(arms[k].map(x => x.hits)),
    }])),
    perShow,
  }, null, 1));
  console.log(`\nwrote ${outPath} (gitignored — dev artifact, not the public record)`);
}
console.log('');
})().catch(e => { console.error(e); process.exit(1); });
