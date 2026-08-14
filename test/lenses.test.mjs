// Guards on the Nerd Zone and the approach lenses.
//
// The whole feature rests on one property: every approach offered carries its own measured
// accuracy, and no approach shows a number it has not earned. Both halves fail silently —
// a lens with no numbers still renders a plausible menu, and a mis-calibrated Chance still
// renders a plausible percentage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setsByDate, trailingFrequency } from '../lib/baselines.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const html = read('web/index.html');
const analyze = read('scripts/analyze.js');
const backtest = read('scripts/backtest.js');

const rowsFrom = spec => spec.flatMap(([date, slugs]) => slugs.map(slug => ({ showdate: date, slug })));

test('trailing frequency ranks by play count, most first', () => {
  const rows = rowsFrom([
    ['2026-01-01', ['a', 'b']],
    ['2026-01-05', ['a', 'c']],
    ['2026-01-09', ['a', 'b']],
  ]);
  const { freq } = trailingFrequency(setsByDate(rows), ['2026-01-01', '2026-01-05', '2026-01-09'], '2026-02-01');
  assert.equal(freq[0], 'a', 'a played 3 times and must lead');
  assert.equal(freq[1], 'b', 'b played twice');
  assert.equal(freq[2], 'c');
});

test('ties break on slug, so the ranking is reproducible', () => {
  // Without this the order of equally played songs follows Map insertion, which follows the
  // order rows happened to be read — and a baseline that reshuffles between runs cannot be
  // compared to anything, including itself.
  const rows = rowsFrom([['2026-01-01', ['zebra', 'apple', 'mango']]]);
  const { freq } = trailingFrequency(setsByDate(rows), ['2026-01-01'], '2026-02-01');
  assert.deepEqual(freq, ['apple', 'mango', 'zebra']);
});

test('freqNoRepeat drops anything played within 3 days of the target', () => {
  const rows = rowsFrom([
    ['2026-01-01', ['old', 'shared']],
    ['2026-01-29', ['fresh', 'shared']],
  ]);
  const dates = ['2026-01-01', '2026-01-29'];
  const { freq, freqNoRepeat } = trailingFrequency(setsByDate(rows), dates, '2026-01-31');
  assert.ok(freq.includes('fresh'), 'the plain baseline keeps everything');
  assert.ok(!freqNoRepeat.includes('fresh'), 'played 2 days before the target — must be dropped');
  assert.ok(!freqNoRepeat.includes('shared'), 'also played 2 days before, via the later show');
  assert.ok(freqNoRepeat.includes('old'), 'played 30 days before — must survive');
});

test('the trailing window really is limited to `trail` shows', () => {
  const dates = Array.from({ length: 40 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const rows = rowsFrom(dates.map((d, i) => [d, [i < 10 ? 'ancient' : 'recent']]));
  const { freq } = trailingFrequency(setsByDate(rows), dates, '2026-03-01', { trail: 30 });
  assert.ok(!freq.includes('ancient'), 'a song only played outside the window must not appear');
});

test('both the backtest and analyze use the shared baseline', () => {
  // Two implementations would be two chances to drift, and the drift is invisible: a shipped
  // ranking that disagrees slightly with the accuracy figure printed under it still looks
  // entirely reasonable.
  assert.match(backtest, /from '\.\.\/lib\/baselines\.mjs'|import\('\.\.\/lib\/baselines\.mjs'\)/,
    'backtest.js must use lib/baselines.mjs');
  assert.match(analyze, /baselines\.mjs/, 'analyze.js must use lib/baselines.mjs');
  assert.ok(!/freqTally/.test(backtest), 'the old inline baseline must be gone from backtest.js');
});

test('every approach offered carries its own measured accuracy', () => {
  // A menu option without numbers borrows the credibility of the ones that have them.
  const block = analyze.match(/const lenses = armStats \? \{[\s\S]*?\n\} : null;/);
  assert.ok(block, 'the lenses payload was not found');
  assert.match(block[0], /\.filter\(a => armStats\.arms\[a\.key\]\)/,
    'arms without an entry in arms.json must be filtered out, not shipped bare');
  assert.match(block[0], /measuredOver: armStats\.shows/, 'the sample size must travel with it');
});

test('only the arms sharing the shipping scores may show a Chance', () => {
  // The isotonic bins were fitted on the shipping model's score distribution. Running them
  // over another arm's scores produces a confident-looking number with nothing behind it.
  const arms = analyze.match(/const LENS_ARMS = \[[\s\S]*?\n\];/);
  assert.ok(arms, 'LENS_ARMS not found');
  for (const line of arms[0].split('\n').filter(l => l.includes('key:'))) {
    const key = line.match(/key: '([^']+)'/)[1];
    const uses = /usesCalibration: true/.test(line);
    const shouldUse = key === 'model' || key === 'modelTopN';
    assert.equal(uses, shouldUse,
      `${key}: usesCalibration should be ${shouldUse} — it ${shouldUse ? 'shares' : 'does not share'} the shipping scores`);
  }
  assert.match(html, /lensArm\(\)\?\.usesCalibration \? known\?\.p \?\? null : null/,
    'the client must blank p for an arm the calibration was not fitted for');
});

test('the Nerd Zone tab name matches the card it reveals', () => {
  // Pill-to-card mapping is by exact string identity. A typo on either side produces a tab
  // that silently shows nothing at all.
  assert.match(html, /const DATA_TABS = \[[^\]]*'Nerd Zone'\]/, "'Nerd Zone' must be in DATA_TABS");
  assert.match(html, /nerd\.dataset\.section = 'Nerd Zone';/, 'the card must claim the same string');
  const tabs = html.match(/const DATA_TABS = \[([^\]]*)\]/)[1];
  for (const name of tabs.match(/'([^']+)'/g).map(s => s.slice(1, -1))) {
    assert.ok(html.includes(`dataset.section = '${name}'`), `no card claims the '${name}' tab`);
  }
});

test('the Nerd Zone card is appended before the sections snapshot is taken', () => {
  // `const sections = [...app.children]` is a one-time snapshot. A card appended after it is
  // never in the show/hide loop, so it renders on EVERY sub-tab at once — which looks like a
  // CSS bug and is not one.
  const appendAt = html.indexOf('app.appendChild(nerd);');
  const snapshotAt = html.indexOf('const sections = [...app.children];');
  assert.ok(appendAt > 0 && snapshotAt > 0, 'could not locate both anchors');
  assert.ok(appendAt < snapshotAt,
    'the Nerd Zone card must be appended before the sections snapshot, or it never hides');
});

test('a lens re-ranks in place rather than replacing the card', () => {
  // Same snapshot: `sections` holds element references, so swapping in a fresh node orphans
  // the entry and that card stops hiding when you leave its tab.
  for (const fn of ['fillPredicted', 'fillRanked']) {
    const body = html.match(new RegExp(`function ${fn}\\(\\) \\{[\\s\\S]*?\\n  \\}`));
    assert.ok(body, `${fn} not found`);
  }
  assert.match(html, /function fillPredicted\(\) \{\s*\n\s*pred\.innerHTML = '';/,
    'fillPredicted must clear and refill the same element');
  assert.match(html, /function fillRanked\(\) \{\s*\n\s*c\.innerHTML = '';/,
    'fillRanked must clear and refill the same element');
});

test('a lens cannot reach the games or the track record', () => {
  // The property that makes exposing this safe at all: predictions are graded against the
  // real setlist, never against the model, and no lens may change what a player saved.
  assert.ok(!/lens/i.test(read('web/predictor.js')),
    'predictor.js owns the games and must know nothing about lenses');
  const trackRecord = html.match(/function renderTrackRecord[\s\S]*?\n  \}/);
  assert.ok(trackRecord, 'renderTrackRecord not found');
  assert.ok(!/lens/i.test(trackRecord[0]),
    'track record must stay pinned to the shipping model');
});
