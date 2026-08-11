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
const relisten = read('web/relisten.js');

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

// 560px is the one phone breakpoint, so there are several such blocks — one beside each
// component's own CSS. Both guards below are about the block that overrides .p-grid, and
// locating it by first-occurrence quietly made them depend on where every *other* phone
// rule sat in the file: adding one above the bingo CSS pointed them at the wrong block.
// Find the block that actually contains the selector under test.
function phoneBlockFor(selector) {
  const BP = '@media (max-width: 560px)';
  for (let at = html.indexOf(BP); at !== -1; at = html.indexOf(BP, at + 1)) {
    const open = html.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) break;
    }
    const body = html.slice(open + 1, i);
    if (body.includes(selector)) return { at, body };
  }
  return null;
}

test('the phone breakpoint comes after the base .p-grid rule', () => {
  // Same specificity, so source order decides. Placing the media query first silently
  // restored the 90px column floor and reintroduced ~498px of sideways scroll at 375px.
  const base = html.indexOf('.p-grid { display: grid');
  const phone = phoneBlockFor('.p-grid');
  assert.ok(base !== -1, 'base .p-grid rule missing');
  assert.ok(phone, 'no max-width:560px block overrides .p-grid');
  assert.ok(phone.at > base, 'the .p-grid phone block must follow the base .p-grid rule');
});

test('the phone breakpoint lets bingo columns shrink below the desktop floor', () => {
  const phone = phoneBlockFor('.p-grid');
  assert.ok(phone, 'no max-width:560px block overrides .p-grid');
  const rule = phone.body.match(/\.p-grid \{[^}]*\}/);
  assert.ok(rule, '.p-grid rule missing from its phone block');
  assert.match(rule[0], /grid-template-columns:[^;]*minmax\(0,/,
    'columns must be able to shrink to 0 so five of them fit a 375px screen');
});

test('crossing beams add rather than occlude', () => {
  // The rig is a wall of overlapping beams. Light is additive, so two crossing beams have
  // to come out brighter than either alone; without screen blending they simply stack in
  // paint order and the whole thing goes flat and papery. isolation:isolate keeps that
  // blending inside the stage instead of letting it reach the page behind it.
  const beam = html.match(/\.rig \.beam \{[^}]*\}/);
  assert.ok(beam, '.rig .beam rule not found');
  assert.match(beam[0], /mix-blend-mode:\s*screen/, 'beams must blend additively');
  assert.match(html, /\.hall \{[^}]*isolation:\s*isolate/,
    'the hall must isolate its blend group');
});

test('the hall stays dark in both themes', () => {
  // Beams only exist against darkness. The hall deliberately does not follow --page: if it
  // ever picks up the light theme's near-white the beams wash out completely, which reads
  // as "the rig broke" rather than "the rig is themed". The nav styling inside it is
  // hard-coded light-on-dark for the same reason, so the two must not drift apart.
  const hall = html.match(/\.hall \{[^}]*\}/);
  assert.ok(hall, '.hall rule not found');
  assert.match(hall[0], /background:\s*radial-gradient\([^;]*#[0-9a-f]{6}/i,
    'the hall background must be a fixed dark gradient, not a themed variable');
  assert.ok(!/\.hall \{[^}]*var\(--page\)/.test(html),
    'the hall must not follow the page background');
});

test('the hall fades out instead of ending on an edge', () => {
  // Without the mask the layer stops at a hard horizontal line partway down the page and
  // reads as a banner with a bottom border, not as light running out. Both the darkness
  // and the beams it carries have to fall off together, which is why the mask is on the
  // hall rather than on the beams.
  const hall = html.match(/\.hall \{[^}]*\}/);
  assert.match(hall[0], /mask-image:\s*linear-gradient\([^;]*transparent/,
    'the hall must fade out at its bottom edge');
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

test('the ranked-songs Why is clamped visually, not truncated', () => {
  // tableOf filters and sorts on cell textContent, so shortening the string itself would
  // break searching for a reason that is no longer on screen — the clamp has to be CSS,
  // with the whole reason left in the DOM behind it.
  const rule = html.match(/\.why-trunc \{[^}]*\}/);
  assert.ok(rule, '.why-trunc rule not found');
  assert.match(rule[0], /text-overflow:\s*ellipsis/, 'the column must be clamped visually');
  assert.match(rule[0], /white-space:\s*nowrap/, 'the clamp is a single line');
  assert.match(html, /class="why why-trunc"[^`]*\$\{esc\(x\.why\.join/,
    'the cell must still render the full reason');
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

test('the listen player credits its sources and never autoplays', () => {
  // The audio is fan-taped audience recordings, shared under Phish's taping policy for
  // non-commercial use. Two properties keep this side of that line, and both are the kind
  // of thing a later edit drops without noticing it mattered:
  //   · credit to phish.in (who host the bytes) and Relisten (who index them) renders with
  //     the player itself, every time, not in a footer someone has to go find;
  //   · nothing STARTS without a press, which keeps the draw on phish.in's privately
  //     funded bandwidth proportional to actual listening.
  assert.match(relisten, /rl-credit/, 'the credit element must be rendered');
  assert.match(relisten, /phish\.in/, 'phish.in must be credited');
  assert.match(relisten, /relisten\.net/, 'Relisten must be credited');
  assert.ok(!/autoplay\s*=/.test(relisten), 'nothing here may autoplay');
  assert.match(relisten, /preload\s*=\s*'none'/,
    'no audio may be fetched until it is actually asked for');
});

test('a show advances to the end and then stops', () => {
  // A show plays straight through once started, which is the one place audio continues
  // without a fresh press. The bound on it is the whole reason that is acceptable: it
  // stops at the last track, so a forgotten tab cannot sit pulling recordings all night.
  // Neither `autoplay=` nor `preload` changes when this breaks, so the test above would
  // stay green through a regression here.
  // The bound lives in nextInQueue now, which both advance() and the preloader ask. That is
  // the point of it being one function: the thing that decides there IS a next track is
  // also the thing that decides there is not.
  const nx = relisten.match(/const nextInQueue = [\s\S]*?\n  \};/);
  assert.ok(nx, 'nextInQueue() not found');
  assert.match(nx[0], /i < queue\.length - 1/,
    'advancing must stop at the last track rather than wrapping');
  const adv = relisten.match(/function advance\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(adv, 'advance() not found');
  assert.match(adv[0], /nextInQueue\(\)/,
    'advance must go through nextInQueue rather than indexing the queue itself');
  assert.ok(!/loop\s*=\s*true/.test(relisten), 'the player must never loop');

  // Every start routes through playFrom, which sets the queue and the source together.
  // A direct `audio.src = …; play()` elsewhere would leave the two disagreeing, and the
  // show would advance out of one panel into whatever another panel had listed.
  // Three now: playFrom, advance's un-buffered fallback, and the preloader arming the idle
  // deck. Any fourth is a new way for the queue and the source to drift apart.
  const starts = relisten.match(/\.src = /g) || [];
  assert.equal(starts.length, 3,
    'only playFrom, advance and maybePreload may assign .src — found ' + starts.length);
});

test('preloading stays proportional to actual listening', () => {
  // phish.in pays for these bytes and funds it privately. Buffering the next track at the
  // START of the current one would fetch a file for every session that stops midway — which
  // is most of them — so the preload is deliberately late and deliberately conditional.
  // None of this shows up as a broken feature when it regresses; it shows up as somebody
  // else's bandwidth bill.
  const pre = relisten.match(/function maybePreload\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(pre, 'maybePreload() not found');
  assert.match(pre[0], /a\.paused/, 'a paused listener must not trigger a preload');
  assert.match(pre[0], /duration - a\.currentTime > PRELOAD_LEAD_S/,
    'the preload must be gated on being near the end of the current track');
  assert.match(relisten, /const PRELOAD_LEAD_S = (\d+)/, 'the lead time must be a named constant');
  const lead = Number(relisten.match(/const PRELOAD_LEAD_S = (\d+)/)[1]);
  assert.ok(lead > 0 && lead <= 60,
    `the lead time must stay short enough to mean "still listening" — got ${lead}s`);
  // Preloading must never become playing. The idle deck is armed with load(), never play().
  assert.ok(!/startPlay|\.play\(\)/.test(pre[0]),
    'the preloader must buffer only — starting playback here would be an autoplay');
  assert.match(pre[0], /bufferedMp3 === next\.mp3/,
    'the same track must never be fetched onto the idle deck twice');
});

test('the build stamps its scripts with a content hash', () => {
  // The browser caches /web/predictor.js hard enough that an already-open tab keeps the
  // old script through a normal reload. In development that reads as "my edit did
  // nothing"; after a deploy it means a player can be running last week's scoring rules
  // against this week's server. The stamp is applied to the built copy only, so the source
  // index.html the allowlist test reads stays clean.
  assert.match(buildPublic, /createHash\('sha256'\)/, 'scripts must be hashed by content');
  assert.match(buildPublic, /\?v=\$\{hash\}/, 'the hash must land in the script src');
  assert.match(buildPublic, /throw new Error\(`no <script src=/,
    'a stamp that matched nothing would silently reinstate the staleness it exists to fix');
});

test('the cache policy ships, and points the right way for each kind of file', () => {
  // Publishing is an allowlist, so a _headers file that is not on it simply does not
  // deploy — and nothing fails. The policy would revert to the defaults and the only
  // symptom would be a visitor stuck on a stale index.html, which reads as "the feature
  // you shipped isn't there" rather than as a caching problem.
  assert.match(buildPublic, /\['web\/_headers', '_headers'\]/,
    'the cache policy must be published, or it does nothing');

  const headers = read('web/_headers');

  // index.html is the one file whose URL never changes, and it carries the ?v= stamps
  // pointing at everything else, so a stale copy pins a visitor to a stale bundle.
  assert.match(headers, /^\/\s*\n\s*Cache-Control:\s*no-cache/m,
    'the root must never be reused without revalidating');

  // The scripts are content-hashed, so a given URL's bytes cannot change. Not revalidating
  // them is the payoff for stamping them at all.
  assert.match(headers, /^\/web\/\*\s*\n\s*Cache-Control:[^\n]*immutable/m,
    'hashed assets should not be revalidated on every load');

  // The trap for a later edit: /data/*.json are NOT hashed and change in place on a data
  // refresh. A long max-age there would freeze the analysis, the showtimes and the lock
  // table on whatever a visitor fetched first — a worse staleness bug than the one this
  // file exists to fix, and one that would silently break the prediction lock.
  const dataRule = headers.match(/^\/data\/[^\n]*\n(?:[ \t]+[^\n]*\n)*/m);
  assert.ok(!dataRule || !/immutable|max-age=[1-9]/.test(dataRule[0]),
    'data files change in place and must keep revalidating');
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
