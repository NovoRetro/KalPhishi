// The prediction model (lib/model.mjs) and, above all, its leakage guard.
//
// These use synthetic setlists rather than data/setlists-*.json, which are gitignored —
// CI has no raw setlist dumps, so a test that read them would pass locally and fail on
// the deploy path. The fixtures below are shaped like real rows but small enough to
// reason about by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRows, buildModel, assembleSetlist, median } from '../lib/model.mjs';

let uid = 0;
// One show, expressed as { set: [slug, ...] }. Positions are assigned in list order.
function show(showdate, sets, { tourname = 'Test Tour', venue = 'Test Hall', venueid = 1 } = {}) {
  const rows = [];
  for (const [set, slugs] of Object.entries(sets)) {
    slugs.forEach((slug, i) => rows.push({
      showdate, set, position: ++uid, slug, song: slug,
      artistid: 1, exclude: 0, isjamchart: 0, tourname, venue, venueid,
      _setpos: i,
    }));
  }
  return rows;
}

const TARGET = { date: '2024-01-20', venue: 'Test Hall', venueid: 1 };

// Twelve shows alternating two set-1 songs and two set-2 songs, so every song has a
// stable cadence and an unambiguous set lean.
function corpus() {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const d = `2024-01-${String(i + 1).padStart(2, '0')}`;
    rows.push(...show(d, {
      '1': ['alpha', 'beta', 'gamma'],
      '2': ['delta', 'epsilon'],
      'e': ['omega'],
    }));
  }
  return prepareRows(rows);
}

// ---------------------------------------------------------------- leakage guard

test('buildModel throws when handed a row dated on the target show', () => {
  const rows = prepareRows([...corpus(), ...show(TARGET.date, { '1': ['alpha'] })]);
  assert.throws(
    () => buildModel({ rows, target: TARGET, tourName: 'Test Tour' }),
    /dated on\/after the target show 2024-01-20/,
  );
});

test('buildModel throws when handed a row dated after the target show', () => {
  const rows = prepareRows([...corpus(), ...show('2024-02-01', { '1': ['alpha'] })]);
  assert.throws(
    () => buildModel({ rows, target: TARGET, tourName: 'Test Tour' }),
    /dated on\/after the target show/,
  );
});

test('the leakage guard names the offending row, so a bad backtest is debuggable', () => {
  const rows = prepareRows([...corpus(), ...show('2024-03-03', { '1': ['smuggled'] })]);
  assert.throws(
    () => buildModel({ rows, target: TARGET, tourName: 'Test Tour' }),
    /first: 2024-03-03 smuggled/,
  );
});

test('clean history passes the guard', () => {
  assert.doesNotThrow(() => buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' }));
});

// ---------------------------------------------------------------- row preparation

test('prepareRows drops non-Phish, excluded and soundcheck rows', () => {
  const raw = [
    { showdate: '2024-01-01', set: '1', position: 1, slug: 'keep', song: 'keep', artistid: 1, exclude: 0 },
    { showdate: '2024-01-01', set: '1', position: 2, slug: 'other-band', song: 'x', artistid: 7, exclude: 0 },
    { showdate: '2024-01-01', set: '1', position: 3, slug: 'excluded', song: 'x', artistid: 1, exclude: 1 },
    { showdate: '2024-01-01', set: 's', position: 4, slug: 'soundcheck', song: 'x', artistid: 1, exclude: 0 },
  ];
  assert.deepEqual(prepareRows(raw).map(r => r.slug), ['keep']);
});

test('prepareRows sorts by date then position', () => {
  const raw = [
    { showdate: '2024-02-01', set: '1', position: 1, slug: 'b', song: 'b', artistid: 1, exclude: 0 },
    { showdate: '2024-01-01', set: '1', position: 2, slug: 'a2', song: 'a2', artistid: 1, exclude: 0 },
    { showdate: '2024-01-01', set: '1', position: 1, slug: 'a1', song: 'a1', artistid: 1, exclude: 0 },
  ];
  assert.deepEqual(prepareRows(raw).map(r => r.slug), ['a1', 'a2', 'b']);
});

// ---------------------------------------------------------------- aggregation

test('a song played at every show gets frequency 1 and gap 0', () => {
  const M = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  const alpha = M.songs.get('alpha');
  assert.equal(alpha.playCount, 12);
  assert.equal(alpha.freq, 1);
  assert.equal(alpha.currentGap, 0);
});

test('the model does not mutate the rows it is given', () => {
  // The backtest calls buildModel hundreds of times over overlapping slices of one shared
  // array. Per-set positions are held in a side map for exactly this reason.
  const rows = corpus();
  const snapshot = JSON.stringify(rows);
  buildModel({ rows, target: TARGET, tourName: 'Test Tour' });
  buildModel({ rows: rows.slice(0, 20), target: TARGET, tourName: 'Test Tour' });
  assert.equal(JSON.stringify(rows), snapshot);
});

test('identical input produces identical scores — the backtest depends on determinism', () => {
  const a = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  const b = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  assert.deepEqual(a.scored.map(c => [c.slug, c.score]), b.scored.map(c => [c.slug, c.score]));
});

test('venue affinity raises a song that has history at the venue', () => {
  const base = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  const withVenue = buildModel({
    rows: corpus(), target: TARGET, tourName: 'Test Tour',
    venueSongCounts: new Map([['gamma', 4]]),
  });
  const before = base.scored.find(c => c.slug === 'gamma').score;
  const after = withVenue.scored.find(c => c.slug === 'gamma').score;
  assert.equal(after - before, 10); // 2.5 per prior play
  assert.match(withVenue.scored.find(c => c.slug === 'gamma').why.join(' '), /played at Test Hall 4x before/);
});

// ---------------------------------------------------------------- setlist assembly

test('a set-1-exclusive song is kept out of set 2', () => {
  const M = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  const set2 = M.prediction.set2.map(s => s.slug);
  // alpha/beta/gamma appear only in set 1 across all 12 shows, well past MIN_SET_PLAYS.
  for (const slug of ['alpha', 'beta', 'gamma']) {
    assert.ok(!set2.includes(slug), `${slug} is set-1-exclusive but landed in set 2`);
  }
});

test('no song is predicted twice across sets', () => {
  const M = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  const all = [...M.prediction.set1, ...M.prediction.set2, ...M.prediction.encore].map(s => s.slug);
  assert.equal(new Set(all).size, all.length);
});

test('assembleSetlist carries the target through untouched', () => {
  const M = buildModel({ rows: corpus(), target: TARGET, tourName: 'Test Tour' });
  assert.deepEqual(M.prediction.show, TARGET);
});

test('assembleSetlist falls back to the ranked list when a slot pool is empty', () => {
  // No slot stats at all: every pool filter fails, so the picker must still fill the
  // setlist from `scored` rather than returning an empty prediction.
  const bare = [{ slug: 'a', name: 'a', score: 5, why: [] }, { slug: 'b', name: 'b', score: 4, why: [] }];
  const p = assembleSetlist(bare, TARGET);
  assert.ok(p.set1.length > 0);
});

// ---------------------------------------------------------------- median

test('median handles even and odd lengths and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});
