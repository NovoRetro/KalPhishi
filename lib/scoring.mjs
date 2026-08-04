// Pure scoring logic — shared by the Worker (src/worker.js) and the offline Node scripts.
// No I/O, no platform APIs.

export const slugifyName = n => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Absolute points, not a percentage of a fixed budget.
//
// The call cap is what makes this safe to score in absolute points at all. Without it,
// submitting the whole catalogue scores better than predicting a setlist, because every
// extra song is a free chance at a point. Capping calls at 10 means a padded list of 80
// converts 12.7 correct guesses into the same 10 points a real prediction earns.
//
// The cap alone does not finish the job, though: it only suppresses padding to the extent
// it binds on ordinary players, and a cap low enough to deter padding (5) pins 59% of
// honest predictions against it and collapses the scoreboard into a tie. So the soft cap
// below does the deterring and the call cap just bounds the ceiling.
export const SETLIST_POINTS = {
  call: 1,
  callCap: 10,
  placement: 2, // exact index within the set, on top of the call
  opener: 5,    // set 1 and set 2 alike
  s1closer: 4,
  s2closer: 5,
  encoreSong: 2, // per song correctly placed in the encore
  overCap: 1,    // deducted per WRONG guess beyond a soft cap
};

// Deliberately soft. Phish plays 15-song sets and third sets, so a hard limit would
// punish someone for correctly calling a long show. Past these lengths a wrong guess
// costs a point, which is enough: the marginal hit rate never reaches the 50% a 1-point
// penalty needs to break even, at any depth in any ranking.
export const SETLIST_SOFT_CAP = { set1: 10, set2: 10, encore: 5 };

const lastOf = arr => arr[arr.length - 1];

export function scoreSetlistPrediction(payload, actual) {
  const set1 = payload.set1 || [], set2 = payload.set2 || [], encore = payload.encore || [];
  const all = [...set1, ...set2, ...encore];
  const actualSlugs = new Set(actual.map(a => a.slug));
  const bySet = set => actual.filter(a => a.set === set);
  const s1 = bySet('1'), s2 = bySet('2');
  const enc = actual.filter(a => a.set === 'e' || a.set === 'e2');
  const encSlugs = new Set(enc.map(a => a.slug));

  // Calls are counted by unique song. Listing the same song twice is one call, not two —
  // the builder blocks duplicates, but the API accepts whatever it is handed.
  const seen = new Set();
  const hits = [];
  for (const p of all) {
    if (!actualSlugs.has(p.slug) || seen.has(p.slug)) continue;
    seen.add(p.slug);
    hits.push(p);
  }
  const callsCounted = Math.min(hits.length, SETLIST_POINTS.callCap);
  const callPoints = callsCounted * SETLIST_POINTS.call;

  // Placement is the exact index within the set. A song called in set 1 but played in
  // set 2 still earns its call — it just does not earn placement.
  const placements = [];
  for (const [list, actualList, label] of [[set1, s1, '1'], [set2, s2, '2']]) {
    list.forEach((p, i) => {
      if (actualList[i] && actualList[i].slug === p.slug) {
        placements.push({ name: p.name, slug: p.slug, set: label, position: i + 1 });
      }
    });
  }
  const placementPoints = placements.length * SETLIST_POINTS.placement;

  // The encore is scored by membership rather than index: it is two songs on average and
  // its internal order carries far less meaning than a set's.
  const encoreHits = encore.filter(p => encSlugs.has(p.slug));
  const encorePoints = encoreHits.length * SETLIST_POINTS.encoreSong;

  // A one-song list has no distinct closer — its only entry is the opener. Scoring it as
  // both would pay twice for one call, and the builder does not show a CLOSER badge there.
  const stressors = {
    opener: !!(set1[0] && s1[0] && set1[0].slug === s1[0].slug),
    s1closer: !!(set1.length > 1 && s1.length && lastOf(set1).slug === lastOf(s1).slug),
    s2opener: !!(set2[0] && s2[0] && set2[0].slug === s2[0].slug),
    s2closer: !!(set2.length > 1 && s2.length && lastOf(set2).slug === lastOf(s2).slug),
  };
  const stressorPoints =
    (stressors.opener ? SETLIST_POINTS.opener : 0) +
    (stressors.s2opener ? SETLIST_POINTS.opener : 0) +
    (stressors.s1closer ? SETLIST_POINTS.s1closer : 0) +
    (stressors.s2closer ? SETLIST_POINTS.s2closer : 0);

  // Only the entries PAST the cap are exposed, and only when wrong. Penalising every
  // wrong guess in an over-length set would put a 19-point cliff on adding one song.
  const overCap = [];
  for (const [list, cap, label] of [
    [set1, SETLIST_SOFT_CAP.set1, 'set1'],
    [set2, SETLIST_SOFT_CAP.set2, 'set2'],
    [encore, SETLIST_SOFT_CAP.encore, 'encore'],
  ]) {
    const wrong = list.slice(cap).filter(p => !actualSlugs.has(p.slug));
    if (wrong.length) overCap.push({ list: label, count: wrong.length, songs: wrong.map(p => p.name) });
  }
  const penaltyCount = overCap.reduce((s, o) => s + o.count, 0);
  const penaltyPoints = penaltyCount * SETLIST_POINTS.overCap;

  const score = callPoints + placementPoints + encorePoints + stressorPoints - penaltyPoints;

  return {
    // `score` is not floored at zero. Flooring would make a 100-song list cost the same
    // as an 80-song one, and the deduction has to keep biting for it to deter anything.
    score: +score.toFixed(1),
    // `hits` and `stressors` keep their old names so predictions graded under the previous
    // scheme still render in the history list.
    hits: hits.map(h => h.name),
    misses: all.filter(p => !actualSlugs.has(p.slug)).map(p => p.name),
    stressors,
    breakdown: {
      calls: hits.length,
      callsCounted,
      callsCapped: hits.length > SETLIST_POINTS.callCap,
      callPoints,
      placements,
      placementPoints,
      encoreHits: encoreHits.map(p => p.name),
      encorePoints,
      stressorPoints,
      overCap,
      penaltyPoints,
    },
  };
}

export const LINES = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  return lines;
})();

export const FREE = 12;

export function bingoLine(checked) {
  return LINES.find(line => line.every(i => i === FREE || checked[i])) || null;
}

export function scoreBingoPrediction(payload, actual) {
  const actualSlugs = new Set(actual.map(a => a.slug));
  const checked = payload.grid.map((cell, i) => i !== FREE && !!cell && actualSlugs.has(cell.slug));
  const hitCount = checked.filter(Boolean).length;
  const line = bingoLine(checked);
  const score = +(hitCount / 24 * 80 + (line ? 20 : 0)).toFixed(1);
  return { score, hitCount, checked, bingo: !!line, line };
}
