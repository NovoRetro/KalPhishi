// Resolve when each upcoming show starts, and therefore when its predictions lock.
//
// phish.net publishes no showtime, so this reads phish.com's tour pages. Three things
// about that source shape this script:
//
//   1. A plain request gets 403. Full browser headers are required — see HEADERS below.
//   2. The time is free text ("Show Time: 7:30 pm") with NO timezone anywhere on the page.
//      The zone comes from the venue, and the conversion to an absolute instant happens
//      HERE, offline, where the full ICU database is available.
//   3. Date slugs are inconsistently zero-padded (fri-2026-05-29-the-wilma vs
//      fri-2026-4-17-sphere), so the canonical URL is read off the tours index rather
//      than constructed.
//
// Output is written twice on purpose: data/showtimes.json is served to the browser for
// the countdown, and src/showtimes.generated.mjs is bundled into the Worker so the
// server-side lock check has no runtime dependency that could fail open.
// test/showtime.test.mjs asserts the two never disagree.

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const load = n => JSON.parse(fs.readFileSync(path.join(dataDir, `${n}.json`), 'utf8'));

const BASE = 'https://phish.com';
// phish.com serves 403 to anything that looks automated; these are the minimum headers
// that get a 200. Not an attempt to hide — the pages are public and this runs a handful
// of times per tour — but the site rejects a bare fetch.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

(async () => {
  const { parseShowPage, parseTourIndex, resolveLock, preferResolved } = await import('../lib/showtime.mjs');

  // What we resolved last time. Runs on every `npm run fetch` now, so a bad afternoon at
  // phish.com must not quietly replace a real showtime with the earlier fallback.
  let prior = {};
  try { prior = load('showtimes').shows || {}; } catch { /* first run */ }

  // Everything still ahead of us. Past shows are already locked by virtue of having
  // happened, and their setlists are the record — no point resolving them.
  const today = new Date().toISOString().slice(0, 10);
  const scheduled = [];
  for (const y of [2026, 2027]) {
    let rows = [];
    try { rows = load(`schedule-${y}`); } catch { continue; }
    for (const s of rows) if (s.artistid === 1 && s.showdate >= today) scheduled.push(s);
  }
  scheduled.sort((a, b) => a.showdate.localeCompare(b.showdate));
  if (!scheduled.length) {
    console.log('no upcoming shows on the schedule — nothing to resolve');
    return;
  }
  console.log(`${scheduled.length} upcoming show(s) from ${scheduled[0].showdate}`);

  let index = new Map();
  try {
    index = parseTourIndex(await get(`${BASE}/tours/`));
    console.log(`tours index: ${index.size} dated link(s)`);
  } catch (e) {
    // Not fatal. Every show falls back to its conservative local hour, which locks early
    // rather than late — a missed edit window beats a prediction changed mid-show.
    console.warn(`could not read the tours index (${e.message}) — every show will use the fallback time`);
  }

  const shows = {};
  for (const s of scheduled) {
    const venue = { city: s.city, state: s.state, country: s.country };
    let showtime = null;
    const href = index.get(s.showdate);
    if (href) {
      try {
        const html = await get(href.startsWith('http') ? href : BASE + href);
        showtime = parseShowPage(html).showtime;
        if (!showtime) console.warn(`  ${s.showdate}: page found but no "Show Time" on it`);
      } catch (e) {
        console.warn(`  ${s.showdate}: ${e.message}`);
      }
      await sleep(1000); // one page per second — this is somebody else's server
    } else {
      console.warn(`  ${s.showdate}: no link on the tours index`);
    }

    const lock = preferResolved(resolveLock({ showdate: s.showdate, ...venue, showtime }), prior[s.showdate]);
    shows[s.showdate] = {
      showdate: s.showdate, venue: s.venue, city: s.city, state: s.state, country: s.country,
      lockAt: lock.lockAt, source: lock.source, timeZone: lock.timeZone, local: lock.local,
    };
    const when = lock.lockAt
      ? `${lock.local} ${lock.timeZone} -> ${lock.lockAt} (${lock.source})`
      : `UNRESOLVED (${lock.source})`;
    console.log(`  ${s.showdate}  ${s.venue}  ${when}`);
  }

  const payload = { generated: new Date().toISOString(), shows };
  fs.writeFileSync(path.join(dataDir, 'showtimes.json'), JSON.stringify(payload, null, 1));

  // The Worker cannot read its own published assets — wrangler serves them before the
  // script runs and no ASSETS binding is declared — so the same table is emitted as a
  // module and bundled in. Generated: edit fetch-showtimes.js, not this file.
  const generated = path.join(__dirname, '..', 'src', 'showtimes.generated.mjs');
  fs.writeFileSync(generated,
    '// GENERATED by scripts/fetch-showtimes.js — do not edit by hand.\n'
    + '// When each upcoming show starts, as an absolute instant. Bundled rather than\n'
    + '// fetched so the lock check cannot fail open on a network hiccup.\n'
    + `export const SHOWTIMES = ${JSON.stringify(
      Object.fromEntries(Object.entries(shows).map(([d, v]) => [d, { lockAt: v.lockAt, source: v.source, local: v.local, timeZone: v.timeZone }])),
      null, 2)};\n`);

  console.log(`\nwrote data/showtimes.json and src/showtimes.generated.mjs`);
  const unresolved = Object.values(shows).filter(s => !s.lockAt);
  if (unresolved.length) {
    console.warn(`${unresolved.length} show(s) could not be resolved — add the venue to CITY_TZ in lib/showtime.mjs`);
  }
})().catch(e => { console.error(e); process.exit(1); });
