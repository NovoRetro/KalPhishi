// Guards on the Nerd Zone diagnostics.
//
// These are measurements of the shipping model — how noisy one show is, how much of a show
// was reachable at all, whether it holds up year on year, and whether the probabilities mean
// what they say. The whole feature rests on them being measurements and NOT approaches.
//
// The failure that matters is silent and it runs in one direction: a diagnostic that leaks
// into the arm list becomes something a reader can select, and selecting it would re-rank
// the site under a "lens" with no ranking behind it. The number would still render. So the
// separation is asserted here rather than left to whoever edits LENS_ARMS next.
//
// The second failure is staleness. Every figure below is baked into analysis.json at build
// time from a committed artifact; if the artifact is regenerated and the figures are not,
// the site keeps rendering last month's measurement as this month's fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const html = read('web/index.html');
const analyze = read('scripts/analyze.js');
const backtest = read('scripts/backtest.js');
const arms = JSON.parse(read('data/arms.json'));
const analysis = JSON.parse(read('data/analysis.json'));

test('the backtest writes diagnostics into the committed artifact, not the gitignored one', () => {
  // backtest.json is gitignored AND only written under --json, so it goes stale silently.
  // Anything the site renders has to come from arms.json, which is written unconditionally.
  const block = backtest.match(/const armsPath = path\.join\(dataDir, 'arms\.json'\);[\s\S]*?\n {2}\}/);
  assert.ok(block, 'arms.json write block not found');
  assert.match(block[0], /diagnostics,/, 'diagnostics must ride in arms.json');
});

test('analyze bakes the diagnostics through to analysis.json', () => {
  assert.match(analyze, /diagnostics: armStats\.diagnostics \|\| null/);
});

test('the shipped analysis.json actually carries all four', () => {
  const d = analysis.lenses && analysis.lenses.diagnostics;
  assert.ok(d, 'analysis.json carries no diagnostics — run `npm run backtest` then `npm run analyze`');
  for (const k of ['spread', 'reachability', 'drift', 'reliability']) {
    assert.ok(d[k], `missing diagnostic: ${k}`);
  }
});

test('a diagnostic is never offered as an approach', () => {
  // The load-bearing one. LENS_ARMS is the menu; a diagnostic key appearing there would be
  // selectable, and selecting it would re-rank the site under something with no ranking.
  const lensArms = analyze.match(/const LENS_ARMS = \[[\s\S]*?\n\];/);
  assert.ok(lensArms, 'LENS_ARMS not found');
  for (const k of ['spread', 'reachability', 'drift', 'reliability', 'diagnostics']) {
    assert.doesNotMatch(lensArms[0], new RegExp(`key: '${k}'`), `${k} is a measurement, not an approach`);
  }
  // And the shipped file agrees: no arm carries a diagnostic's name.
  const keys = (analysis.lenses?.arms || []).map(a => a.key);
  for (const k of ['spread', 'reachability', 'drift', 'reliability']) {
    assert.ok(!keys.includes(k), `${k} leaked into the arm list`);
  }
});

test('the diagnostics render below the picker, not inside it', () => {
  // Sat among the approach buttons they read as further options. The rule above the section
  // is the only thing separating a measurement from a choice, visually.
  // Built with el(tag, cls), so the class never appears as literal markup in the source.
  assert.match(html, /el\('div', 'nz-diag'\)/, 'no diagnostics container');
  assert.ok(html.indexOf("el('div', 'nz-diag')") > html.indexOf("el('div', 'p-modes nz-picker')"),
    'diagnostics must be appended after the picker');
  const css = html.match(/\.nz-diag \{[^}]*\}/);
  assert.ok(css, '.nz-diag has no style');
  assert.match(css[0], /border-top/, 'the separating rule is what stops these reading as options');
});

test('the diagnostics survive an arms.json that predates them', () => {
  // An older committed artifact has arms but no diagnostics block. That should cost the
  // section, not throw and take the whole Nerd Zone card with it.
  assert.match(analyze, /armStats\.diagnostics \|\| null/, 'must degrade to null, not undefined');
  assert.match(html, /const D = A\.lenses\.diagnostics;\s*\n\s*if \(D\) \{/, 'render must be guarded');
});

test('reliability is reported from the fit that ships, not the rejected one', () => {
  // Platt was measured and rejected — it missed by up to 49.6pp inside a bucket. Reporting
  // its reliability here would describe numbers no one can see on the site.
  const block = backtest.match(/diagnostics\.reliability = \{[\s\S]*?\n {4}\};/);
  assert.ok(block, 'reliability diagnostic not found');
  const src = backtest.match(/if \(calIsoEval\.length\) \{[\s\S]*?diagnostics\.reliability/);
  assert.ok(src, 'reliability must be computed from the isotonic out-of-sample pairs');
  assert.doesNotMatch(block[0], /calEval\b/, 'calEval is the rejected Platt pairs');
});

test('the drift table keeps thin years rather than hiding them', () => {
  // Dropping a six-show year would make the trend look cleaner than it is measured to be,
  // which is the exact move this whole section exists to argue against.
  assert.match(html, /nz-thin/, 'thin years must be marked');
  const d = analysis.lenses.diagnostics;
  assert.ok(d.drift.length >= 2, 'drift needs at least two years to say anything');
  assert.ok(d.drift.some(r => r.shows < 10), 'a thin year exists in the data and must still be listed');
});

test('every diagnostic figure is a real measurement, not a placeholder', () => {
  const d = analysis.lenses.diagnostics;
  const { spread, reachability, reliability } = d;
  assert.ok(spread.min <= spread.p10 && spread.p10 <= spread.p50 && spread.p50 <= spread.p90 && spread.p90 <= spread.max,
    'percentiles must be ordered');
  assert.ok(spread.sd > 0, 'a zero spread would mean every show scored identically');
  assert.ok(reachability.meanReachable < reachability.meanSetSize, 'some of a show is always unreachable');
  assert.ok(reachability.ceiling > 0 && reachability.ceiling <= 1);
  assert.ok(reliability.buckets.length >= 2, 'one bucket is not a reliability curve');
  // Isotonic is monotonic by construction; a decreasing bucket means the wrong fit shipped.
  for (let i = 1; i < reliability.buckets.length; i++) {
    assert.ok(reliability.buckets[i].predicted >= reliability.buckets[i - 1].predicted,
      'reliability buckets must be non-decreasing in predicted probability');
  }
});
