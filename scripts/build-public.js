// Assemble public/ — the ONLY files that get uploaded to Cloudflare.
// Publishing is an allowlist, not a runtime path check: anything not named here
// cannot be served because it is never deployed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

// [source, published path]. index.html lands at the root so "/" serves it directly;
// everything else keeps the URL the frontend already hardcodes.
const ALLOW = [
  ['web/index.html', 'index.html'],
  // Cache policy for the deployed assets — see the file itself for why the HTML and the
  // hashed scripts get opposite rules. Published at the root because that is where the
  // assets runtime looks for it.
  ['web/_headers', '_headers'],
  ['web/reorder.js', 'web/reorder.js'],
  ['web/relisten.js', 'web/relisten.js'],
  ['web/predictor.js', 'web/predictor.js'],
  // PWA. The manifest and the worker must land at the ROOT: a worker's scope is capped by
  // the directory it is served from, so /web/sw.js could never control "/" — the exact
  // thing it exists to cache. Icons sit at /icons/ rather than /web/icons/ deliberately:
  // /web/* is immutable-for-a-year in _headers, and these are NOT content-hashed, so an
  // icon change under that rule would never reach a device that had seen the old one.
  ['web/manifest.webmanifest', 'manifest.webmanifest'],
  ['web/sw.js', 'sw.js'],
  ['web/icons/icon-192.png', 'icons/icon-192.png'],
  ['web/icons/icon-512.png', 'icons/icon-512.png'],
  ['web/icons/icon-maskable-512.png', 'icons/icon-maskable-512.png'],
  ['web/icons/apple-touch-icon.png', 'icons/apple-touch-icon.png'],
  ['data/analysis.json', 'data/analysis.json'],
  ['data/history.json', 'data/history.json'],
  ['data/showtimes.json', 'data/showtimes.json'],
  ['data/venues.json', 'data/venues.json'],
  ['data/songs.json', 'data/songs.json'],
  ['data/songmeta.json', 'data/songmeta.json'],
];

// Defense in depth: secrets, user data, and the bulk dumps must never match ALLOW.
const DENY = /(^|\/)\.env|db\.json$|^data\/(setlists-|setlist-|shows-venue-|probe|scorecard)/;

// never carry stale files into a deploy. Clear the contents rather than the directory
// itself, which `wrangler dev` holds a watch handle on.
if (fs.existsSync(pub)) {
  for (const e of fs.readdirSync(pub)) fs.rmSync(path.join(pub, e), { recursive: true, force: true });
}

for (const [rel, published] of ALLOW) {
  if (DENY.test(rel) || DENY.test(published)) throw new Error(`refusing to publish ${rel}`);
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    const hint = rel.startsWith('web/icons/')
      ? 'run npm run build:icons'
      : 'run npm run fetch / analyze / build:songmeta first';
    throw new Error(`missing asset: ${rel} — ${hint}`);
  }
  const dest = path.join(pub, published);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Stamp the script tags with a hash of what they actually contain. The browser caches
// /web/predictor.js hard enough that an already-open tab keeps the old script through a
// normal reload — which during development reads as "my change did nothing", and after a
// deploy means a player can be running last week's scoring against this week's server.
// The hash only changes when the file does, so a rebuild that changes nothing re-serves
// from cache exactly as before.
const SCRIPTS = ['web/reorder.js', 'web/relisten.js', 'web/predictor.js'];
const indexPath = path.join(pub, 'index.html');
let index = fs.readFileSync(indexPath, 'utf8');
for (const rel of SCRIPTS) {
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(pub, rel))).digest('hex').slice(0, 10);
  const before = index;
  index = index.replace(`src="/${rel}"`, `src="/${rel}?v=${hash}"`);
  // A silent no-op here would quietly reinstate the staleness this exists to prevent.
  if (index === before) throw new Error(`no <script src="/${rel}"> to stamp in index.html`);
}
fs.writeFileSync(indexPath, index);

// Version the service worker's cache from the bundle it will serve. A fixed cache name is
// the classic way to ship a worker that hands out last week's shell forever: the browser
// fetches the new sw.js, sees byte-identical contents, and never activates. Deriving the
// name from the stamped index.html means the worker's own bytes change exactly when the
// bundle does — which is what triggers the update, evicts the old cache in `activate`, and
// makes a no-op rebuild a genuine no-op.
const swPath = path.join(pub, 'sw.js');
const build = crypto.createHash('sha256').update(index).digest('hex').slice(0, 10);
const sw = fs.readFileSync(swPath, 'utf8');
if (!sw.includes('__BUILD__')) throw new Error('sw.js has no __BUILD__ placeholder to stamp');
fs.writeFileSync(swPath, sw.replace('__BUILD__', build));

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

let bytes = 0;
for (const f of walk(pub)) {
  const rel = path.relative(pub, f).replace(/\\/g, '/');
  if (DENY.test(rel)) throw new Error(`DENY matched inside public/: ${rel}`);
  bytes += fs.statSync(f).size;
}
console.log(`public/ ready — ${ALLOW.length} files, ${(bytes / 1024).toFixed(0)} KB`);
