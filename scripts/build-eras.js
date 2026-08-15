// Per-era song prevalence, for the what-if lenses in the Nerd Zone.
//
// Writes data/eras.json: for each Phish era, how often each song turned up. Committed and
// never published — analyze.js bakes the resulting rankings into analysis.json, the same
// arrangement as data/arms.json and data/calibration.json.
//
// WHY THIS IS A FILE AND NOT A LIVE COMPUTATION. The eras have ended, so their contents cannot
// change and recomputing them per build would re-read forty years of setlists to produce a
// byte-identical answer. It also makes the table a genuine CONSTANT across the whole
// walk-forward, which is what makes it leak-free.
//
// ---- THE LEAKAGE ARGUMENT, which is why 4.0 is absent ----
//
// lib/model.mjs's guard (`rows.filter(r => r.showdate >= target.date)`) inspects the ROWS it
// is handed. It cannot see a statistic arriving as a parameter, and this table arrives as a
// parameter — so the guard is structurally incapable of catching a leak here, and the safety
// has to come from the data instead:
//
//   1.0  closes 2000-10-07  |  all three end BEFORE the first graded backtest target
//   2.0  closes 2004-08-15  |  (2022-09-03), so every rate is a fact about the past for
//   3.0  closes 2020-02-23  |  every target. Safe by construction, not by discipline.
//
//   4.0  2021-07-28 -> now  -- OVERLAPS every graded target. A 4.0 table would tell the model
//                              about the show it is predicting and every show after it, would
//                              report inflated accuracy, and would pass the entire suite.
//
// There is no 4.0 here and there must never be one. It is conceptually empty besides: 4.0 is
// the era the model is already fitted on, so the lens would restate the base rotation term by
// a slower route. The assertion at the foot of this file enforces the boundary.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

// Date-precise, not year buckets: 2.0 opens on one named night — the 2002-12-31 return to MSG
// — and a year split would sweep in the two excluded December warm-ups with it.
const ERAS = [
  { key: '1.0', label: '1983–2000', from: '1983-12-02', to: '2000-10-07' },
  { key: '2.0', label: '2002–2004', from: '2002-12-31', to: '2004-08-15' },
  { key: '3.0', label: '2009–2020', from: '2009-03-06', to: '2020-03-01' },
];

// The first show scripts/backtest.js grades. Any era reaching this date could leak.
const WINDOW_START = '2022-09-03';

const FIRST_YEAR = 1983;
// Nothing past this is needed, and reading 2022+ here would be the first step toward a 4.0.
const LAST_YEAR = 2021;

// The same filter as prepareRows in lib/model.mjs. A different one would make era prevalence
// incommensurable with the in-window rate it exists to be compared against — which matters far
// more than the absolute show count does.
const keep = r => r.artistid === 1 && !r.exclude && r.set !== 's';

const rows = [];
for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
  const f = path.join(dataDir, `setlists-${y}.json`);
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (keep(r)) rows.push({ date: r.showdate, slug: r.slug });
  }
}
if (!rows.length) {
  console.error('no setlist rows found — run `node scripts/fetch-eras.js` first');
  process.exit(1);
}

const out = { generated: new Date().toISOString(), windowStart: WINDOW_START, eras: {} };

for (const era of ERAS) {
  const shows = new Set();
  const showsWith = new Map();
  for (const r of rows) {
    if (r.date < era.from || r.date > era.to) continue;
    shows.add(r.date);
    if (!showsWith.has(r.slug)) showsWith.set(r.slug, new Set());
    showsWith.get(r.slug).add(r.date);
  }
  const n = shows.size;
  if (!n) { console.error(`era ${era.key} matched no shows`); process.exit(1); }

  // Add-half smoothing, NOT the MIN_LIFT = 0.01 floor that dayrepeat.mjs and hazard.mjs use.
  // Those curves floor a lift that is measured over the whole candidate universe; here a song
  // can be genuinely ABSENT from an era — 36% of the current pool never appeared in 1.0 — and
  // a shared constant would then *be* the lens for a third of the songs. Add-half ties the
  // absent value to the era's own sample size instead: 0.00042 across 1.0's 1201 shows,
  // 0.00781 across 2.0's 63, which is the right relative confidence.
  const rates = {};
  for (const [slug, dates] of showsWith) rates[slug] = (dates.size + 0.5) / (n + 1);

  const lastShow = [...shows].sort().pop();
  out.eras[era.key] = {
    label: era.label,
    from: era.from,
    to: era.to,
    lastShow,
    shows: n,
    songs: showsWith.size,
    // The value for a song this era never played. Read by the model for every candidate
    // missing from `rates`, so it must travel with the table rather than be re-derived.
    absentRate: 0.5 / (n + 1),
    rates,
  };
  console.log(`  ${era.key}  ${String(n).padStart(4)} shows, ${String(showsWith.size).padStart(3)} songs, last ${lastShow}`);
}

// The boundary that keeps this honest. If an era is ever added or a date widened such that it
// touches the graded window, this refuses to write rather than silently producing a table that
// leaks — the failure it prevents is invisible everywhere else.
for (const [key, e] of Object.entries(out.eras)) {
  if (e.lastShow >= WINDOW_START) {
    console.error(`era ${key} ends ${e.lastShow}, at or after the graded window start ${WINDOW_START} — refusing to write`);
    process.exit(1);
  }
}

const outPath = path.join(dataDir, 'eras.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
console.log(`\nwrote ${outPath} (committed — analyze.js bakes the rankings into analysis.json)`);
