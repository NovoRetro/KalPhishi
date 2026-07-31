// phish.net access for the Worker: the offline filesystem cache becomes the edge Cache API.
import { phishnetGet } from '../lib/phishnet-core.mjs';

const VENUE_SHOW_CAP = 5;
const MAX_DATES = 10; // each requested date costs one subrequest; the free plan allows 50

async function cachedFetch(name, endpoint, env, ctx) {
  const key = new Request(`https://cache.kalphishi.internal/${name}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return { data: await hit.json(), wasCached: true };

  const data = await phishnetGet(endpoint, env.PHISHNET_API_KEY);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000' },
  })));
  return { data, wasCached: false };
}

export async function venueSlice(venueid, { limit, dates } = {}, env, ctx) {
  const { data: shows } = await cachedFetch(`shows-venue-${venueid}`, `/shows/venueid/${venueid}`, env, ctx);
  const today = new Date().toISOString().slice(0, 10);
  const phishShows = shows
    .filter(s => s.artistid === 1 && s.showdate < today)
    .sort((a, b) => b.showdate.localeCompare(a.showdate));
  const selected = dates && dates.length
    ? phishShows.filter(s => dates.includes(s.showdate)).slice(0, MAX_DATES)
    : phishShows.slice(0, limit || VENUE_SHOW_CAP);

  const out = [];
  for (const s of selected) {
    const { data, wasCached } = await cachedFetch(`setlist-${s.showdate}`, `/setlists/showdate/${s.showdate}`, env, ctx);
    const rows = data.filter(r => r.artistid === 1 && r.set !== 's').sort((a, b) => a.position - b.position);
    if (!wasCached) await new Promise(r => setTimeout(r, 250)); // be polite to phish.net on cold fetches
    if (!rows.length) continue;
    const sets = {};
    for (const r of rows) (sets[r.set] = sets[r.set] || []).push({ song: r.song, slug: r.slug, trans: r.trans_mark });
    out.push({
      date: s.showdate,
      tour: rows[0].tourname,
      notes: (rows[0].setlistnotes || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      sets,
    });
  }
  return { total: phishShows.length, shown: out.length, dates: phishShows.map(s => s.showdate), shows: out };
}
