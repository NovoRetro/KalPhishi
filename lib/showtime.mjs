// When a show starts, as an absolute instant — the moment predictions lock.
//
// phish.net has no showtime at all, so this comes from phish.com's tour date pages, which
// publish it as free text ("Show Time: 7:30 pm") with NO timezone stated. The zone has to
// be inferred from the venue, and the resolution to UTC happens offline in
// scripts/fetch-showtimes.js where the full ICU database is available. The Worker only
// ever compares a stored ISO instant against now, so it needs none of this.

// Doors and showtime both appear; the lock uses showtime, since doors is 60-90 minutes
// before anything is played.
// Whitespace is permitted before the colon: stripping tags turns "<b>Time</b>:" into
// "Time :", so anchoring tightly to "Time:" fails on perfectly ordinary markup.
const SHOWTIME_RE = /Show\s*Time\s*:\s*(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i;
const DOORS_RE = /Doors\s*Open\s*:\s*(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i;

function parseClock(match) {
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const pm = match[3].toLowerCase() === 'p';
  if (hour === 12) hour = 0;          // 12:30 am is 00:30; 12:30 pm is 12:30
  if (pm) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Pull the show and doors times out of a phish.com tour date page. */
export function parseShowPage(html) {
  // Tags become spaces rather than vanishing, so "7:30<br>pm" cannot fuse into a
  // different token; runs are then collapsed so the patterns see a predictable shape.
  const stripped = String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/gi, ' ').replace(/\s+/g, ' ');
  return {
    showtime: parseClock(stripped.match(SHOWTIME_RE)),
    doors: parseClock(stripped.match(DOORS_RE)),
  };
}

/** Canonical /tours/dates/<slug>/ links from the tours index, keyed by ISO date. */
export function parseTourIndex(html) {
  const found = new Map();
  // Slugs are day-of-week, then a date whose month is sometimes zero-padded and sometimes
  // not (fri-2026-05-29-the-wilma vs fri-2026-4-17-sphere), so they are read rather than
  // constructed — building one by hand gets the padding wrong half the time.
  const re = /\/tours\/dates\/([a-z]{3})-(\d{4})-(\d{1,2})-(\d{1,2})-([a-z0-9-]+)\//gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const [, , year, month, day] = m;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!found.has(iso)) found.set(iso, m[0]);
  }
  return found;
}

// Venue timezones. Phish has played 55 distinct venues since 2022, only two outside the
// US, so a state-level map plus a handful of overrides covers everything without pulling
// in a geocoding dependency. States that genuinely straddle a boundary are listed at
// their DOMINANT zone and corrected by city below — Phish plays Austin and Houston, not
// El Paso; Miami and Tampa, not Pensacola.
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago',
  ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit',
  MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver',
  NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York',
  NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago',
  TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York',
  WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
};

// City-level corrections, for venues in the minority zone of a split state and for the
// non-US venues. Keyed 'city|state'.
const CITY_TZ = {
  'cancun|quintana roo': 'America/Cancun',
  'toronto|ontario': 'America/Toronto',
  'knoxville|tn': 'America/New_York',   // East Tennessee is Eastern, Nashville is Central
  'chattanooga|tn': 'America/New_York',
  'el paso|tx': 'America/Denver',
  'pensacola|fl': 'America/Chicago',
};

/**
 * IANA zone for a venue. Returns null rather than guessing — a wrong zone silently locks
 * an hour early or late, which is worse than refusing and falling back visibly.
 */
export function venueTimezone({ city, state, country } = {}) {
  const key = `${String(city || '').trim().toLowerCase()}|${String(state || '').trim().toLowerCase()}`;
  if (CITY_TZ[key]) return CITY_TZ[key];
  const c = String(country || 'USA').trim().toUpperCase();
  if (c && !['USA', 'US', 'UNITED STATES', ''].includes(c)) return null;
  return STATE_TZ[String(state || '').trim().toUpperCase()] || null;
}

// Offset of a zone at a given instant, in ms. Formats the instant in the zone and reads
// the wall clock back as if it were UTC; the difference is the offset.
function offsetAt(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const f = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour % 24, +f.minute, +f.second);
  return asUtc - instantMs;
}

/**
 * Wall-clock time in a zone -> absolute instant.
 *
 * Applied twice because the offset depends on the instant we are solving for: near a DST
 * boundary the first guess can land on the wrong side and report the wrong offset. Phish
 * plays outdoor summer runs and a New Year's stand, so this is not hypothetical.
 */
export function zonedToUtc(isoDate, { hour, minute }, timeZone) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const naive = Date.UTC(y, mo - 1, d, hour, minute, 0);
  let instant = naive - offsetAt(naive, timeZone);
  const corrected = naive - offsetAt(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/**
 * Choose between a freshly resolved lock and whatever was resolved last time.
 *
 * A previously published time beats a fresh fallback. Once this runs on every data
 * refresh, a transient 403 or a momentary network failure would otherwise quietly
 * downgrade a real 19:30 downbeat to the 18:00 fallback and take 90 minutes off everyone's
 * editing window — a silent regression, on a schedule.
 *
 * A fresh phish.com answer always wins, so a genuinely moved showtime still propagates.
 */
export function preferResolved(fresh, prior) {
  if (fresh && fresh.source === 'phish.com' && fresh.lockAt) return fresh;
  if (prior && prior.source === 'phish.com' && prior.lockAt) {
    return { ...prior, source: 'phish.com (retained)' };
  }
  return fresh;
}

// Used when phish.com publishes no time, or the page cannot be read. Deliberately early:
// locking a little before the real downbeat costs someone a late edit, while locking late
// lets them edit after songs have been played, which corrupts the result outright.
export const FALLBACK_LOCAL_HOUR = { hour: 18, minute: 0 };

/**
 * Whether a show's predictions are closed, from a resolved showtime table.
 *
 * A show missing from the table stays OPEN. The table only covers upcoming scheduled
 * shows, so treating "absent" as locked would make a newly announced date unsavable until
 * the next fetch — breaking the app for everyone to close a gap that already has two other
 * guards: a scored prediction is uneditable regardless, and scoring runs three times a day.
 * The fetcher covering every upcoming show is what makes this safe; `known: false` is
 * surfaced so it is visible rather than silent.
 */
export function lockStateFor(showtimes, showdate, now = Date.now()) {
  const s = (showtimes || {})[showdate];
  if (!s || !s.lockAt) return { known: false, locked: false, lockAt: null };
  return {
    known: true,
    locked: now >= Date.parse(s.lockAt),
    lockAt: s.lockAt,
    source: s.source ?? null,
    local: s.local ?? null,
    timeZone: s.timeZone ?? null,
  };
}

/**
 * Resolve a show to the instant its predictions lock.
 * @returns {{lockAt: string|null, source: string, timeZone: string|null, local: string|null}}
 */
export function resolveLock({ showdate, city, state, country, showtime }) {
  const timeZone = venueTimezone({ city, state, country });
  if (!timeZone) {
    return { lockAt: null, source: 'unknown-timezone', timeZone: null, local: null };
  }
  const clock = showtime || FALLBACK_LOCAL_HOUR;
  const source = showtime ? 'phish.com' : 'fallback';
  const at = zonedToUtc(showdate, clock, timeZone);
  const local = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  return { lockAt: at.toISOString(), source, timeZone, local };
}
