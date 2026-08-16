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
const analysis = JSON.parse(read('data/analysis.json'));

const rowsFrom = spec => spec.flatMap(([date, slugs]) => slugs.map(slug => ({ showdate: date, slug })));

test('every arm that does not reuse the shipping scores ships its own ranking', () => {
  // The worst failure available to this feature, and nothing else catches it.
  //
  // web/index.html falls back to `A.candidates` when `lenses.rankings[lens]` is missing, and
  // web/predictor.js does the same. So an arm listed in the menu with no ranking renders the
  // SHIPPING model's songs under that arm's label, with that arm's measured accuracy printed
  // beside them, and the "viewing under X" badge still showing. That is not a degradation —
  // it is one arm's numbers fabricated against another arm's songs, and it looks entirely
  // correct on screen.
  //
  // The coverage below this only asserts arms have NUMBERS. It never asserts they have SONGS.
  //
  // usesCalibration is the exact discriminator: it is true only for arms sharing the shipping
  // model's score distribution, which are precisely the arms that may legitimately reuse
  // `candidates` instead of shipping a ranking of their own.
  const arms = analysis.lenses?.arms || [];
  assert.ok(arms.length, 'no arms in analysis.json');
  const rankings = analysis.lenses.rankings || {};
  for (const a of arms) {
    if (a.usesCalibration) {
      assert.ok(!rankings[a.key], `${a.key} shares the shipping scores and should reuse candidates`);
    } else {
      assert.ok(rankings[a.key]?.length,
        `${a.key} has its own scores but ships no ranking — it would silently render the shipping model's songs`);
    }
  }
});

test('the client fallback that makes a missing ranking dangerous is still the fallback', () => {
  // If this ever becomes something that fails loudly, the test above can relax. Until then it
  // is load-bearing, so it is asserted rather than assumed.
  assert.match(html, /A\.lenses\?\.rankings\?\.\[lens\]/, 'the lookup moved — recheck the fallback');
});

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

test('the Our Prediction button is named for what it will actually fill from', () => {
  // Fixed at "Our Prediction" it was a promise the menu could not keep: with an approach
  // chosen it hands over that approach's setlist while still calling it ours, and the only
  // warning was a chip on a different row.
  const predictor = read('web/predictor.js');
  assert.match(predictor, /const ourPredictionLabel = \(\) =>/, 'the label must be computed');
  assert.match(predictor, /lensIsDefault\(\) \? '🛟 Our Prediction'/, 'the default name must be preserved');
  // Called, never captured — render() re-runs on every lens change, and a captured string
  // would freeze on whichever approach was selected when the card was first built.
  // The crew page also builds an actionsMenu (its owner tools), so count the menus whose
  // first entry is the label fn rather than every menu in the file — the invariant is
  // that EVERY GAME menu leads with Our Prediction, not that no other menu exists.
  const menus = [...predictor.matchAll(/actionsMenu\(\[\s*(?:\/\/[^\n]*\n\s*)*\[([^,]+),/g)];
  const gameMenus = menus.filter(m => /ourPredictionLabel\(\)/.test(m[1]));
  assert.equal(gameMenus.length, 3,
    'all three game menus must lead with Our Prediction, calling the label fn');
  assert.doesNotMatch(predictor, /\['🛟 Our Prediction',/, 'no hardcoded label may remain');
});

test('the Nerd Zone says where the choice shows up in the games', () => {
  // The picker is on the Data tab; the button it renames is two taps into a menu on another
  // tab. Without the pointer, choosing an approach looks like it did nothing at all.
  assert.match(html, /nz-where/, 'the call-out must exist');
  assert.match(html, /Actions/, 'it must name the menu');
  assert.match(html, /Our Prediction/, 'it must name the button');
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

test('a lens reaches Our Prediction and the label, and nothing else in the games', () => {
  // This invariant CHANGED deliberately on 2026-08-14: the games were previously sealed off
  // from lenses entirely. They are not any more — Our Prediction fills from the chosen
  // approach. What has not changed is the thing that makes it safe: a prediction is graded
  // against the real setlist and never against the model, so which approach filled the card
  // cannot alter a single point.
  const predictor = read('web/predictor.js');

  // The two sanctioned uses.
  assert.match(predictor, /const P = lensSetlist\(\);/, 'Our Prediction must fill from the lens');
  assert.match(predictor, /p-lensnote/, 'the header must name the approach when it is not the default');

  // Nothing about the reader's choice may travel to the server. It is a client-side reading
  // preference; a prediction is just songs, and how they were chosen is not the server's
  // business or the scorer's.
  const saves = predictor.match(/api\('\/api\/predictions'[^)]*\)/g) || [];
  for (const s of saves) {
    assert.ok(!/lens/i.test(s), `a save must not carry the lens: ${s}`);
  }
  assert.ok(!/lens/i.test(predictor.match(/function scoreSetlistPrediction[\s\S]{0,400}/)?.[0] || ''),
    'scoring must not see the lens');
});

test('the track record stays pinned to the shipping model', () => {
  // It records predictions actually published before a show and then graded. No other
  // approach has ever published one, so showing its numbers here would invent a history.
  const trackRecord = html.match(/function renderTrackRecord[\s\S]*?\n  \}/);
  assert.ok(trackRecord, 'renderTrackRecord not found');
  assert.ok(!/lens/i.test(trackRecord[0]),
    'track record must stay pinned to the shipping model');
});

test('a no-slot approach still fills all three lists', () => {
  // Baselines rank but do not assign sets. Our Prediction has three lists to fill either
  // way, so the top 17 are laid into the same 8/7/2 shape — otherwise picking a baseline and
  // pressing Our Prediction would half-fill the builder with no explanation.
  const fn = read('web/predictor.js').match(/function lensSetlist\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, 'lensSetlist not found');
  assert.match(fn[0], /slice\(0, 8\)[\s\S]*slice\(8, 15\)[\s\S]*slice\(15, 17\)/,
    'a slot-less approach must still produce set1/set2/encore');
});
