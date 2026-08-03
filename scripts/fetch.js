const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const KEY = env.match(/PHISHNET_API_KEY=(\S+)/)[1];
const BASE = 'https://api.phish.net/v5';

async function get(endpoint, params = {}) {
  const qs = new URLSearchParams({ apikey: KEY, ...params });
  const url = `${BASE}${endpoint}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  const json = await res.json();
  if (json.error) throw new Error(`API error for ${endpoint}: ${json.error_message}`);
  return json.data;
}

// Read an already-cached file without fetching. Used to work out which venue is next
// from data this run has just ensured is present.
function readCache(name) {
  const file = path.join(dataDir, `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

async function cached(name, endpoint, params) {
  const file = path.join(dataDir, `${name}.json`);
  if (fs.existsSync(file)) {
    console.log(`cache hit: ${name}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  console.log(`fetching: ${name} <- ${endpoint}`);
  const data = await get(endpoint, params);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`  saved ${name} (${Array.isArray(data) ? data.length : '?'} rows)`);
  await new Promise(r => setTimeout(r, 600));
  return data;
}

async function main() {
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    await cached(`setlists-${year}`, `/setlists/showyear/${year}.json`);
  }

  // Schedule endpoint (one row per show-date, including shows that haven't happened yet)
  // rather than the setlists endpoint (one row per song, past shows only). This is how
  // analyze.js knows a multi-week break is coming right after the next show — e.g. the
  // gap between a tour leg's close and its Labor Day stand at Dick's — which the setlist
  // data alone can't see until those future shows have actually been played. Like the
  // setlist caches, this goes stale as new dates get announced: delete and refetch to
  // pick up schedule changes, same as `data/setlists-<year>.json`.
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    await cached(`schedule-${year}`, `/shows/showyear/${year}.json`);
  }

  await cached('songs', '/songs.json');

  await cached('venues', '/venues.json');

  // Venue history for whichever show is next — resolved the same way analyze.js does
  // (first scheduled date after the last one with a published setlist) so the two agree.
  // Previously hardcoded to Fenway, which silently went stale the moment the tour moved on.
  const played = new Set();
  const scheduled = [];
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    for (const r of readCache(`setlists-${year}`)) {
      if (r.artistid === 1 && !r.exclude) played.add(r.showdate);
    }
    for (const s of readCache(`schedule-${year}`)) {
      if (s.artistid === 1) scheduled.push(s);
    }
  }
  scheduled.sort((a, b) => a.showdate.localeCompare(b.showdate));
  const lastPlayed = [...played].sort().pop() || '';
  const next = scheduled.find(s => s.showdate > lastPlayed) || scheduled[scheduled.length - 1];
  if (!next) { console.warn('no scheduled shows found — skipping venue history'); return; }
  console.log(`next show: ${next.showdate} — ${next.venue} (venue ${next.venueid})`);

  const shows = await cached(`shows-venue-${next.venueid}`, `/shows/venueid/${next.venueid}.json`, {
    order_by: 'showdate', direction: 'asc',
  });
  const phishShows = shows.filter(s => s.artistid === 1 || /^phish$/i.test(s.artist_name || ''));
  console.log(`Venue ${next.venue} (${next.venueid}): ${shows.length} shows, ${phishShows.length} phish`);
  for (const s of phishShows) {
    // Only shows that have actually happened have a setlist to fetch. Compared against
    // the next show's date rather than a hardcoded cutoff, so this stays correct as the
    // tour advances.
    if (s.showdate < next.showdate) {
      await cached(`setlist-${s.showdate}`, `/setlists/showdate/${s.showdate}.json`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
