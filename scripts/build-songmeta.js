// Precompute song metadata (last played + venue + gap) into a static asset.
// The Worker can't parse the ~9MB of yearly setlist dumps per request, and this is a
// pure function of files the offline pipeline already produces.
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');

const lastSeen = new Map(); // slug -> {venue, city, state, showdate}
for (const y of [2022, 2023, 2024, 2025, 2026]) {
  const f = path.join(dataDir, `setlists-${y}.json`);
  if (!fs.existsSync(f)) continue;
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    if (r.artistid !== 1 || r.set === 's') continue;
    const prev = lastSeen.get(r.slug);
    if (!prev || r.showdate > prev.showdate) {
      lastSeen.set(r.slug, { venue: r.venue, city: r.city, state: r.state, showdate: r.showdate });
    }
  }
}

const songs = JSON.parse(fs.readFileSync(path.join(dataDir, 'songs.json'), 'utf8'));
const out = {};
for (const s of songs) {
  const seen = lastSeen.get(s.slug);
  let venue = seen ? `${seen.venue}, ${seen.city}${seen.state ? ' ' + seen.state : ''}` : null;
  if (!venue && s.last_permalink) {
    // fallback for pre-2022 last plays: prettify the permalink tail after the date
    const m = s.last_permalink.match(/setlists\/phish-[a-z]+-\d{2}-\d{4}-(.+?)(?:-usa)?$/);
    if (m) venue = m[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  out[s.slug] = { lastPlayed: s.last_played, gap: s.gap, venue };
}

const dest = path.join(dataDir, 'songmeta.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${dest} (${Object.keys(out).length} songs, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
