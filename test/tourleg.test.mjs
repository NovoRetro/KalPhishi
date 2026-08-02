// Tour-leg-close detection (lib/tourleg.mjs) — a big schedule gap right after a show,
// not a show-count position within the tour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNearTourGap, isResetVenue } from '../lib/tourleg.mjs';

const show = (showdate, artistid = 1) => ({ showdate, artistid });

// Mirrors the real 2026 shape: a leg ending 8/1, then a 34-day gap before the Dick's
// stand — the case that motivated this feature.
const REAL_SHAPE = [
  show('2026-07-27'), show('2026-07-29'), show('2026-07-31'), show('2026-08-01'),
  show('2026-09-04'), show('2026-09-05'), show('2026-09-06'),
];

test('the last show before a big gap is detected', () => {
  assert.equal(isNearTourGap('2026-08-01', REAL_SHAPE), true);
});

test('the second-to-last show is also within the window', () => {
  assert.equal(isNearTourGap('2026-07-31', REAL_SHAPE), true);
});

test('a show earlier in the leg, well before the gap, is not', () => {
  assert.equal(isNearTourGap('2026-07-27', REAL_SHAPE), false);
});

test('a show after the gap (start of the next leg) is not — the gap is behind it', () => {
  assert.equal(isNearTourGap('2026-09-04', REAL_SHAPE), false);
});

test('the actual last show on the schedule is always in the window — nothing follows it', () => {
  assert.equal(isNearTourGap('2026-09-06', REAL_SHAPE), true);
});

test('a show not present in the schedule at all is not flagged', () => {
  assert.equal(isNearTourGap('2026-08-15', REAL_SHAPE), false);
});

test('an unbroken run of small gaps never triggers the window', () => {
  // A trailing anchor date confirms the run actually continues past '07-10' with
  // another small gap — without it, '07-10' would just be where this fixture happens
  // to stop, which is a data limit, not evidence of a real gap (see the fix above).
  const run = ['07-01', '07-02', '07-04', '07-06', '07-08', '07-10'].map(d => show('2026-' + d));
  const withAnchor = [...run, show('2026-07-12')];
  for (const s of run) assert.equal(isNearTourGap(s.showdate, withAnchor), false, s.showdate);
});

test('windowShows narrows or widens how far ahead the check looks', () => {
  // Only the last show itself counts as "before" the gap under windowShows:1;
  // the second-to-last no longer qualifies.
  assert.equal(isNearTourGap('2026-07-31', REAL_SHAPE, { windowShows: 1 }), false);
  assert.equal(isNearTourGap('2026-08-01', REAL_SHAPE, { windowShows: 1 }), true);
});

test('gapDays is the actual threshold, not a fixed 9', () => {
  const shortLeg = [show('2026-07-01'), show('2026-07-03'), show('2026-07-10')]; // 7-day gap
  assert.equal(isNearTourGap('2026-07-03', shortLeg, { gapDays: 9 }), false, 'below the default threshold');
  assert.equal(isNearTourGap('2026-07-03', shortLeg, { gapDays: 5 }), true, 'above a lower threshold');
});

test('side-project and guest shows (artistid != 1) do not count as tour continuation', () => {
  const withSideProject = [
    show('2026-07-29'), show('2026-07-31'), show('2026-08-01'),
    show('2026-08-05', -1), // a guest sit-in the week after, not a real Phish show
    show('2026-09-04'),
  ];
  // Without filtering, the 8/1 -> 8/5 gap (4 days) would look like tour continuation.
  // The real next Phish show is still 9/4, so 8/1 must still read as leg-ending.
  assert.equal(isNearTourGap('2026-08-01', withSideProject), true);
});

test('duplicate rows for the same date (one per song, if the wrong endpoint were passed) do not confuse it', () => {
  const dup = [show('2026-07-31'), show('2026-07-31'), show('2026-08-01'), show('2026-08-01'), show('2026-09-04')];
  assert.equal(isNearTourGap('2026-08-01', dup), true);
  assert.equal(isNearTourGap('2026-07-31', dup), true);
});

test('isResetVenue matches the validated venues', () => {
  assert.equal(isResetVenue('Madison Square Garden'), true);
  assert.equal(isResetVenue("Dick's Sporting Goods Park"), true);
  assert.equal(isResetVenue('Sphere'), true);
  assert.equal(isResetVenue('Watkins Glen International'), true);
});

test('isResetVenue is case-insensitive', () => {
  assert.equal(isResetVenue('madison SQUARE garden'), true);
  assert.equal(isResetVenue('SPHERE'), true);
});

test('isResetVenue rejects ordinary venues and handles missing input', () => {
  for (const v of ['Fenway Park', 'Broadview Stage at SPAC', '', null, undefined]) {
    assert.equal(isResetVenue(v), false, `${JSON.stringify(v)} should not match`);
  }
});
