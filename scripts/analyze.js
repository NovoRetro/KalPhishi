const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const load = n => JSON.parse(fs.readFileSync(path.join(dataDir, `${n}.json`), 'utf8'));

const TOUR = '2026 Summer Tour';
const NEXT_SHOW = { date: '2026-08-01', venue: 'Fenway Park', city: 'Boston, MA' }; // night 2 of the Fenway stand

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
  if (!s.slots) s.slots = { s1open: 0, s2open: 0, closer: 0, encore: 0, total: 0 };
  s.slots.total++;
  if (r.set === '1' && r._setpos === 0) s.slots.s1open++;
  if (r.set === '2' && r._setpos === 0) s.slots.s2open++;
  if ((r.set === '1' || r.set === '2' || r.set === '3') && r._setpos === r._setlen - 1) s.slots.closer++;
  if (r.set === 'e' || r.set === 'e2') s.slots.encore++;
}

// median rotation interval (in shows) per song, modern era
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
for (const s of songs.values()) {
  const idxs = [...new Set(s.plays)].map(d => showIndex.get(d)).sort((a, b) => a - b);
  s.playCount = idxs.length;
  s.freq = idxs.length / totalShows;
  s.intervals = idxs.slice(1).map((v, i) => v - idxs[i]);
  s.medianInterval = median(s.intervals);
  s.lastPlayed = s.plays[s.plays.length - 1];
  s.currentGap = totalShows - 1 - showIndex.get(s.lastPlayed); // shows since last played (0 = played at latest show)
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
const nextShowTourIdx = tourShows.length; // index the Fenway show would have
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

// ---- VERTICAL SLICE: Fenway history
const venueShows = load('shows-venue-498')
  .filter(s => s.artistid === 1 && s.showdate < NEXT_SHOW.date)
  .map(s => s.showdate).sort();
const venueSetlists = venueShows.map(d => {
  const rs = load(`setlist-${d}`).filter(r => r.artistid === 1 && r.set !== 's');
  rs.sort((a, b) => a.position - b.position);
  return {
    date: d,
    tour: rs[0]?.tourname,
    notes: (rs[0]?.setlistnotes || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    sets: Object.fromEntries(
      [...new Set(rs.map(r => r.set))].map(set => [
        set,
        rs.filter(r => r.set === set).map(r => ({ song: r.song, slug: r.slug, trans: r.trans_mark })),
      ])
    ),
  };
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

  // tour recency penalties
  if (t && gapAtNext !== null) {
    if (gapAtNext <= 2) { score -= 15; why.push(`just played ${t.dates[t.dates.length-1]}`); }
    else if (gapAtNext <= 3) { score -= 6; why.push('played recently this tour'); }
    else { score += 3; why.push(`tour repeat window open (gap ${gapAtNext})`); }
    if ([...new Set(t.dates)].length >= 3) { score -= 5; why.push('already 3+ tour plays'); }
  } else {
    if (s.freq >= 0.15) { score += 8; why.push('conspicuously absent this tour'); }
  }
  if (played729.has(s.slug)) { score -= 10; }

  // venue affinity
  if (venueSongCounts.has(s.slug)) { score += 2.5 * venueSongCounts.get(s.slug); why.push(`played at Fenway ${venueSongCounts.get(s.slug)}x before`); }

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
const used = new Set();
const openerPool = scored.filter(c => c.slots && c.slots.s1open / c.slots.total > 0.2 && c.score > 0);
const opener = pick(openerPool.length ? openerPool : scored, 1, used);
const set1mid = pick(scored, 6, used, c => !c.slots || c.slots.encore / c.slots.total < 0.5);
const closerPool = scored.filter(c => c.slots && c.slots.closer / c.slots.total > 0.25 && c.score > 0);
const set1close = pick(closerPool.length ? closerPool : scored, 1, used);
const s2openPool = scored.filter(c => c.slots && c.slots.s2open / c.slots.total > 0.15 && c.score > 0);
const set2open = pick(s2openPool.length ? s2openPool : scored, 1, used);
const set2mid = pick(scored, 5, used, c => !c.slots || c.slots.encore / c.slots.total < 0.5);
const set2close = pick(closerPool.length ? closerPool : scored, 1, used);
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
console.log('era shows:', totalShows, '| tour shows:', tourShows.length, '| tour songs:', tourSongs.size);
console.log('median intra-tour repeat gap:', medianRepeatGap);
console.log('\nTop 25 candidates:');
for (const c of scored.slice(0, 25)) console.log(` ${c.score.toString().padStart(6)}  ${c.name}  [${c.why.join('; ')}]`);
console.log('\nPredicted Set 1:', prediction.set1.map(x => x.name).join(' > '));
console.log('Predicted Set 2:', prediction.set2.map(x => x.name).join(' > '));
console.log('Encore:', prediction.encore.map(x => x.name).join(', '));
