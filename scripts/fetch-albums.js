// Build data/albums.json: song slug -> studio album, via MusicBrainz.
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
// MusicBrainz asks for a contact address in the User-Agent; set MUSICBRAINZ_CONTACT in .env
const envFile = path.join(__dirname, '..', '.env');
const contact = (fs.existsSync(envFile)
  ? (fs.readFileSync(envFile, 'utf8').match(/MUSICBRAINZ_CONTACT=(\S+)/) || [])[1]
  : null) || 'https://github.com/NovoRetro/KalPhishi';
const UA = `Kalphishi/1.0 (${contact})`;
const MB = 'https://musicbrainz.org/ws/2';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function mb(endpoint, params) {
  const qs = new URLSearchParams({ fmt: 'json', ...params });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${MB}${endpoint}?${qs}`, { headers: { 'User-Agent': UA } });
    await sleep(1100); // MB rate limit: 1 req/s
    if (res.ok) return res.json();
    if (attempt >= 5) throw new Error(`MB ${res.status} for ${endpoint}`);
    console.log(`  retry ${attempt} after ${res.status}...`);
    await sleep(3000 * attempt);
  }
}

// phish.net-style slug from a track title
function slugify(t) {
  return t.toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const artists = await mb('/artist', { query: 'artist:Phish AND type:group', limit: 5 });
  const phish = artists.artists.find(a => a.name === 'Phish');
  console.log('artist:', phish.name, phish.id);

  // studio albums only: primary type Album, no secondary types (excludes live/compilation)
  let rgs = [];
  for (let offset = 0; ; offset += 100) {
    const page = await mb('/release-group', {
      artist: phish.id, type: 'album', limit: 100, offset,
    });
    rgs.push(...page['release-groups']);
    if (rgs.length >= page['release-group-count']) break;
  }
  const EXCLUDE = new Set(['Crimes of the Mind', 'Round Room Outtakes', 'Billy Breathes Sessions']);
  const studio = rgs.filter(rg =>
    rg['primary-type'] === 'Album' && (rg['secondary-types'] || []).length === 0 &&
    !EXCLUDE.has(rg.title));
  studio.sort((a, b) => (a['first-release-date'] || '').localeCompare(b['first-release-date'] || ''));
  console.log('studio albums:', studio.map(rg => `${rg['first-release-date']?.slice(0, 4)} ${rg.title}`).join(' | '));

  const albums = [];
  for (const rg of studio) {
    // grab the earliest official release's tracklist
    const rel = await mb('/release', {
      'release-group': rg.id, status: 'official', limit: 25, inc: 'recordings',
    });
    const releases = (rel.releases || []).filter(r => r.media?.some(m => m.tracks?.length));
    releases.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    const first = releases[0];
    if (!first) { console.log(`  !! no tracklist for ${rg.title}`); continue; }
    const tracks = first.media.flatMap(m => m.tracks || []).map(t => t.title);
    albums.push({
      album: rg.title,
      year: +(rg['first-release-date'] || '0').slice(0, 4),
      tracks: tracks.map(t => ({ title: t, slug: slugify(t) })),
    });
    console.log(`  ${rg.title}: ${tracks.length} tracks`);
  }

  // match against phish.net song slugs
  const songs = JSON.parse(fs.readFileSync(path.join(dataDir, 'songs.json')));
  const netSlugs = new Set(songs.map(s => s.slug));
  const bySlugNoThe = new Map(songs.map(s => [s.slug.replace(/^the-/, ''), s.slug]));

  const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, 'album-overrides.json'), 'utf8'));
  let matched = 0, missed = [];
  for (const a of albums) {
    for (const t of a.tracks) {
      if (overrides[t.slug] !== undefined) t.slug = overrides[t.slug]; // manual patch (null = not a phish.net song)
      else if (!netSlugs.has(t.slug)) {
        const alt = bySlugNoThe.get(t.slug.replace(/^the-/, ''));
        t.slug = alt && netSlugs.has(alt) ? alt : t.slug;
      }
      if (t.slug && netSlugs.has(t.slug)) matched++;
      else if (t.slug !== null) missed.push(`${a.album} :: ${t.title} (${t.slug})`);
    }
  }
  console.log(`matched ${matched} tracks; missed ${missed.length}:`);
  for (const m of missed) console.log('  ??', m);

  fs.writeFileSync(path.join(dataDir, 'albums.json'), JSON.stringify(albums, null, 1));
  console.log('wrote data/albums.json');
}

main().catch(e => { console.error(e); process.exit(1); });
