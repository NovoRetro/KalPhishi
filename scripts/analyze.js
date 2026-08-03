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

// ---- load all setlist rows, phish only, exclude soundchecks/excluded rows
const years = [2022, 2023, 2024, 2025, 2026];
let rows = [];
for (const y of years) rows.push(...load(`setlists-${y}`));
rows = rows.filter(r => r.artistid === 1 && !r.exclude && r.set !== 's');
rows.sort((a, b) => a.showdate.localeCompare(b.showdate) || a.position - b.position);

const songsCatalog = load('songs');
const catalogBySlug = new Map(songsCatalog.map(s => [s.slug, s]));

// chronological show list (modern era 2022+)
const showDates = [...new Set(rows.map(r => r.showdate))].sort();
const showIndex = new Map(showDates.map((d, i) => [d, i]));
const totalShows = showDates.length;

// ---- per-song aggregation over modern era
const songs = new Map();
for (const r of rows) {
  if (!songs.has(r.slug)) {
    songs.set(r.slug, {
      slug: r.slug, name: r.song, plays: [], sets: [], positions: [],
    });
  }
  const s = songs.get(r.slug);
  s.plays.push(r.showdate);
  s.sets.push(r.set);
}

// per-show set sizes for closer detection
const setSizes = new Map(); // `${showdate}|${set}` -> max position within that set
const setPositions = new Map(); // row -> position within set
for (const r of rows) {
  const key = `${r.showdate}|${r.set}`;
  if (!setSizes.has(key)) setSizes.set(key, []);
  setSizes.get(key).push(r);
}
for (const [key, list] of setSizes) {
  list.sort((a, b) => a.position - b.position);
  list.forEach((r, i) => { r._setpos = i; r._setlen = list.length; });
}

// slot stats per song (modern era)
for (const r of rows) {
  const s = songs.get(r.slug);
  if (!s.slots) s.slots = { s1open: 0, s2open: 0, closer: 0, encore: 0, set1: 0, set2: 0, total: 0 };
  s.slots.total++;
  if (r.set === '1' && r._setpos === 0) s.slots.s1open++;
  if (r.set === '2' && r._setpos === 0) s.slots.s2open++;
  if ((r.set === '1' || r.set === '2' || r.set === '3') && r._setpos === r._setlen - 1) s.slots.closer++;
  if (r.set === 'e' || r.set === 'e2') s.slots.encore++;
  // Plain set-1 vs set-2 counts. Many songs are effectively set-exclusive (Stash 38/38
  // set 1, Light 33/33 set 2), which the opener/closer stats above don't capture — they
  // only describe the edges of a set, not which set a song belongs in at all.
  if (r.set === '1') s.slots.set1++;
  if (r.set === '2') s.slots.set2++;
  if (r.isjamchart === 1) s.jamchartPlays = (s.jamchartPlays || 0) + 1;
}

// median rotation interval (in shows) per song, modern era
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const MIN_PLAYS_FOR_JAMRATE = 5; // below this, a song's jam-chart rate is noise, not signal
for (const s of songs.values()) {
  const idxs = [...new Set(s.plays)].map(d => showIndex.get(d)).sort((a, b) => a - b);
  s.playCount = idxs.length;
  s.freq = idxs.length / totalShows;
  s.intervals = idxs.slice(1).map((v, i) => v - idxs[i]);
  s.medianInterval = median(s.intervals);
  s.lastPlayed = s.plays[s.plays.length - 1];
  s.currentGap = totalShows - 1 - showIndex.get(s.lastPlayed); // shows since last played (0 = played at latest show)
  // Share of a song's performances that phish.net's editors flagged as jam-chart-worthy
  // (an extended/notable jam) — how reliably it "goes big" when it's played at all,
  // independent of how often it gets played.
  s.jamRate = s.playCount >= MIN_PLAYS_FOR_JAMRATE ? (s.jamchartPlays || 0) / s.playCount : 0;
}

// ---- HORIZONTAL SLICE: current summer tour
const tourRows = rows.filter(r => r.tourname === TOUR);
const tourShows = [...new Set(tourRows.map(r => r.showdate))].sort();
const tourSongs = new Map();
for (const r of tourRows) {
  if (!tourSongs.has(r.slug)) tourSongs.set(r.slug, { slug: r.slug, name: r.song, dates: [], sets: [] });
  const t = tourSongs.get(r.slug);
  t.dates.push(r.showdate);
  t.sets.push(r.set);
}
const lastTwoShows = tourShows.slice(-2);

// tour repeat behavior: distribution of intra-tour gaps for repeated songs
const intraTourGaps = [];
const tourShowIdx = new Map(tourShows.map((d, i) => [d, i]));
for (const t of tourSongs.values()) {
  const uniq = [...new Set(t.dates)].map(d => tourShowIdx.get(d)).sort((a, b) => a - b);
  for (let i = 1; i < uniq.length; i++) intraTourGaps.push(uniq[i] - uniq[i - 1]);
}

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
const medianRepeatGap = median(intraTourGaps) ?? 4;
const nextShowTourIdx = tourShows.length; // index the upcoming show would occupy
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

// ---- PREDICTION SCORING
(async () => {
const { isNearTourGap, isResetVenue } = await import('../lib/tourleg.mjs');

// Forward schedule (one row per show-date, including shows that haven't happened yet —
// this is how a big gap right after NEXT_SHOW, like the break before Dick's, is visible
// before those future shows exist as setlists). Missing/not-yet-fetched cache files just
// mean no leg-boundary signal is available, not a hard failure — see scripts/fetch.js.
let scheduleRows = [];
for (const y of years) {
  try { scheduleRows.push(...load(`schedule-${y}`)); } catch { /* not fetched for this year */ }
}
// Last 1-2 shows before a detected multi-week break (e.g. a tour leg's close ahead of
// the Labor Day stand at Dick's) historically favor extended/jam-chart-worthy playing
// over rarer songs specifically — see lib/tourleg.mjs and the roadmap discussion this
// came from. Applied as a quiet score nudge on each song's own jam-chart rate, not a
// separate visible reason.
const legEndWindow = isNearTourGap(NEXT_SHOW.date, scheduleRows);
// MSG, Dick's, and Sphere measurably do NOT avoid material from the days right before
// them the way a normal tour show does — carryover from the immediately preceding show
// runs 2-3x the dataset's own baseline at all validated instances (lib/tourleg.mjs).
// Softened, not zeroed: even at these venues most songs still don't repeat, just
// noticeably more do than the "just played it" assumption normally accounts for.
const RESET_VENUE_PENALTY_SCALE = 0.3;
const nextShowIsResetVenue = isResetVenue(NEXT_SHOW.venue);

const played729 = new Set(tourRows.filter(r => r.showdate === tourShows[tourShows.length - 1]).map(r => r.slug));
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

  // tour recency penalties — softened at reset venues (see RESET_VENUE_PENALTY_SCALE above)
  const recencyScale = nextShowIsResetVenue ? RESET_VENUE_PENALTY_SCALE : 1;
  if (t && gapAtNext !== null) {
    if (gapAtNext <= 2) { score -= 15 * recencyScale; why.push(`just played ${t.dates[t.dates.length-1]}`); }
    else if (gapAtNext <= 3) { score -= 6 * recencyScale; why.push('played recently this tour'); }
    else { score += 3; why.push(`tour repeat window open (gap ${gapAtNext})`); }
    if ([...new Set(t.dates)].length >= 3) { score -= 5; why.push('already 3+ tour plays'); }
  } else {
    if (s.freq >= 0.15) { score += 8; why.push('conspicuously absent this tour'); }
  }
  if (played729.has(s.slug)) { score -= 10; }

  // venue affinity
  if (venueSongCounts.has(s.slug)) { score += 2.5 * venueSongCounts.get(s.slug); why.push(`played at ${NEXT_SHOW.venue} ${venueSongCounts.get(s.slug)}x before`); }

  // leg-end jam intensity — quiet nudge, no why-string (see comment above)
  if (legEndWindow) score += (s.jamRate || 0) * 10;

  scored.push({
    slug: s.slug, name: s.name, score: +score.toFixed(1), why,
    eraFreq: +s.freq.toFixed(3), currentGap: s.currentGap,
    medianInterval: s.medianInterval, tourPlays: t ? [...new Set(t.dates)].length : 0,
    lastTourPlay: t ? [...new Set(t.dates)].sort().pop() : null,
    slots: s.slots,
    catalog: {
      timesPlayed: catalogBySlug.get(s.slug)?.times_played ?? null,
      debut: catalogBySlug.get(s.slug)?.debut ?? null,
      allTimeGap: catalogBySlug.get(s.slug)?.gap ?? null,
    },
  });
}
scored.sort((a, b) => b.score - a.score);

// slot-aware predicted setlist
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
// Set placement. Songs lean hard here — of 137 songs with enough set-1/set-2 plays to
// judge, 91 lean at least 70% one way, and plenty are effectively set-exclusive. Without
// this, set 1 and set 2 were both filled from the same score-ranked list, which put
// set-1-only songs (555, Stash) into set 2 purely because they scored well.
//
// Applied as an exclusion of strong contradictions rather than a hard split: a song only
// gets blocked from a set if its record clearly says it doesn't go there, so score still
// drives ordering everywhere else. Songs without enough plays to judge stay eligible for
// both — no evidence isn't the same as evidence of no lean.
const MIN_SET_PLAYS = 6;
const SET_LEAN = 0.7;
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
const prediction = {
  show: NEXT_SHOW,
  set1: [...opener, ...set1mid, ...set1close].map(strip),
  set2: [...set2open, ...set2mid, ...set2close].map(strip),
  encore: encore.map(strip),
};

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
  candidates: scored.slice(0, 120),
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
