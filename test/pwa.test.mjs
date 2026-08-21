// Guards on the installable-app layer (APP-STORE.md, tier 1).
//
// Two things here are unrecoverable-in-the-field if they regress, and both are silent:
// a service worker that serves a stale shell forever, and a worker that quietly starts
// caching things it must not. Everything else is a listing requirement that fails at
// submission rather than at runtime, which is cheaper but still worth catching here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const index = read('web/index.html');
const sw = read('web/sw.js');
const headers = read('web/_headers');
const buildPublic = read('scripts/build-public.js');
const manifest = JSON.parse(read('web/manifest.webmanifest'));

test('the manifest carries what an install prompt requires', () => {
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  const sizes = manifest.icons.map(i => i.sizes);
  // Android wants both; without the 512 there is no install prompt at all.
  assert.ok(sizes.includes('192x192'), 'a 192px icon is required');
  assert.ok(sizes.includes('512x512'), 'a 512px icon is required');
  // Without a maskable icon Android pillarboxes the mark inside a white circle.
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'a maskable icon is required');
});

test('every icon the manifest names is actually published', () => {
  for (const icon of manifest.icons) {
    const published = icon.src.replace(/^\//, '');
    assert.ok(
      buildPublic.includes(`'${published}'`),
      `${icon.src} is in the manifest but not in the publish allowlist — it would 404`);
  }
  assert.ok(buildPublic.includes("'icons/apple-touch-icon.png'"), 'iOS gets no icon');
});

test('the head declares the app to both platforms, and theme-color is theme-aware', () => {
  assert.match(index, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(index, /<link rel="apple-touch-icon"/, 'iOS ignores the manifest for icons');
  assert.match(index, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(index, /viewport-fit=cover/);
  // One theme-color would paint a black status bar over the light theme, or vice versa.
  const themed = [...index.matchAll(/<meta name="theme-color" content="(#[0-9a-f]{6})" media="\(prefers-color-scheme: (light|dark)\)">/gi)];
  assert.equal(themed.length, 2, 'theme-color must be declared per colour scheme');
  assert.deepEqual(themed.map(m => m[2]), ['light', 'dark'], 'browsers take the first match — order matters');
});

test('the notch cannot eat the menu button or the stage', () => {
  // viewport-fit=cover hands the page the notch, so the page has to handle it. The fixed
  // ☰ button is the element that would otherwise land squarely under the status bar.
  assert.match(index, /\.menu-btn \{ position: fixed; top: max\(10px, env\(safe-area-inset-top\)\)/);
  assert.match(index, /\.stage \{ padding: max\(30px, calc\(env\(safe-area-inset-top\)/);
  assert.match(index, /padding-bottom: max\(24px, env\(safe-area-inset-bottom\)\)/);
});

test('the worker keeps the no-push rule it was allowed under', () => {
  // "No service worker" existed to rule out push and background reach. A cache-only
  // worker honours that; the moment this file grows a push listener, the decision that
  // permitted it has been reversed without anyone deciding to.
  //
  // Comments are stripped first — the file's own header explains at length which APIs it
  // refuses to use, and a naive substring search reads that promise as a violation of
  // itself.
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const banned of ['push', 'notificationclick', 'showNotification', 'pushManager', 'periodicsync', 'Background']) {
    assert.ok(!code.includes(banned), `sw.js must not touch ${banned} — see reach.md`);
  }
});

test('the worker never serves a stale page, and never touches the API', () => {
  // index.html carries the ?v= stamps for every other file, so a cache-first shell would
  // pin a player to an old bundle with no network round trip able to correct it.
  assert.match(sw, /if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/,
    'API responses must never be cached');
  assert.match(sw, /if \(request\.method !== 'GET'\) return;/);
  assert.match(sw, /if \(url\.origin !== self\.location\.origin\) return;/,
    'phish.in audio must not be hoarded onto a device');
  // Cache-first is fenced to content-hashed and stable paths only.
  assert.match(sw, /const immutable = url\.pathname\.startsWith\('\/web\/'\) \|\| url\.pathname\.startsWith\('\/icons\/'\);/);
  // And the fallback order for everything else is network, then cache.
  const netFirst = sw.slice(sw.indexOf('// Network first'));
  assert.match(netFirst, /fetch\(request\)[\s\S]*?\.catch\(\(\) => caches\.match\(request\)/,
    'the page must be network-first with cache as the fallback');
});

test('only a navigation may fall back to the shell', () => {
  // The shell is index.html. Handing it to a request for /data/analysis.json answers a JSON
  // fetch with a 200 and text/html, and r.json() turns that into a SyntaxError the page
  // cannot distinguish from corrupt data. The entire Data side hangs off that one fetch, so
  // a single dropped request rendered a header and an error card instead of an app — on
  // Android only, because Chrome on iOS has no service worker to do it. A subresource must
  // fail as a network error, which index.html already handles.
  assert.match(sw, /request\.mode === 'navigate' \? caches\.match\('\/'\) : Response\.error\(\)/,
    'the shell fallback must be fenced to navigations');
});

test('the offline shell holds everything the page needs to boot', () => {
  // ['/', icon] was never enough: index.html immediately pulls three hashed scripts, and
  // `activate` deletes the previous cache, so every deploy stripped a returning device down
  // to a shell that could not build the app.
  assert.match(sw, /'__SHELL__'\.split\(','\)\.filter\(Boolean\)/,
    'the hashed script URLs must be stamped in, not typed');
  assert.match(buildPublic, /if \(!sw\.includes\('__SHELL__'\)\) throw new Error/,
    'an unstamped shell would try to fetch the literal placeholder and fail the install');
  assert.match(buildPublic, /hashedScripts\.push\(`\/\$\{rel\}\?v=\$\{hash\}`\)/,
    'the precache list must reuse the hashes that stamped the script tags, not recompute them');
});

test('the cache name is derived from the bundle, not typed', () => {
  // A fixed cache name is the classic stale-forever bug: the browser fetches an identical
  // sw.js, never activates it, and the old cache is never evicted.
  assert.match(sw, /const CACHE = 'bathtub-__BUILD__';/, 'the placeholder is gone');
  assert.match(buildPublic, /if \(!sw\.includes\('__BUILD__'\)\) throw new Error/,
    'a silently unstamped worker would cache under the literal placeholder forever');
  assert.match(buildPublic, /crypto\.createHash\('sha256'\)\.update\(index\)/,
    'the cache name must change exactly when the bundle does');
  assert.match(sw, /keys\.filter\(k => k !== CACHE\)\.map\(k => caches\.delete\(k\)\)/,
    'activate must evict every previous cache');
});

test('sw.js and the icons carry cache rules that match how they change', () => {
  // A cached sw.js is the one thing a tester cannot recover from without clearing site
  // data, and unhashed icons must not inherit the /web/* immutable rule.
  assert.match(headers, /^\/sw\.js\n  Cache-Control: no-cache$/m);
  assert.match(headers, /^\/icons\/\*\n  Cache-Control: public, max-age=604800$/m);
  assert.match(headers, /^\/manifest\.webmanifest\n  Cache-Control: public, max-age=86400$/m);
});

test('registration is deferred and its failure is survivable', () => {
  assert.match(index, /window\.addEventListener\('load', \(\) => \{\s*\n\s*navigator\.serviceWorker\.register\('\/sw\.js'\)\.catch/,
    'registration must wait for load and must not throw into the page');
});
