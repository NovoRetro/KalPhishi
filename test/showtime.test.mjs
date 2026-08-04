// Show-time parsing and the lock instant (lib/showtime.mjs).
//
// Everything here is offline: no test may reach phish.com, both because CI has no network
// guarantee and because a scrape test that passes only while a page is unchanged is a
// scheduled failure. The fixtures are the real markup shape, reduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseShowPage, parseTourIndex, venueTimezone, zonedToUtc, resolveLock, lockStateFor,
  preferResolved, FALLBACK_LOCAL_HOUR,
} from '../lib/showtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGE = `
  <div class="show-info"><h3>Show Info:</h3>
  <p>Show Time: 7:30 pm<br>Doors Open: 6:00 pm</p></div>
`;

test('parses the show and doors times out of the real markup shape', () => {
  const r = parseShowPage(PAGE);
  assert.deepEqual(r.showtime, { hour: 19, minute: 30 });
  assert.deepEqual(r.doors, { hour: 18, minute: 0 });
});

test('parsing survives tags sitting inside the label', () => {
  const r = parseShowPage('<b>Show</b> <b>Time</b>: <span>8:00</span> <i>pm</i>');
  assert.deepEqual(r.showtime, { hour: 20, minute: 0 });
});

test('noon and midnight convert correctly', () => {
  assert.deepEqual(parseShowPage('Show Time: 12:30 am').showtime, { hour: 0, minute: 30 });
  assert.deepEqual(parseShowPage('Show Time: 12:30 pm').showtime, { hour: 12, minute: 30 });
});

test('a page with no show time yields null rather than a wrong guess', () => {
  assert.equal(parseShowPage('<p>Tickets on sale Friday</p>').showtime, null);
  assert.equal(parseShowPage('').showtime, null);
});

test('nonsense clock values are rejected', () => {
  assert.equal(parseShowPage('Show Time: 27:00 pm').showtime, null);
  assert.equal(parseShowPage('Show Time: 7:99 pm').showtime, null);
});

test('the tour index is read for slugs, padded or not', () => {
  // Both paddings appear on the real index; constructing slugs by hand gets it wrong.
  const idx = parseTourIndex(`
    <a href="/tours/dates/fri-2026-05-29-the-wilma/">Missoula</a>
    <a href="/tours/dates/fri-2026-4-17-sphere/">Las Vegas</a>
    <a href="/tours/dates/fri-2026-9-04-dicks-sporting-goods-park/">Commerce City</a>
  `);
  assert.equal(idx.get('2026-05-29'), '/tours/dates/fri-2026-05-29-the-wilma/');
  assert.equal(idx.get('2026-04-17'), '/tours/dates/fri-2026-4-17-sphere/');
  assert.equal(idx.get('2026-09-04'), '/tours/dates/fri-2026-9-04-dicks-sporting-goods-park/');
});

test('venue timezones resolve, including the two non-US venues', () => {
  assert.equal(venueTimezone({ city: 'Commerce City', state: 'CO', country: 'USA' }), 'America/Denver');
  assert.equal(venueTimezone({ city: 'New York', state: 'NY', country: 'USA' }), 'America/New_York');
  assert.equal(venueTimezone({ city: 'Cancun', state: 'Quintana Roo', country: 'Mexico' }), 'America/Cancun');
  assert.equal(venueTimezone({ city: 'Toronto', state: 'Ontario', country: 'Canada' }), 'America/Toronto');
});

test('a city in the minority zone of a split state overrides the state default', () => {
  assert.equal(venueTimezone({ city: 'Nashville', state: 'TN' }), 'America/Chicago');
  assert.equal(venueTimezone({ city: 'Knoxville', state: 'TN' }), 'America/New_York');
});

test('an unmappable venue returns null instead of guessing', () => {
  // A wrong zone locks silently an hour early or late; refusing is recoverable.
  assert.equal(venueTimezone({ city: 'Paris', state: '', country: 'France' }), null);
  assert.equal(venueTimezone({ city: 'Somewhere', state: 'ZZ', country: 'USA' }), null);
  assert.equal(venueTimezone({}), null);
});

test('7:30pm in Denver in September is 01:30 UTC the next day', () => {
  // MDT, UTC-6.
  const d = zonedToUtc('2026-09-04', { hour: 19, minute: 30 }, 'America/Denver');
  assert.equal(d.toISOString(), '2026-09-05T01:30:00.000Z');
});

test('the same wall clock shifts with daylight saving', () => {
  // MST in December is UTC-7, so the same 19:30 lands an hour later in UTC.
  const summer = zonedToUtc('2026-07-04', { hour: 19, minute: 30 }, 'America/Denver');
  const winter = zonedToUtc('2026-12-04', { hour: 19, minute: 30 }, 'America/Denver');
  assert.equal(summer.toISOString(), '2026-07-05T01:30:00.000Z');
  assert.equal(winter.toISOString(), '2026-12-05T02:30:00.000Z');
});

test('a New Years show in New York resolves correctly', () => {
  assert.equal(
    zonedToUtc('2026-12-31', { hour: 20, minute: 0 }, 'America/New_York').toISOString(),
    '2027-01-01T01:00:00.000Z');
});

test('Arizona does not observe daylight saving', () => {
  const summer = zonedToUtc('2026-07-04', { hour: 19, minute: 0 }, 'America/Phoenix');
  const winter = zonedToUtc('2026-12-04', { hour: 19, minute: 0 }, 'America/Phoenix');
  assert.equal(summer.toISOString(), '2026-07-05T02:00:00.000Z');
  assert.equal(winter.toISOString(), '2026-12-05T02:00:00.000Z', 'same offset all year');
});

test('resolveLock uses the published time and reports its source', () => {
  const r = resolveLock({
    showdate: '2026-09-04', city: 'Commerce City', state: 'CO', country: 'USA',
    showtime: { hour: 19, minute: 30 },
  });
  assert.equal(r.lockAt, '2026-09-05T01:30:00.000Z');
  assert.equal(r.source, 'phish.com');
  assert.equal(r.timeZone, 'America/Denver');
  assert.equal(r.local, '19:30');
});

test('resolveLock falls back early, not late, when no time is published', () => {
  const r = resolveLock({ showdate: '2026-09-04', city: 'Commerce City', state: 'CO', country: 'USA' });
  assert.equal(r.source, 'fallback');
  const fallback = zonedToUtc('2026-09-04', FALLBACK_LOCAL_HOUR, 'America/Denver');
  assert.equal(r.lockAt, fallback.toISOString());
  const published = zonedToUtc('2026-09-04', { hour: 19, minute: 30 }, 'America/Denver');
  assert.ok(new Date(r.lockAt) < published, 'the fallback must never land after a typical downbeat');
});

test('resolveLock refuses rather than locking at the wrong hour', () => {
  const r = resolveLock({ showdate: '2026-09-04', city: 'Paris', country: 'France', showtime: { hour: 20, minute: 0 } });
  assert.equal(r.lockAt, null);
  assert.equal(r.source, 'unknown-timezone');
});

const RESOLVED = { lockAt: '2026-09-05T01:30:00.000Z', source: 'phish.com', local: '19:30', timeZone: 'America/Denver' };
const FALLBACK = { lockAt: '2026-09-05T00:00:00.000Z', source: 'fallback', local: '18:00', timeZone: 'America/Denver' };

test('a real showtime survives a failed refresh', () => {
  // This runs on every `npm run fetch`. A transient 403 must not silently swap a 19:30
  // downbeat for the 18:00 fallback and cost everyone 90 minutes of editing.
  const kept = preferResolved(FALLBACK, RESOLVED);
  assert.equal(kept.lockAt, RESOLVED.lockAt);
  assert.equal(kept.source, 'phish.com (retained)', 'retention is visible, not silent');
});

test('a fresh showtime still overrides a stale one, so a moved show propagates', () => {
  const moved = { ...RESOLVED, lockAt: '2026-09-05T02:00:00.000Z', local: '20:00' };
  assert.equal(preferResolved(moved, RESOLVED).lockAt, moved.lockAt);
  assert.equal(preferResolved(moved, RESOLVED).source, 'phish.com');
});

test('with nothing to retain, the fallback is used as-is', () => {
  assert.deepEqual(preferResolved(FALLBACK, undefined), FALLBACK);
  assert.deepEqual(preferResolved(FALLBACK, { lockAt: null, source: 'unknown-timezone' }), FALLBACK);
  assert.deepEqual(preferResolved(FALLBACK, FALLBACK), FALLBACK, 'a prior fallback is not worth retaining');
});

const TABLE = { '2026-09-04': RESOLVED };

test('the lock opens before the downbeat and closes on it', () => {
  const at = Date.parse(TABLE['2026-09-04'].lockAt);
  assert.equal(lockStateFor(TABLE, '2026-09-04', at - 1).locked, false);
  assert.equal(lockStateFor(TABLE, '2026-09-04', at).locked, true, 'locks exactly at the downbeat');
  assert.equal(lockStateFor(TABLE, '2026-09-04', at + 60_000).locked, true);
});

test('a show missing from the table stays open, and says so', () => {
  // Treating absent as locked would make a newly announced date unsavable until the next
  // fetch — a worse failure than the gap it would close.
  const s = lockStateFor(TABLE, '2027-01-01');
  assert.equal(s.locked, false);
  assert.equal(s.known, false);
  assert.equal(lockStateFor({}, '2026-09-04').locked, false);
  assert.equal(lockStateFor(undefined, '2026-09-04').locked, false);
});

test('an unresolved lockAt does not lock', () => {
  assert.equal(lockStateFor({ '2026-09-04': { lockAt: null, source: 'unknown-timezone' } }, '2026-09-04').locked, false);
});

test('the generated Worker table matches the published JSON exactly', async () => {
  // data/showtimes.json is served to the browser for the countdown; the generated module
  // is bundled into the Worker for enforcement. If they disagree, the countdown says one
  // thing and the save is rejected at another.
  const json = JSON.parse(readFileSync(join(root, 'data/showtimes.json'), 'utf8'));
  const { SHOWTIMES } = await import('../src/showtimes.generated.mjs');
  assert.deepEqual(Object.keys(SHOWTIMES).sort(), Object.keys(json.shows).sort());
  for (const [date, v] of Object.entries(SHOWTIMES)) {
    assert.equal(v.lockAt, json.shows[date].lockAt, `${date} lockAt differs`);
    assert.equal(v.source, json.shows[date].source, `${date} source differs`);
    assert.equal(v.local, json.shows[date].local, `${date} local differs`);
    assert.equal(v.timeZone, json.shows[date].timeZone, `${date} timeZone differs`);
  }
});

test('every published lock instant is a real, parseable time', () => {
  const json = JSON.parse(readFileSync(join(root, 'data/showtimes.json'), 'utf8'));
  for (const [date, s] of Object.entries(json.shows)) {
    if (!s.lockAt) continue;
    const at = Date.parse(s.lockAt);
    assert.ok(Number.isFinite(at), `${date} has an unparseable lockAt`);
    // A show locks on its own date or the UTC morning after — anything else means the
    // timezone maths went wrong.
    const dayStart = Date.parse(`${date}T00:00:00Z`);
    assert.ok(at > dayStart && at < dayStart + 36 * 3600_000, `${date} locks at an implausible ${s.lockAt}`);
  }
});
