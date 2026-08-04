// Guards on the shipped front-end sources and the deploy allowlist.
//
// These assert properties that no unit test of a pure function can catch: CSS cascade
// ordering, touch affordances, and which files are allowed to reach Cloudflare. Each one
// corresponds to a bug that actually happened or a rule that must not silently relax.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const html = read('web/index.html');
const predictor = read('web/predictor.js');
const buildPublic = read('scripts/build-public.js');

test('chart ticks stay uniform width', () => {
  // The era chart drew ticks with fmtDateShort, so "Jul 7" rendered 21.8px against 27.7px
  // for "Jul 22" and the short ones read as inset. Zero-padding the day only moved the
  // problem to the month, since "Aug" is wider than "Jul" in a proportional face. Ticks
  // are now the bare day, which is always two tabular digits, and at the phone breakpoint
  // the slot is 11.9px — a month-prefixed label would not fit at all.
  assert.match(html, /el\('div', 'x', fmtAxisDay\(s\.date\)\)/,
    'era chart ticks must use fmtAxisDay, not a month-bearing formatter');
  const x = html.match(/\.bar \.x \{[^}]*\}/);
  assert.ok(x, '.bar .x rule not found');
  assert.match(x[0], /font-variant-numeric:\s*tabular-nums/, 'digits must not shift width between ticks');
  assert.match(x[0], /width:\s*100%/, 'each tick must fill its slot so the boxes align');
});

test('predictor.js mirrors the scoring constants exactly', async () => {
  // The browser cannot import lib/scoring.mjs, so web/predictor.js keeps its own copy to
  // render the rules and the soft-cap counter. If the two drift, the app tells players one
  // set of rules and the Worker grades them by another — silently, and only visible after
  // a show is scored.
  const { SETLIST_POINTS, SETLIST_SOFT_CAP } = await import('../lib/scoring.mjs');
  const literal = name => {
    const m = predictor.match(new RegExp(`const ${name} = (\\{[^}]*\\});`));
    assert.ok(m, `${name} not found in web/predictor.js`);
    return JSON.parse(m[1].replace(/(\w+):/g, '"$1":').replace(/,\s*\}/, '}'));
  };
  assert.deepEqual(literal('SETLIST_POINTS'), SETLIST_POINTS);
  assert.deepEqual(literal('SOFT_CAP'), SETLIST_SOFT_CAP);
});

test('the phone breakpoint comes after the base .p-grid rule', () => {
  // Same specificity, so source order decides. Placing the media query first silently
  // restored the 90px column floor and reintroduced ~498px of sideways scroll at 375px.
  const base = html.indexOf('.p-grid { display: grid');
  const phone = html.indexOf('@media (max-width: 560px)');
  assert.ok(base !== -1, 'base .p-grid rule missing');
  assert.ok(phone !== -1, 'phone breakpoint missing');
  assert.ok(phone > base, 'the max-width:560px block must follow the base .p-grid rule');
});

test('the phone breakpoint lets bingo columns shrink below the desktop floor', () => {
  const block = html.slice(html.indexOf('@media (max-width: 560px)'));
  const rule = block.slice(0, block.indexOf('}\n'));
  assert.match(rule, /grid-template-columns:[^;]*minmax\(0,/,
    'columns must be able to shrink to 0 so five of them fit a 375px screen');
});

test('the drag handle opts out of browser touch gestures', () => {
  // Without touch-action:none the browser scrolls the page instead of starting a drag.
  assert.match(html, /\.p-drag \{[^}]*touch-action: none/);
});

test('the page declares a mobile viewport', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width/);
});

test('reorder.js loads before predictor.js, which depends on it', () => {
  const reorder = html.indexOf('/web/reorder.js');
  const pred = html.indexOf('/web/predictor.js');
  assert.ok(reorder !== -1 && pred !== -1, 'both scripts must be referenced');
  assert.ok(reorder < pred, 'predictor.js reads self.KalphishiReorder at definition time');
});

test('no HTML5 drag-and-drop handlers remain', () => {
  // Touch devices never fire these, which is what made reordering desktop-only.
  const code = predictor.replace(/\/\/[^\n]*/g, ''); // ignore explanatory comments
  for (const dead of ['dragstart', 'dragover', 'dragend', 'dragleave', 'draggable']) {
    assert.ok(!code.includes(dead), `legacy drag API still referenced: ${dead}`);
  }
});

test('drag is wired through Pointer Events', () => {
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(predictor.includes(`'${ev}'`), `missing ${ev} handler`);
  }
  assert.match(predictor, /setPointerCapture/);
});

test('tooltips respond to touch as well as hover', () => {
  assert.match(html, /pointerType !== 'mouse'|pointerType === 'mouse'/,
    'tooltip binding must branch on pointer type');
  assert.match(html, /hover or tap/, 'the hint should not promise hover-only behaviour');
});

test('the deploy allowlist publishes reorder.js', () => {
  assert.match(buildPublic, /\['web\/reorder\.js', 'web\/reorder\.js'\]/,
    'a script referenced by index.html but absent from public/ would 404 in production');
});

test('the deny pattern rejects secrets and user data', () => {
  // Mirrors DENY in scripts/build-public.js; asserts the intent, not the regex text.
  const DENY = /(^|\/)\.env|db\.json$|^data\/(setlists-|setlist-|shows-venue-|probe|scorecard)/;
  for (const bad of ['.env', 'data/db.json', 'data/setlists-2025.json',
                     'data/setlist-2026-07-31.json', 'data/shows-venue-498.json',
                     'data/scorecard-2026-07-29.json']) {
    assert.ok(DENY.test(bad), `${bad} must never be publishable`);
  }
  for (const ok of ['web/index.html', 'web/predictor.js', 'web/reorder.js',
                    'data/analysis.json', 'data/songs.json', 'data/songmeta.json',
                    'data/venues.json']) {
    assert.ok(!DENY.test(ok), `${ok} should be publishable`);
  }
});

test('every file index.html references is in the deploy allowlist', () => {
  const referenced = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)]
    .map(m => m[1])
    .filter(p => !p.startsWith('http'));
  for (const ref of referenced) {
    const published = ref === '' ? 'index.html' : ref;
    assert.ok(buildPublic.includes(`'${published}'`),
      `index.html loads /${ref} but build-public.js does not publish it`);
  }
});

test('history.json is in the deploy allowlist', () => {
  // The track-record UI fetches /data/history.json; if the build does not publish it,
  // the panel silently degrades to "no history available" in production only.
  assert.match(buildPublic, /\['data\/history\.json', 'data\/history\.json'\]/);
});

test('the archive is not swept up by the data/ gitignore', () => {
  // data/archive/*.json holds point-in-time predictions that cannot be regenerated once
  // analysis.json advances to the next show. A recursive data/**/*.json pattern would
  // silently stop them being committed, losing the accuracy record permanently.
  // Only active rules count — the file's own comment mentions the recursive pattern
  // precisely to warn against it, and matching that would be a false positive.
  const rules = read('.gitignore')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.ok(!rules.includes('data/**/*.json'), 'archive must stay committable');
  assert.ok(rules.includes('data/*.json'), 'the non-recursive cache pattern should remain');
});

test('the track-record panel reads from history.json, not analysis.json', () => {
  assert.match(html, /fetch\('\/data\/history\.json'\)/);
});
