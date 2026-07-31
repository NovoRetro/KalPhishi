// Pure scoring logic — shared by the Worker (src/worker.js) and the offline Node scripts.
// No I/O, no platform APIs.

export const slugifyName = n => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const SETLIST_WEIGHTS = { hits: 70, opener: 6, s1closer: 6, s2opener: 6, s2closer: 6, encore: 6 };

export function scoreSetlistPrediction(payload, actual) {
  const actualSlugs = new Set(actual.map(a => a.slug));
  const all = [...payload.set1, ...payload.set2, ...payload.encore];
  const hits = all.filter(p => actualSlugs.has(p.slug));
  const bySet = set => actual.filter(a => a.set === set);
  const s1 = bySet('1'), s2 = bySet('2');
  const enc = actual.filter(a => a.set === 'e' || a.set === 'e2');
  const stressors = {
    opener: !!(payload.set1[0] && s1[0] && payload.set1[0].slug === s1[0].slug),
    s1closer: !!(payload.set1.length && s1.length && payload.set1[payload.set1.length - 1].slug === s1[s1.length - 1].slug),
    s2opener: !!(payload.set2[0] && s2[0] && payload.set2[0].slug === s2[0].slug),
    s2closer: !!(payload.set2.length && s2.length && payload.set2[payload.set2.length - 1].slug === s2[s2.length - 1].slug),
    encore: payload.encore.some(p => enc.some(a => a.slug === p.slug)),
  };
  let score = all.length ? (hits.length / all.length) * SETLIST_WEIGHTS.hits : 0;
  for (const [k, ok] of Object.entries(stressors)) if (ok) score += SETLIST_WEIGHTS[k];
  return {
    score: +score.toFixed(1),
    hits: hits.map(h => h.name),
    misses: all.filter(p => !actualSlugs.has(p.slug)).map(p => p.name),
    stressors,
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
