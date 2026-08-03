// Assemble public/ — the ONLY files that get uploaded to Cloudflare.
// Publishing is an allowlist, not a runtime path check: anything not named here
// cannot be served because it is never deployed.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

// [source, published path]. index.html lands at the root so "/" serves it directly;
// everything else keeps the URL the frontend already hardcodes.
const ALLOW = [
  ['web/index.html', 'index.html'],
  ['web/reorder.js', 'web/reorder.js'],
  ['web/predictor.js', 'web/predictor.js'],
  ['data/analysis.json', 'data/analysis.json'],
  ['data/history.json', 'data/history.json'],
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
    throw new Error(`missing asset: ${rel} — run npm run fetch / analyze / build:songmeta first`);
  }
  const dest = path.join(pub, published);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

let bytes = 0;
for (const f of walk(pub)) {
  const rel = path.relative(pub, f).replace(/\\/g, '/');
  if (DENY.test(rel)) throw new Error(`DENY matched inside public/: ${rel}`);
  bytes += fs.statSync(f).size;
}
console.log(`public/ ready — ${ALLOW.length} files, ${(bytes / 1024).toFixed(0)} KB`);
