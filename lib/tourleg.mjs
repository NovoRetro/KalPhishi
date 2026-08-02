// Detects whether a show sits at the close of a touring leg — the last show (or two)
// before a multi-week gap, like the break before Phish's Labor Day stand at Dick's.
//
// This is deliberately a date-gap check against the *schedule*, not a show-count
// position within the tour. Comparable past legs ran 19-26 shows each, and the
// "tourname" field on record isn't reliable for finding leg boundaries either — some
// years split one continuous leg-then-break-then-closer shape into two separate tour
// names, others don't. A big gap immediately after a show is the one signal that holds
// across all of them.

const DAY_MS = 86_400_000;

// schedule: rows shaped like the /shows/showyear API response — one row per show-date,
// not one row per song (that's the /setlists endpoint). Only artistid 1 (the actual
// band, not side projects or guest sits-in) counts toward the sequence.
// Venues where the "just played it recently, unlikely to repeat so soon" assumption
// measurably breaks down: carryover from the days immediately before the run into the
// run itself runs well above the dataset's normal same-window baseline. Plausible
// reading: multi-night stands at these venues draw from the same freshly-rehearsed
// repertoire as the shows right before them, rather than avoiding it.
//   - MSG, Dick's, Sphere: 2022-2026, every valid road-to-venue transition (9 MSG,
//     3 Dick's, 1 Sphere debut) showed 2-3x the baseline. Strong, repeated signal.
//   - Moon Palace (the annual Mexico destination trip): 4 of 4 valid instances
//     (2023-2026 — 2022 excluded, no prior show on record at the start of the
//     dataset) ran 35-59% carryover against a 19.2% baseline. Same strength as MSG/
//     Dick's despite being a very different kind of "reset."
//   - The Woodlands, Dover DE (Mondegreen festival grounds — initially misidentified
//     here as a 2017 event; it's actually 2024): 58% carryover vs an 18.7% baseline.
//   - Watkins Glen International (Magnaball, Curveball): one clean instance —
//     Magnaball 2015, 67% vs 39%. Same direction, but one data point, not several;
//     revisit if a future festival there gives a second reading.
const RESET_VENUE_RE = /madison square garden|dick's sporting goods|sphere|watkins glen|the woodlands|moon palace/i;

export const isResetVenue = venueName => RESET_VENUE_RE.test(venueName || '');

export function isNearTourGap(showdate, schedule, { gapDays = 9, windowShows = 2 } = {}) {
  const dates = [...new Set(schedule.filter(s => s.artistid === 1).map(s => s.showdate))].sort();
  const idx = dates.indexOf(showdate);
  if (idx === -1) return false; // not on the schedule at all — nothing to reason about

  // Only the show actually being queried gets to claim "nothing comes after this at
  // all" — a lookahead position running off the end of the array just means our data
  // doesn't reach that far yet, not that a real gap exists there.
  if (idx === dates.length - 1) return true;

  for (let i = idx; i < idx + windowShows && i < dates.length - 1; i++) {
    const gap = (new Date(dates[i + 1]) - new Date(dates[i])) / DAY_MS;
    if (gap >= gapDays) return true;
  }
  return false;
}
