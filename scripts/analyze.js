const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const load = n => JSON.parse(fs.readFileSync(path.join(dataDir, `${n}.json`), 'utf8'));

const TOUR = '2026 Summer Tour';

// NEXT_SHOW derives itself rather than being hardcoded, so the app rolls forward on its
// own once a show is played: a show counts as complete when phish.net publishes its
// setlist, and the target becomes the first scheduled date after that. Refreshing the
// caches (`npm run fetch` after deleting setlists-<year>.json) is what advances it.
//
// Falls back to the last scheduled show when the tour is over and nothing is left ahead
// — better to keep showing the final show than to render an app with no target at all.
function resolveNextShow() {
  const played = new Set();
  const scheduled = [];
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    for (const r of load(`setlists-${y}`)) {
      if (r.artistid === 1 && !r.exclude) played.add(r.showdate);
    }
    let sched = [];
    try { sched = load(`schedule-${y}`); } catch { continue; } // year not fetched yet
    for (const s of sched) if (s.artistid === 1) scheduled.push(s);
  }
  scheduled.sort((a, b) => a.showdate.localeCompare(b.showdate));
  const lastPlayed = [...played].sort().pop() || '';
  const upcoming = scheduled.filter(s => s.showdate > lastPlayed);
  const target = upcoming[0] || scheduled[scheduled.length - 1];
  if (!target) throw new Error('no scheduled shows found — fetch schedule-<year>.json first');
  return {
    date: target.showdate,
    venue: target.venue,
    city: [target.city, target.state].filter(Boolean).join(', '),
    venueid: target.venueid,
  };
}
const NEXT_SHOW = resolveNextShow();

const years = [2022, 2023, 2024, 2025, 2026];
let rawRows = [];
for (const y of years) rawRows.push(...load(`setlists-${y}`));

const songsCatalog = load('songs');
const catalogBySlug = new Map(songsCatalog.map(s => [s.slug, s]));

// ---- VERTICAL SLICE: history at whatever venue NEXT_SHOW resolved to.
// Follows the venue rather than hardcoding one, so advancing to the next show also
// advances the venue history. Missing caches degrade to an empty slice instead of
// throwing — fetch.js pulls them on the next run, and a prediction without venue
// history is still useful, where a crashed pipeline is not.
const nextVenueId = NEXT_SHOW.venueid;
let venueShows = [];
try {
  venueShows = load(`shows-venue-${nextVenueId}`)
    .filter(s => s.artistid === 1 && s.showdate < NEXT_SHOW.date)
    .map(s => s.showdate).sort();
} catch {
  console.warn(`no cached shows for venue ${nextVenueId} — run npm run fetch to populate the venue slice`);
}
const venueSetlists = venueShows.flatMap(d => {
  let rs;
  try { rs = load(`setlist-${d}`).filter(r => r.artistid === 1 && r.set !== 's'); }
  catch { return []; } // that show's setlist isn't cached yet
  rs.sort((a, b) => a.position - b.position);
  // Wrapped in an array: flatMap would otherwise spread the object's own iterable-ness
  // rather than treating it as a single item.
  return [{
    date: d,
    tour: rs[0]?.tourname,
    notes: (rs[0]?.setlistnotes || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    sets: Object.fromEntries(
      [...new Set(rs.map(r => r.set))].map(set => [
        set,
        rs.filter(r => r.set === set).map(r => ({ song: r.song, slug: r.slug, trans: r.trans_mark })),
      ])
    ),
  }];
});
const venueSongCounts = new Map();
for (const vs of venueSetlists) {
  for (const set of Object.values(vs.sets)) {
    for (const item of set) {
      venueSongCounts.set(item.slug, (venueSongCounts.get(item.slug) || 0) + 1);
    }
  }
}

// ---- ALBUM SLICE
const albumsData = load('albums');
const slugToAlbum = new Map(); // first album by release year wins
for (const a of [...albumsData].sort((x, y) => x.year - y.year)) {
  for (const t of a.tracks) {
    if (t.slug && !slugToAlbum.has(t.slug)) slugToAlbum.set(t.slug, { album: a.album, year: a.year });
  }
}

(async () => {
// The model itself lives in lib/model.mjs so that scripts/backtest.js re-predicts past
// shows with the exact same code path this uses for the next one.
const { prepareRows, buildModel } = await import('../lib/model.mjs');
const { isoProb } = await import('../lib/calibration.mjs');

const rows = prepareRows(rawRows);

// Forward schedule (one row per show-date, including shows that haven't happened yet —
// this is how a big gap right after NEXT_SHOW, like the break before Dick's, is visible
// before those future shows exist as setlists). Missing/not-yet-fetched cache files just
// mean no leg-boundary signal is available, not a hard failure — see scripts/fetch.js.
let scheduleRows = [];
for (const y of years) {
  try { scheduleRows.push(...load(`schedule-${y}`)); } catch { /* not fetched for this year */ }
}

const M = buildModel({
  rows: rows.filter(r => r.showdate < NEXT_SHOW.date),
  target: NEXT_SHOW,
  tourName: TOUR,
  venueSongCounts,
  scheduleRows,
});
const {
  showDates, totalShows, songs, tourRows, tourShows, tourSongs, tourShowIdx,
  intraTourGaps, medianRepeatGap, nextShowTourIdx, scored, prediction,
} = M;

// conspicuously absent: high-frequency modern songs with 0 tour plays
const absent = [...songs.values()]
  .filter(s => s.freq >= 0.04 && !tourSongs.has(s.slug))
  .map(s => ({
    slug: s.slug, name: s.name,
    playsPerYearEra: +(s.playCount / (totalShows / 0.5)).toFixed(1),
    playCount: s.playCount, freq: +s.freq.toFixed(3),
    medianInterval: s.medianInterval, currentGap: s.currentGap,
    overdueFactor: s.medianInterval ? +(s.currentGap / s.medianInterval).toFixed(2) : null,
    catalogGap: catalogBySlug.get(s.slug)?.gap ?? null,
    lastPlayed: s.lastPlayed,
  }))
  .sort((a, b) => (b.freq * (b.overdueFactor ?? 0)) - (a.freq * (a.overdueFactor ?? 0)));

// due-back-up: songs played this tour but gap since last tour play >= typical intra-tour repeat cadence
const dueBackUp = [...tourSongs.values()]
  .map(t => {
    const lastIdx = tourShowIdx.get([...new Set(t.dates)].sort().pop());
    const gapAtNext = nextShowTourIdx - lastIdx;
    const s = songs.get(t.slug);
    return {
      slug: t.slug, name: t.name, tourPlays: [...new Set(t.dates)].length,
      lastTourPlay: [...new Set(t.dates)].sort().pop(), gapAtNext,
      eraFreq: +s.freq.toFixed(3), medianInterval: s.medianInterval,
    };
  })
  .filter(x => x.gapAtNext >= Math.min(medianRepeatGap, 5) && x.eraFreq >= 0.1)
  .sort((a, b) => b.gapAtNext - a.gapAtNext || b.eraFreq - a.eraFreq);

// tour-wide album share
const albumTally = new Map();
let unattributed = 0;
for (const r of tourRows) {
  const a = slugToAlbum.get(r.slug);
  if (!a) { unattributed++; continue; }
  const key = a.album;
  if (!albumTally.has(key)) albumTally.set(key, { album: a.album, year: a.year, plays: 0, songs: new Set() });
  const t = albumTally.get(key);
  t.plays++;
  t.songs.add(r.slug);
}
const attributedTotal = tourRows.length - unattributed;
const tourAlbumShare = [...albumTally.values()]
  .map(t => ({
    album: t.album, year: t.year, plays: t.plays, uniqueSongs: t.songs.size,
    sharePct: +(t.plays / attributedTotal * 100).toFixed(1),
  }))
  .sort((a, b) => b.plays - a.plays);

// per-show era center of gravity (mean album release year of attributed songs)
const perShowEra = tourShows.map(d => {
  const dayRows = tourRows.filter(r => r.showdate === d);
  const attr = dayRows.map(r => slugToAlbum.get(r.slug)).filter(Boolean);
  const meanYear = attr.length ? attr.reduce((s, a) => s + a.year, 0) / attr.length : null;
  const counts = new Map();
  for (const a of attr) counts.set(a.album, (counts.get(a.album) || 0) + 1);
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
  return {
    date: d, meanYear: meanYear ? +meanYear.toFixed(1) : null,
    attributed: attr.length, total: dayRows.length,
    topAlbum: top ? `${top[0]} (${top[1]})` : null,
  };
});

// All-time catalog facts are attached here rather than inside the model: they describe
// the song, not the prediction, and the model must not read them — songs.json reflects
// whenever it was last fetched, so a backtest that scored on them would be reading the
// future.
// The score -> probability map, fitted by `npm run backtest` over a walk-forward of every
// show in the era window. Applied HERE, after buildModel has already returned, and
// deliberately not inside the model:
//
//   assembleSetlist gates openerPool, closerPool, s2openPool and encorePool on `c.score > 0`.
//   Score accumulates penalties from zero against a base of only freq*30, so a just-played
//   song goes negative and those gates are what keep it out of the opener, closer and encore
//   slots. A probability is never <= 0. Teaching the model about `p` at all is how somebody
//   later swaps it for `score`, makes all four filters vacuous, and changes the predicted
//   setlist while believing they changed only a label. Attaching it out here means the
//   assembly logic cannot be affected — not by convention, but because it never sees it.
//
// Missing file is not an error: `p` simply does not appear. The site has run without it.
let calibration = null;
try {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'calibration.json'), 'utf8'));
  if (raw && Array.isArray(raw.bins) && raw.bins.length) calibration = raw;
} catch { /* not fitted yet */ }
if (!calibration) console.log('note: data/calibration.json missing — candidates will carry no probability.');

const candidates = scored.slice(0, 120).map(c => ({
  ...c,
  // Rounded to whole percent. The measured worst-bucket error is ~5pp, so a second decimal
  // would be advertising a precision the fit does not have.
  p: calibration ? Math.round(isoProb(calibration, c.score) * 100) / 100 : null,
  catalog: {
    timesPlayed: catalogBySlug.get(c.slug)?.times_played ?? null,
    debut: catalogBySlug.get(c.slug)?.debut ?? null,
    allTimeGap: catalogBySlug.get(c.slug)?.gap ?? null,
  },
}));

const out = {
  generated: new Date().toISOString(),
  asOf: tourShows[tourShows.length - 1],
  nextShow: NEXT_SHOW,
  eraWindow: { from: showDates[0], to: showDates[totalShows - 1], totalShows },
  tour: {
    name: TOUR,
    shows: tourShows,
    songCount: tourSongs.size,
    medianRepeatGap,
    intraTourGapHistogram: intraTourGaps.reduce((h, g) => (h[g] = (h[g] || 0) + 1, h), {}),
  },
  horizontal: {
    absent: absent.slice(0, 40),
    dueBackUp: dueBackUp.slice(0, 40),
    tourSongs: [...tourSongs.values()].map(t => ({
      slug: t.slug, name: t.name, plays: [...new Set(t.dates)].length, dates: [...new Set(t.dates)].sort(),
    })).sort((a, b) => b.plays - a.plays),
  },
  vertical: { venue: NEXT_SHOW.venue, shows: venueSetlists },
  albums: {
    tourShare: tourAlbumShare,
    unattributedPlays: unattributed,
    attributedPlays: attributedTotal,
    perShowEra,
    predictionMix: (() => {
      const all = [];
      for (const list of [prediction.set1, prediction.set2, prediction.encore]) {
        for (const s of list) {
          const a = slugToAlbum.get(s.slug);
          all.push({ song: s.name, album: a ? a.album : null, year: a ? a.year : null });
        }
      }
      return all;
    })(),
  },
  candidates,
  prediction,
};

fs.writeFileSync(path.join(dataDir, 'analysis.json'), JSON.stringify(out, null, 1));

// ---- ARCHIVE: snapshot this prediction so it survives NEXT_SHOW moving on.
// analysis.json is overwritten every run, so without this the prediction for a show is
// gone the moment the next one is targeted — and a prediction can't be reconstructed
// after the fact, since the model would then be looking at data that includes the very
// show it was meant to predict. Committed, not gitignored (see .gitignore).
const archiveDir = path.join(dataDir, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });
const archiveFile = path.join(archiveDir, `${NEXT_SHOW.date}.json`);
const prior = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')) : null;

if (prior && prior.scorecard) {
  // Refuse to rewrite a prediction that has already been graded — editing it after the
  // fact would silently rewrite the accuracy record into fiction.
  console.log(`\narchive: ${NEXT_SHOW.date} already scored — prediction left untouched.`);
} else {
  fs.writeFileSync(archiveFile, JSON.stringify({
    showdate: NEXT_SHOW.date,
    venue: NEXT_SHOW.venue,
    city: NEXT_SHOW.city,
    generated: out.generated,
    asOf: out.asOf, // last show the model had data for — proves it predates the show
    prediction: { set1: prediction.set1, set2: prediction.set2, encore: prediction.encore },
    topCandidates: scored.slice(0, 40).map(c => ({ slug: c.slug, name: c.name, score: c.score })),
    scorecard: prior ? prior.scorecard : null,
  }, null, 1));
  console.log(`\narchive: wrote data/archive/${NEXT_SHOW.date}.json (asOf ${out.asOf})`);
}

console.log('era shows:', totalShows, '| tour shows:', tourShows.length, '| tour songs:', tourSongs.size);
console.log('median intra-tour repeat gap:', medianRepeatGap);
console.log('\nTop 25 candidates:');
for (const c of scored.slice(0, 25)) console.log(` ${c.score.toString().padStart(6)}  ${c.name}  [${c.why.join('; ')}]`);
console.log('\nPredicted Set 1:', prediction.set1.map(x => x.name).join(' > '));
console.log('Predicted Set 2:', prediction.set2.map(x => x.name).join(' > '));
console.log('Encore:', prediction.encore.map(x => x.name).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
