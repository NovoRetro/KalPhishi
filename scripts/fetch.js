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

  await cached('songs', '/songs.json');

  const venues = await cached('venues', '/venues.json');
  const fenway = venues.filter(v => /fenway/i.test(v.venuename));
  console.log('Fenway candidates:', JSON.stringify(fenway, null, 1));

  for (const v of fenway) {
    const shows = await cached(`shows-venue-${v.venueid}`, `/shows/venueid/${v.venueid}.json`, {
      order_by: 'showdate', direction: 'asc',
    });
    const phishShows = shows.filter(s => s.artistid === 1 || /^phish$/i.test(s.artist_name || ''));
    console.log(`Venue ${v.venuename} (${v.venueid}): ${shows.length} shows, ${phishShows.length} phish`);
    for (const s of phishShows) {
      if (s.showdate < '2026-08-01') { // fetch only shows that have actually happened
        await cached(`setlist-${s.showdate}`, `/setlists/showdate/${s.showdate}.json`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
