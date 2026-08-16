// Guards on the superlatives (SOCIAL-PLAN.md, Phase 4).
//
// Extracted from web/predictor.js by source and run against fixtures, the same way
// resolveWombat is — the function is written self-contained precisely so this works. If
// the extraction breaks, it grew a closure dependency it must not have.
//
// These are titles handed to real people in front of their friends. The failure mode is
// not a crash, it is awarding "Sharpshooter" to somebody who went one-for-one, and the
// only way to catch that is fixtures with the awkward cases in them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const predictor = readFileSync(join(root, 'web/predictor.js'), 'utf8').replace(/\r\n/g, '\n');

const src = predictor.match(/function computeSuperlatives\(players, ctx\) \{[\s\S]*?\n  \}/);
assert.ok(src, 'computeSuperlatives not found in predictor.js');
// eslint-disable-next-line no-new-func
const computeSuperlatives = new Function(`return ${src[0]}`)();

const P = (handle, calls, hits = [], encorePlaced = []) => ({ handle, calls, hits, encorePlaced });
const byKey = (awards, key) => awards.find(a => a.key === key);

test('Bustout Prophet goes to the most overdue song that actually played', () => {
  const awards = computeSuperlatives(
    [P('kim', ['tweezer', 'icculus'], ['icculus']), P('pat', ['tweezer'], ['tweezer'])],
    { gapOf: { icculus: 412, tweezer: 3 }, callCount: { tweezer: 2, icculus: 1 }, crewSize: 2,
      nameOf: { icculus: 'Icculus', tweezer: 'Tweezer' } });
  const a = byKey(awards, 'bustout');
  assert.deepEqual(a.handles, ['kim']);
  assert.match(a.detail, /Icculus — 412 shows/);
});

test('a song that was due next week is not a bustout', () => {
  // The 31-show floor is the app's own definition (bustTier). Without it, every scored
  // show would crown a Bustout Prophet for calling Tweezer.
  const awards = computeSuperlatives(
    [P('kim', ['tweezer'], ['tweezer'])],
    { gapOf: { tweezer: 12 }, callCount: { tweezer: 1 }, crewSize: 2, nameOf: {} });
  assert.equal(byKey(awards, 'bustout'), undefined);
});

test('Lone Wolf needs the call to be solitary AND to have played', () => {
  const awards = computeSuperlatives(
    [
      P('kim', ['fee', 'tweezer'], ['fee']),       // fee: only kim, and it played
      P('pat', ['destiny', 'tweezer'], []),        // destiny: only pat, did NOT play
      P('sam', ['tweezer'], ['tweezer']),          // tweezer: everyone called it
    ],
    { gapOf: {}, callCount: { fee: 1, destiny: 1, tweezer: 3 }, crewSize: 3,
      nameOf: { fee: 'Fee' } });
  const a = byKey(awards, 'lonewolf');
  assert.deepEqual(a.handles, ['kim'], 'an unplayed sole call is not a wolf');
  assert.equal(a.detail, 'Fee');
});

test('Sharpshooter ignores anyone who barely played', () => {
  // One-for-one is 100% and means nothing; the five-call floor is what stops a single
  // lucky pick outranking a full card.
  const awards = computeSuperlatives(
    [
      P('lucky', ['fee'], ['fee']),                                           // 1/1 = 100%
      P('kim', ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c']),             // 3/6 = 50%
      P('pat', ['a', 'b', 'c', 'd', 'e'], ['a']),                            // 1/5 = 20%
    ],
    { gapOf: {}, callCount: {}, crewSize: 3, nameOf: {} });
  const a = byKey(awards, 'sharp');
  assert.deepEqual(a.handles, ['kim'], 'the 1/1 must not win');
  assert.match(a.detail, /50%/);
});

test('awards are shared rather than tie-broken, and handles come out sorted', () => {
  // Forcing a single winner would hand one of two identical performances a title and the
  // other nothing.
  const awards = computeSuperlatives(
    [
      P('zoe', ['a', 'b', 'c', 'd', 'e'], ['a', 'b']),
      P('amy', ['v', 'w', 'x', 'y', 'z'], ['v', 'w']),
    ],
    { gapOf: {}, callCount: {}, crewSize: 2, nameOf: {} });
  const a = byKey(awards, 'sharp');
  assert.deepEqual(a.handles, ['amy', 'zoe'], 'both at 40%, both awarded, sorted');
});

test('Chalk Artist needs a crew big enough for consensus to exist', () => {
  const players = [P('kim', ['a', 'b'], []), P('pat', ['a', 'b'], [])];
  const ctx = { gapOf: {}, callCount: { a: 2, b: 2 }, nameOf: {} };
  // In a duo, "half the crew agreed" is just the two of you.
  assert.equal(byKey(computeSuperlatives(players, { ...ctx, crewSize: 2 }), 'chalk'), undefined);
  const three = [...players, P('sam', ['a'], [])];
  const a = byKey(computeSuperlatives(three, { ...ctx, callCount: { a: 3, b: 2 }, crewSize: 3 }), 'chalk');
  assert.ok(a, 'three players is enough for chalk to mean something');
  assert.deepEqual(a.handles, ['kim', 'pat']);
});

test('Encore Whisperer counts only songs placed IN the encore', () => {
  const awards = computeSuperlatives(
    [
      P('kim', ['fee', 'tweezer'], ['fee', 'tweezer'], ['fee']),
      P('pat', ['tweezer'], ['tweezer'], []),  // hit it, but not in the encore slot
    ],
    { gapOf: {}, callCount: {}, crewSize: 2, nameOf: { fee: 'Fee' } });
  const a = byKey(awards, 'encore');
  assert.deepEqual(a.handles, ['kim']);
  assert.equal(a.detail, 'Fee');
});

test('a show where nobody hit anything awards nothing at all', () => {
  // Better silence than five trophies for a blank night.
  const awards = computeSuperlatives(
    [P('kim', ['a', 'b', 'c', 'd', 'e'], []), P('pat', ['f', 'g'], [])],
    { gapOf: { a: 900 }, callCount: { a: 1 }, crewSize: 2, nameOf: {} });
  assert.deepEqual(awards.filter(x => x.key !== 'chalk'), []);
});

test('every award is positive — no wooden spoon', () => {
  // Night one at Dick's is the first time most of the crew sees any of this, and the
  // newest player is the likeliest to score zero.
  for (const banned of ['Cold', 'Wooden', 'Worst', 'Loser', 'Blank', 'Whiff']) {
    assert.ok(!src[0].includes(banned), `superlatives must not include a "${banned}" award`);
  }
});

test('the reveal only awards titles once a show is scored', () => {
  const reveal = predictor.match(/async function renderReveal\([\s\S]*?\n  \}/)[0];
  assert.match(reveal, /if \(scored\.length\) \{[\s\S]*?computeSuperlatives\(/,
    'awarding Sharpshooter before the encore would be a guess wearing a trophy');
  // And the roster wears what the reveal computed rather than recomputing it per row.
  const crew = predictor.match(/async function renderCrew\([\s\S]*?\n  \}/)[0];
  assert.match(crew, /const supers = L\.locked \? \(await renderReveal\(wrap, members\)\) \|\| \[\] : \[\];/);
  assert.match(crew, /wonBy\.get\(mem\.handle\)/);
});

test('setlist hits are read from breakdown.rows, where they actually live', () => {
  // scoreSetlistPrediction keeps hits/stressors at the top level for results graded
  // under the old scheme and puts rows inside `breakdown`. Reading p.result.rows is a
  // silent no-op — it shipped that way in Phase 3, and the only symptom was a tick mark
  // that never appeared and a hit rate quietly computed from the wrong games.
  const reveal = predictor.match(/async function renderReveal\([\s\S]*?\n  \}/)[0];
  assert.match(reveal, /p\.result\.breakdown\?\.rows/,
    'setlist hits must come from result.breakdown.rows');
  // Comments stripped: the fix's own comment names the broken path it replaced, and a
  // naive search reads that explanation as the bug itself.
  const code = reveal.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/p\.result\.rows\b/.test(code),
    'p.result.rows does not exist — that path silently drops every setlist hit');
  // Pinned against the scorer rather than trusted. Newlines normalised: the working copy
  // is CRLF on Windows and LF on CI, and an n-anchored pattern silently stops matching.
  const scoring = readFileSync(join(root, 'lib/scoring.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const ret = scoring.slice(scoring.indexOf('  return {', scoring.indexOf('function scoreSetlistPrediction')));
  assert.match(ret, /breakdown: \{[\s\S]*?\n      rows,/, 'rows must still be nested under breakdown');
});
