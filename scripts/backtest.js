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
// --tune sweeps the day-curve weight on a training window and reports the winner's score
// on a window it never saw. Picking k by looking at the whole backtest would be fitting a
// hyperparameter on the test set, which is exactly the mistake this project is trying to
// stop making.
const TUNE = argv.includes('--tune');
const TRAIN_END = arg('--train-end', '2024-12-31');
const EXPERIMENTS = TUNE || argv.includes('--experiments');
// Score-unit weights for the day-repeat curve, tested side by side. The curve supplies
// multiplicative evidence; k decides how loudly it speaks next to the existing terms.
// k=0 is a control: recency off entirely, no curve.
const K_VALUES = TUNE ? [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 60] : [3, 6, 10];
// Same idea for the fitted dueness curve. Swept under --tune-dueness, which also splits
// train/held-out so the winning k is chosen on one set and confirmed on another — picking it
// on all 174 shows and reporting the same number is how a tuned constant looks like a finding.
// DUENESS_K_VALUES needs the model's own default, which arrives with the dynamic import
// below, so the list itself is built there.
const TUNE_DUENESS = argv.includes('--tune-dueness');

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
const { prepareRows, buildModel, DUENESS_K } = await import('../lib/model.mjs');
const DUENESS_K_VALUES = TUNE_DUENESS ? [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20] : [DUENESS_K];
const { fitPlatt, plattProb, fitIsotonic, isoProb, brier, logLoss, reliability } =
  await import('../lib/calibration.mjs');
const { trailingFrequency } = await import('../lib/baselines.mjs');

// Accumulated (score, played) pairs from shows already walked past, the calibrator's only
// training data. Never includes the show being predicted.
const calSamples = [];
// Out-of-sample probabilities and their outcomes, one entry per candidate per target.
const calEval = [];
const calIsoEval = [];
const calBaseEval = [];
const calFits = [];
// Below this the fit is noise — a couple of shows is a few hundred lopsided samples, and
// early wild parameters would drag the reported reliability around for no reason.
const CAL_MIN_SAMPLES = 5000;
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
  model: [],           // production model: score + slot-aware assembly
  modelTopN: [],       // same scores, but just take the top N — isolates the slot logic
  modelShowGap: [],    // the pre-day-curve model, kept so the change stays visible
  modelShrunk: [],     // rotation rate over each song's own window, shrunk to a fitted prior
  modelShrunkTopN: [], // the same, without the slot logic — isolates the estimator from it
  modelDueness: [],     // dueness from a fitted relative-time hazard, not the hand-picked band
  modelDuenessTopN: [], // the same, without the slot logic
  freq: [],            // baseline A: most-played in the trailing window
  freqNoRepeat: [],    // baseline B: same, minus anything played in the last 3 days
};
if (EXPERIMENTS) {
  if (!TUNE) {
    arms.dayHard = [];                                 // model + hard-drop suppressed buckets
    for (const k of K_VALUES) arms[`dayCurve${k}`] = []; // model + curve, on top of show-gap
  }
  for (const k of K_VALUES) arms[`dayOnly${k}`] = [];   // curve INSTEAD of show-gap
}
if (TUNE_DUENESS) for (const k of DUENESS_K_VALUES) arms[`dueK${k}`] = [];
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

  // Baselines, computed from the same history — and from lib/baselines.mjs, which
  // analyze.js also publishes from, so the shipped ranking and the accuracy figure printed
  // beside it can never come from two slightly different implementations.
  const { trail, freq: byFreq, freqNoRepeat } = trailingFrequency(setOf, priorDates, target, { trail: TRAIL });

  const showGap = buildModel({
    rows: history,
    target: { date: target, venue: meta.venue, venueid: meta.venueid },
    tourName: meta.tourname,
    venueSongCounts,
    scheduleRows,
    recency: 'shows',
  });

  // Base rotation rate estimated over each song's own availability window and shrunk toward
  // a fitted prior, instead of plays/totalShows. Everything else is identical to `model`, so
  // the pair isolates the estimator — which is the only way to say whether it earned its place.
  const shrunk = buildModel({
    rows: history,
    target: { date: target, venue: meta.venue, venueid: meta.venueid },
    tourName: meta.tourname,
    venueSongCounts,
    scheduleRows,
    freqEstimator: 'shrunk',
  });

  // Dueness scored from a fitted relative-time hazard instead of the hand-picked band.
  // One model per candidate weight: k scales how far the curve may move a song, and picking
  // it by hand is the thing this arm exists to stop doing.
  const duenessModels = new Map();
  for (const k of DUENESS_K_VALUES) {
    duenessModels.set(k, buildModel({
      rows: history,
      target: { date: target, venue: meta.venue, venueid: meta.venueid },
      tourName: meta.tourname,
      venueSongCounts,
      scheduleRows,
      dueness: 'fitted',
      duenessK: k,
    }));
  }
  const duenessMain = duenessModels.get(DUENESS_K);

  const g = {
    model: grade(predSlugs, actual),
    modelTopN: grade(topNSlugs, actual),
    modelDueness: grade(
      [...duenessMain.prediction.set1, ...duenessMain.prediction.set2, ...duenessMain.prediction.encore].map(s => s.slug),
      actual,
    ),
    modelDuenessTopN: grade(duenessMain.scored.slice(0, N).map(c => c.slug), actual),
    modelShowGap: grade(
      [...showGap.prediction.set1, ...showGap.prediction.set2, ...showGap.prediction.encore].map(s => s.slug),
      actual,
    ),
    // Both shapes, because `model` and `modelTopN` already differ by more than the slot logic
    // is worth — comparing a shrunk setlist against an unshrunk top-N would confound the two.
    modelShrunk: grade(
      [...shrunk.prediction.set1, ...shrunk.prediction.set2, ...shrunk.prediction.encore].map(s => s.slug),
      actual,
    ),
    modelShrunkTopN: grade(shrunk.scored.slice(0, N).map(c => c.slug), actual),
    freq: grade(byFreq.slice(0, N), actual),
    freqNoRepeat: grade(freqNoRepeat.slice(0, N), actual),
  };

  // Graded top-N, so the sweep measures the curve rather than the slot logic sitting on it.
  if (TUNE_DUENESS) {
    for (const k of DUENESS_K_VALUES) {
      g[`dueK${k}`] = grade(duenessModels.get(k).scored.slice(0, N).map(c => c.slug), actual);
    }
  }

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

    if (!TUNE) {
      g.dayHard = grade(
        M.scored.filter(c => !isSuppressed(curve, daysFor(c.slug))).slice(0, N).map(c => c.slug),
        actual,
      );
      for (const k of K_VALUES) g[`dayCurve${k}`] = grade(rerank(M.scored, k), actual);
    }

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

  // ---- calibration, walk-forward ----
  //
  // Fitted on shows STRICTLY BEFORE this one and scored against this one, then this show's
  // outcomes join the pool for the next target. Fitting once over everything and evaluating
  // on the same data would make the calibrator look good by having already seen the answers
  // — the same leak buildModel's own guard exists to prevent, and it would show up as
  // calibration "helping" rather than as a bug.
  //
  // Evaluated over the whole candidate list, not the top N: a probability that is only
  // honest about songs we already ranked highly is not a probability.
  if (calSamples.length >= CAL_MIN_SAMPLES) {
    const params = fitPlatt(calSamples);
    const iso = fitIsotonic(calSamples);
    const ys = M.scored.map(c => (actual.has(c.slug) ? 1 : 0));
    const pairs = M.scored.map((c, i) => ({ p: plattProb(params, c.score), y: ys[i] }));
    calEval.push(...pairs);
    calIsoEval.push(...M.scored.map((c, i) => ({ p: isoProb(iso, c.score), y: ys[i] })));
    // The floor: predict the running base rate for every song, ignoring the score. If
    // calibration cannot beat this it is not earning its place.
    const base = calSamples.reduce((a, s) => a + s.y, 0) / calSamples.length;
    calBaseEval.push(...ys.map(y => ({ p: base, y })));
    calFits.push({ date: target, A: params.A, B: params.B, n: params.n });
  }
  for (const c of M.scored) calSamples.push({ score: c.score, y: actual.has(c.slug) ? 1 : 0 });

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
  model: 'MODEL (day curve, shipping)',
  modelTopN: 'MODEL top-N (no slot logic)',
  modelShowGap: 'MODEL before the day curve (show-gap)',
  modelShrunk: 'MODEL shrunk rate (own window + prior)',
  modelShrunkTopN: 'MODEL shrunk rate, no slot logic',
  modelDueness: 'MODEL fitted dueness (relative hazard)',
  modelDuenessTopN: 'MODEL fitted dueness, no slot logic',
  freq: `baseline: top-${N} by trailing-${TRAIL} frequency`,
  freqNoRepeat: `baseline: same, minus played <=3d ago`,
};
if (EXPERIMENTS) {
  if (!TUNE) {
    LABELS.dayHard = 'EXP day-repeat: drop suppressed buckets';
    for (const k of K_VALUES) LABELS[`dayCurve${k}`] = `EXP day-curve k=${k} (on top of show-gap)`;
  }
  for (const k of K_VALUES) LABELS[`dayOnly${k}`] = `EXP day-curve k=${k} (replacing show-gap)`;
}
// Only ever list arms that were actually populated — in --tune the on-top and hard-drop
// variants are skipped, and naming them here would index into an undefined arm.
if (TUNE_DUENESS) for (const k of DUENESS_K_VALUES) LABELS[`dueK${k}`] = `EXP fitted dueness k=${k}`;
const ARM_ORDER = ['model', 'modelTopN', 'modelDueness', 'modelDuenessTopN',
  'modelShrunk', 'modelShrunkTopN', 'modelShowGap', 'freqNoRepeat', 'freq',
  ...(TUNE_DUENESS ? DUENESS_K_VALUES.map(k => `dueK${k}`) : []),
  ...(EXPERIMENTS ? [
    ...(TUNE ? [] : ['dayHard', ...K_VALUES.map(k => `dayCurve${k}`)]),
    ...K_VALUES.map(k => `dayOnly${k}`),
  ] : [])].filter(k => arms[k]);

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

if (TUNE) {
  // Pick k using ONLY the training window, then report what that choice scores on the
  // held-out window. The held-out number is the one worth believing: nothing about it
  // influenced the choice of k.
  const train = perShow.filter(s => s.date <= TRAIN_END);
  const test = perShow.filter(s => s.date > TRAIN_END);
  if (!train.length || !test.length) {
    console.error(`\n--tune needs shows on both sides of ${TRAIN_END} (train ${train.length}, test ${test.length})`);
    process.exit(1);
  }

  const recallOf = (sub, arm) => mean(sub.map(s => s.arms[arm].r));
  console.log(`\nTuning the day-curve weight k`);
  console.log(`  train: ${train.length} shows through ${TRAIN_END}   |   held out: ${test.length} shows after\n`);
  console.log('     K'.padEnd(8), 'TRAIN RECALL'.padStart(14), 'HELD-OUT RECALL'.padStart(17));
  let peakK = null, peakTrain = -Infinity;
  for (const k of K_VALUES) {
    const tr = recallOf(train, `dayOnly${k}`);
    if (tr > peakTrain) { peakTrain = tr; peakK = k; }
    console.log(`  ${String(k).padStart(4)}`.padEnd(8), pct(tr).padStart(14), pct(recallOf(test, `dayOnly${k}`)).padStart(17));
  }

  // One-standard-error rule. The training curve plateaus, and taking its bare argmax
  // means chasing noise across a flat top — with the smallest k inside one SE of the peak
  // we get the same measured performance from the weakest assumption. Decided entirely on
  // the training window; the held-out numbers below play no part in it.
  const bestK = K_VALUES.find(k => {
    const p = paired(train.map(s => s.arms[`dayOnly${k}`].r), train.map(s => s.arms[`dayOnly${peakK}`].r));
    return p.delta >= -p.se;
  }) ?? peakK;
  const bestTrain = recallOf(train, `dayOnly${bestK}`);
  if (bestK !== peakK) {
    console.log(`\n  train peak is k=${peakK} (${pct(peakTrain)}), but the top is flat — taking the`);
    console.log(`  smallest k within one standard error of it: k=${bestK} (${pct(bestTrain)}).`);
  }

  const arm = `dayOnly${bestK}`;
  const heldPaired = paired(test.map(s => s.arms[arm].r), test.map(s => s.arms.model.r));
  const trainModel = recallOf(train, 'model');
  console.log(`\n  k = ${bestK} wins on the training window (${pct(bestTrain)} vs model ${pct(trainModel)}).`);
  console.log(`  On the ${test.length} held-out shows it was never tuned against:`);
  console.log(`    model    ${pct(recallOf(test, 'model'))}`);
  console.log(`    k=${bestK}      ${pct(recallOf(test, arm))}`);
  console.log(`    gain     ${(heldPaired.delta * 100 >= 0 ? '+' : '') + (heldPaired.delta * 100).toFixed(2)}pp` +
    `  se ${(heldPaired.se * 100).toFixed(2)}pp  z ${heldPaired.z.toFixed(2)}  wins ${pct(heldPaired.winRate)}`);
  console.log(`    ${Math.abs(heldPaired.z) < 2 ? 'NOT CONFIRMED — inside noise on held-out data' : 'CONFIRMED on data that did not choose k'}`);
}

if (TUNE_DUENESS) {
  // Same discipline as --tune above, and for the same reason: this arm's whole pitch is that
  // it replaces hand-picked constants with measured ones, so choosing its ONE constant by
  // eyeballing all 174 shows would hand the criticism straight back.
  const train = perShow.filter(s => s.date <= TRAIN_END);
  const test = perShow.filter(s => s.date > TRAIN_END);
  if (!train.length || !test.length) {
    console.error(`\n--tune-dueness needs shows on both sides of ${TRAIN_END}`);
    process.exit(1);
  }
  const recallOf = (sub, arm) => mean(sub.map(s => s.arms[arm].r));
  console.log(`\nTuning the fitted-dueness weight k`);
  console.log(`  train: ${train.length} shows through ${TRAIN_END}   |   held out: ${test.length} shows after\n`);
  console.log('     K'.padEnd(8), 'TRAIN RECALL'.padStart(14), 'HELD-OUT RECALL'.padStart(17));
  let peakK = null, peakTrain = -Infinity;
  for (const k of DUENESS_K_VALUES) {
    const tr = recallOf(train, `dueK${k}`);
    if (tr > peakTrain) { peakTrain = tr; peakK = k; }
    console.log(`  ${String(k).padStart(4)}`.padEnd(8), pct(tr).padStart(14), pct(recallOf(test, `dueK${k}`)).padStart(17));
  }

  // Smallest k statistically indistinguishable from the training peak — assume least.
  const bestK = DUENESS_K_VALUES.find(k => {
    const p = paired(train.map(s => s.arms[`dueK${k}`].r), train.map(s => s.arms[`dueK${peakK}`].r));
    return p.delta >= -p.se;
  }) ?? peakK;
  if (bestK !== peakK) {
    console.log(`\n  train peak is k=${peakK} (${pct(peakTrain)}), top is flat — smallest k within`);
    console.log(`  one standard error: k=${bestK} (${pct(recallOf(train, `dueK${bestK}`))}).`);
  }

  // Compared against modelTopN, not model: the sweep arms are all top-N, so measuring them
  // against the slot-assembled model would credit this curve for removing the slot logic.
  const arm = `dueK${bestK}`;
  const held = paired(test.map(s => s.arms[arm].r), test.map(s => s.arms.modelTopN.r));
  console.log(`\n  k = ${bestK} on the training window (${pct(recallOf(train, arm))} vs modelTopN ${pct(recallOf(train, 'modelTopN'))}).`);
  console.log(`  On the ${test.length} held-out shows it was never tuned against:`);
  console.log(`    modelTopN  ${pct(recallOf(test, 'modelTopN'))}`);
  console.log(`    k=${bestK}        ${pct(recallOf(test, arm))}`);
  console.log(`    gain       ${(held.delta * 100 >= 0 ? '+' : '') + (held.delta * 100).toFixed(2)}pp` +
    `  se ${(held.se * 100).toFixed(2)}pp  z ${held.z.toFixed(2)}  wins ${pct(held.winRate)}`);
  console.log(`    ${Math.abs(held.z) < 2 ? 'NOT CONFIRMED — inside noise on held-out data' : 'CONFIRMED on data that did not choose k'}`);
  console.log(`\n  DUENESS_K in lib/model.mjs is currently ${DUENESS_K}.`);
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

// ---- calibration report ----
//
// None of this moves precision or recall, and it is not supposed to: Platt scaling is
// monotonic, so the ranking and therefore the predicted setlist are identical either way.
// What it adds is an axis the ranking metrics cannot see — whether the numbers mean
// anything. A model can rank perfectly and still be wildly overconfident.
if (calEval.length) {
  const b = brier(calEval), bb = brier(calBaseEval), bi = brier(calIsoEval);
  const l = logLoss(calEval), lb = logLoss(calBaseEval), li = logLoss(calIsoEval);
  console.log(`\nCalibration — out of sample, ${calFits.length} shows, ${calEval.length} candidate-outcomes`);
  console.log('  (fitted only on shows before each target; scored on the target)');
  console.log('                 Brier    log loss');
  console.log(`  base rate    ${bb.toFixed(4)}      ${lb.toFixed(4)}`);
  console.log(`  Platt        ${b.toFixed(4)}      ${l.toFixed(4)}`);
  console.log(`  isotonic     ${bi.toFixed(4)}      ${li.toFixed(4)}`);
  const last = calFits[calFits.length - 1];
  console.log(`  Platt final fit  A=${last.A.toFixed(5)}  B=${last.B.toFixed(5)}  (n=${last.n})`);

  // The aggregate numbers are the smaller half of this. A model can beat the base rate on
  // Brier and still be useless as a probability, which is exactly what Platt does here.
  const table = (label, pairs) => {
    console.log(`\n  Reliability, ${label} — of everything called X%, how much actually played:`);
    console.log('    predicted   observed        n     gap');
    for (const r of reliability(pairs)) {
      const gap = (r.observed - r.predicted) * 100;
      console.log(
        `    ${(r.predicted * 100).toFixed(1).padStart(8)}%  ${(r.observed * 100).toFixed(1).padStart(8)}%  ` +
        `${String(r.n).padStart(7)}  ${(gap >= 0 ? '+' : '') + gap.toFixed(1)}`,
      );
    }
    // The number that decides whether these are usable: the worst a reader could be misled
    // by, weighted by how often that bucket comes up.
    const rows = reliability(pairs);
    const tot = rows.reduce((a, r) => a + r.n, 0);
    const wece = rows.reduce((a, r) => a + r.n * Math.abs(r.observed - r.predicted), 0) / tot;
    const worst = rows.reduce((m, r) => Math.max(m, Math.abs(r.observed - r.predicted)), 0);
    console.log(`    weighted calibration error ${(wece * 100).toFixed(2)}pp, worst bucket ${(worst * 100).toFixed(1)}pp`);
  };
  table('Platt', calEval);
  table('isotonic', calIsoEval);
  // Production applies these to the NEXT show, which has not happened — so fitting them on
  // every show we have is not a leak, it is simply all the evidence there is.
  const calPath = path.join(dataDir, 'calibration.json');
  const finalIso = fitIsotonic(calSamples);
  const finalPlatt = fitPlatt(calSamples);
  fs.writeFileSync(calPath, JSON.stringify({
    generated: new Date().toISOString(),
    method: 'isotonic',
    note: 'score -> probability for lib/model.mjs. bins are upper bounds: the first bin with '
      + 'x >= score gives p. Isotonic, not Platt: measured walk-forward over 145 shows, Platt '
      + 'beat the base rate on Brier and log loss while missing by up to 49.6pp inside a '
      + 'bucket. Better aggregates, unusable probabilities. Isotonic worst bucket: 4.9pp.',
    fittedThrough: showDates[showDates.length - 1],
    bins: finalIso.bins.map(x => ({ x: +x.x.toFixed(2), p: +x.p.toFixed(4), n: x.n })),
    samples: finalIso.n,
    // Kept for comparison only. Nothing reads these — they are the record of what was
    // rejected, so the next person does not have to re-run 145 shows to find out.
    rejectedPlatt: { A: finalPlatt.A, B: finalPlatt.B },
    outOfSample: {
      shows: calFits.length,
      isotonic: { brier: bi, logLoss: li },
      platt: { brier: b, logLoss: l },
      baseRate: { brier: bb, logLoss: lb },
    },
  }, null, 1) + '\n');
  console.log(`\n  wrote ${calPath}`);
}

// ---- arm accuracy, for the Nerd Zone ----
//
// backtest.json is a gitignored dev artifact, so these numbers have never left the terminal.
// This is the small committed slice of them, following data/calibration.json exactly: written
// unconditionally, committed, NOT published — analyze.js reads it and bakes the figures into
// analysis.json beside the rankings they describe.
//
// Only the arms that always exist. The experiment arms come and go with --experiments and a
// menu option whose numbers vanish depending on how the backtest was last invoked would be
// worse than no menu option.
{
  const PUBLISHED_ARMS = ['model', 'modelTopN', 'modelShowGap', 'freq', 'freqNoRepeat'];
  const refArm = 'freqNoRepeat';
  const armsOut = {};
  for (const k of PUBLISHED_ARMS) {
    if (!arms[k] || !arms[k].length) continue;
    const rec = {
      precision: mean(arms[k].map(x => x.precision)),
      recall: mean(arms[k].map(x => x.recall)),
      hitsPerShow: mean(arms[k].map(x => x.hits)),
    };
    // Against the naive baseline rather than against the model: the question a reader has is
    // "is this better than just counting what they played lately", and the paired SE is what
    // says whether the gap is real or noise.
    if (k !== refArm) {
      const p = paired(arms[k].map(x => x.recall), arms[refArm].map(x => x.recall));
      rec.deltaRecallVsBaseline = p.delta;
      rec.se = p.se;
      rec.z = p.z;
      rec.winRate = p.winRate;
    }
    armsOut[k] = rec;
  }
  // ---- diagnostics ----
  //
  // Measurements this walk-forward already makes, printed once and then thrown away. They
  // are deliberately NOT arms: nothing here re-ranks anything and a reader cannot choose
  // one. They answer the questions the arm table provokes and cannot itself answer — how
  // much of a single show is luck, whether tonight was ever reachable at all, whether the
  // probabilities mean what they say, and whether any of it is holding up over time.
  //
  // Kept in this file rather than backtest.json because that one is gitignored and only
  // written under --json, so it goes stale silently. Anything the site renders has to come
  // from a committed artifact.
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const pctile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  const diagnostics = {};

  // How much of one show is luck. The arm table reports a mean and reads as though the
  // model produces about five hits every time; the spread is what says a single show is
  // nearly a coin toss between three and eight, which is the honest thing to tell somebody
  // about to predict one show.
  {
    const h = arms.model.map(x => x.hits);
    const histogram = {};
    for (const v of h) histogram[v] = (histogram[v] || 0) + 1;
    diagnostics.spread = {
      budget: N,
      mean: mean(h), sd: sd(h), min: Math.min(...h), max: Math.max(...h),
      p10: pctile(h, 0.1), p25: pctile(h, 0.25), p50: pctile(h, 0.5),
      p75: pctile(h, 0.75), p90: pctile(h, 0.9),
      histogram,
    };
  }

  // What was even reachable. Songs with no play in the trailing window cannot be produced
  // by any rotation-based approach, so they are a hard cap on recall that belongs beside
  // the recall figure — without it 27.7% reads as failure rather than as a share of what
  // was catchable.
  {
    const size = mean(perShow.map(s => s.actualSize));
    const un = mean(perShow.map(s => s.unreachable));
    diagnostics.reachability = {
      trail: TRAIL,
      meanSetSize: size,
      meanUnreachable: un,
      meanReachable: size - un,
      ceiling: mean(perShow.map(s => s.reachableCeiling)),
      captured: mean(arms.model.map(x => x.hits)) / (size - un),
    };
  }

  // Whether it holds up over time. The per-year split exists to catch a model that only
  // works on the era it was tuned against — but it also carries the finding nothing else
  // surfaces: the model's absolute recall is flat while the naive baseline falls away, so
  // the gap widens because the band is rotating harder, not because the model improved.
  {
    const years = [...new Set(perShow.map(s => s.date.slice(0, 4)))].sort();
    diagnostics.drift = years.map(y => {
      const sub = perShow.filter(s => s.date.startsWith(y));
      const m = mean(sub.map(s => s.arms.model.r));
      const b = mean(sub.map(s => s.arms[refArm].r));
      return {
        year: y, shows: sub.length,
        model: m, baseline: b, edge: m - b,
        unreachable: mean(sub.map(s => s.unreachable)),
        setSize: mean(sub.map(s => s.actualSize)),
      };
    });
  }

  // Do the probabilities mean what they say. This is the only measurement here that the
  // ranking metrics structurally cannot see: an arm can rank perfectly and still be wildly
  // overconfident, which is exactly what Platt did. Taken from the isotonic out-of-sample
  // pairs — the fit that ships — so the table describes the numbers actually on the site.
  if (calIsoEval.length) {
    const rows = reliability(calIsoEval);
    const tot = rows.reduce((a, r) => a + r.n, 0);
    diagnostics.reliability = {
      shows: calFits.length,
      samples: calIsoEval.length,
      buckets: rows.map(r => ({ predicted: r.predicted, observed: r.observed, n: r.n })),
      weightedError: rows.reduce((a, r) => a + r.n * Math.abs(r.observed - r.predicted), 0) / tot,
      worstBucket: rows.reduce((m, r) => Math.max(m, Math.abs(r.observed - r.predicted)), 0),
    };
  }

  const armsPath = path.join(dataDir, 'arms.json');
  fs.writeFileSync(armsPath, JSON.stringify({
    generated: new Date().toISOString(),
    shows: arms.model.length,
    reference: refArm,
    params: { N, TRAIL, WARMUP },
    note: 'Walk-forward accuracy per approach. Each show is predicted using only shows before '
      + 'it. delta/se/z are paired against the ' + refArm + ' baseline on recall; |z| under 2 '
      + 'is not distinguishable from chance. `diagnostics` are measurements of the shipping '
      + 'model, not selectable approaches — see the Nerd Zone.',
    arms: armsOut,
    diagnostics,
  }, null, 1) + '\n');
  console.log(`\nwrote ${armsPath} (committed — analyze.js bakes these into analysis.json)`);
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
