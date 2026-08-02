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
// measurably breaks down: MSG, Dick's, and Sphere all showed elevated (often 2-3x)
// carryover from the days immediately before the run into the run itself, compared to
// the dataset's normal same-window baseline (2022-2026, every valid road-to-venue
// transition — 9 MSG, 3 Dick's, 1 Sphere debut — pointed the same direction). Plausible
// reading: multi-night stands at these venues draw from the same freshly-rehearsed
// repertoire as the shows right before them, rather than avoiding it.
//
// Festivals are named in the original hypothesis but unvalidated — none appear in the
// 2022-2026 window this was tested against. Add a pattern here only once one actually
// shows up and can be checked the same way, not on assumption.
const RESET_VENUE_RE = /madison square garden|dick's sporting goods|sphere/i;

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
