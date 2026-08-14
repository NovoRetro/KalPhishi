// All-time setlists, for era analysis.
//
// Kept OUT of scripts/fetch.js on purpose. That one runs on every data refresh and covers the
// five years the model actually scores on; this walks forty-plus years and only ever needs to
// run once, because a year that has finished never changes. Folding it in would put a
// forty-request crawl on the routine path to re-fetch files that are already correct.
//
// Everything lands as data/setlists-<year>.json, the same shape and name scripts/fetch.js
// uses, which is safe because the model reads an explicit year list (2022+) rather than
// globbing the directory. Extra year files are inert until something asks for them.
//
// Phish's first show was 2 December 1983. Years the band did not play at all — 2001 and
// 2005-2008, either side of the hiatus and the breakup — return nothing and are recorded as
// empty so a later run does not keep asking.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const KEY = env.match(/PHISHNET_API_KEY=(\S+)/)[1];

const FIRST_YEAR = 1983;
const LAST_YEAR = new Date().getUTCFullYear();
// The public API is rate limited and this is a one-off crawl; there is no reason to lean on it.
const DELAY_MS = 700;

async function get(year) {
  const url = `https://api.phish.net/v5/setlists/showyear/${year}.json?apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error_message);
  return json.data || [];
}

(async () => {
  let fetched = 0, hits = 0, empty = 0;
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    const file = path.join(dataDir, `setlists-${year}.json`);
    if (fs.existsSync(file)) { hits++; continue; }

    let rows;
    try {
      rows = await get(year);
    } catch (e) {
      // A failed year must not leave a truncated file behind — the next run would treat it as
      // a cache hit and the gap would be permanent and silent.
      console.error(`  ${year}: FAILED (${e.message}) — not written, rerun to retry`);
      await new Promise(r => setTimeout(r, DELAY_MS));
      continue;
    }

    fs.writeFileSync(file, JSON.stringify(rows));
    const phish = rows.filter(r => r.artistid === 1);
    const shows = new Set(phish.map(r => r.showdate)).size;
    if (!shows) empty++;
    console.log(`  ${year}: ${String(shows).padStart(3)} shows, ${String(phish.length).padStart(5)} rows`);
    fetched++;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(`\ndone — ${fetched} fetched, ${hits} already cached, ${empty} years with no shows`);
})().catch(e => { console.error(e); process.exit(1); });
