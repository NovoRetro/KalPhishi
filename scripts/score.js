// Score the saved prediction against the actual setlist.
// Usage: node scripts/score.js [showdate]   (default: the predicted show's date)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const KEY = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/PHISHNET_API_KEY=(\S+)/)[1];

async function main() {
  const A = JSON.parse(fs.readFileSync(path.join(dataDir, 'analysis.json'), 'utf8'));
  const showdate = process.argv[2] || A.nextShow.date;

  const res = await fetch(`https://api.phish.net/v5/setlists/showdate/${showdate}.json?apikey=${KEY}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error_message);
  const rows = json.data.filter(r => r.artistid === 1 && r.set !== 's');
  if (!rows.length) {
    console.log(`No setlist posted yet for ${showdate}.`);
    process.exitCode = 2; // let the event loop drain; hard process.exit() trips a libuv assertion on Windows
    return;
  }
  rows.sort((a, b) => a.position - b.position);
  const actual = rows.map(r => ({ slug: r.slug, song: r.song, set: r.set }));
  const actualSlugs = new Set(actual.map(a => a.slug));

  const predSets = { set1: A.prediction.set1, set2: A.prediction.set2, encore: A.prediction.encore };
  const predAll = [...predSets.set1, ...predSets.set2, ...predSets.encore];
  const predSlugs = new Set(predAll.map(p => p.slug));

  // song-level hits
  const hits = predAll.filter(p => actualSlugs.has(p.slug));
  const misses = predAll.filter(p => !actualSlugs.has(p.slug));
  const surprises = actual.filter(a => !predSlugs.has(a.slug));

  // set-placement accuracy among hits
  const actualSetOf = new Map(actual.map(a => [a.slug, a.set]));
  const setHits = [
    ...predSets.set1.filter(p => actualSetOf.get(p.slug) === '1'),
    ...predSets.set2.filter(p => actualSetOf.get(p.slug) === '2'),
    ...predSets.encore.filter(p => ['e', 'e2'].includes(actualSetOf.get(p.slug))),
  ];

  // special slots
  const actOpener = actual.find(a => a.set === '1');
  const actS2Opener = actual.find(a => a.set === '2');
  const actEncore = actual.filter(a => a.set === 'e' || a.set === 'e2');
  const slotChecks = [
    ['Show opener', predSets.set1[0]?.slug === actOpener?.slug, `predicted ${predSets.set1[0]?.name}, actual ${actOpener?.song}`],
    ['Set 2 opener', predSets.set2[0]?.slug === actS2Opener?.slug, `predicted ${predSets.set2[0]?.name}, actual ${actS2Opener?.song}`],
    ['Encore (any overlap)', predSets.encore.some(p => actEncore.some(a => a.slug === p.slug)), `predicted ${predSets.encore.map(p => p.name).join(', ')}, actual ${actEncore.map(a => a.song).join(', ')}`],
  ];

  // where did actual songs sit in our ranked candidate list?
  const rankOf = new Map(A.candidates.map((c, i) => [c.slug, i + 1]));
  const ranks = actual.map(a => ({ song: a.song, rank: rankOf.get(a.slug) ?? null }));
  const ranked = ranks.filter(r => r.rank !== null);
  const inTop40 = ranked.filter(r => r.rank <= 40).length;

  const precision = hits.length / predAll.length;
  const recall = hits.length / new Set(actual.map(a => a.slug)).size;

  const report = {
    showdate,
    predicted: predAll.length,
    actualUnique: actualSlugs.size,
    hits: hits.map(h => h.name),
    misses: misses.map(m => m.name),
    surprises: surprises.map(s => s.song),
    precision: +precision.toFixed(3),
    recall: +recall.toFixed(3),
    setPlacementHits: setHits.map(h => h.name),
    slotChecks: slotChecks.map(([name, ok, detail]) => ({ check: name, ok, detail })),
    actualSongRanks: ranks,
    top40Coverage: `${inTop40}/${actual.length} actual songs were in our top-40 candidates`,
  };
  fs.writeFileSync(path.join(dataDir, `scorecard-${showdate}.json`), JSON.stringify(report, null, 1));

  console.log(`\n=== KALPHISH SCORECARD — ${showdate} ===`);
  console.log(`Predicted ${predAll.length} songs; actual show had ${actualSlugs.size} unique songs.`);
  console.log(`HITS (${hits.length}): ${hits.map(h => h.name).join(', ') || 'none'}`);
  console.log(`Precision ${(precision * 100).toFixed(0)}% · Recall ${(recall * 100).toFixed(0)}%`);
  console.log(`Correct set placement: ${setHits.length}/${hits.length} of hits`);
  for (const [name, ok, detail] of slotChecks) console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  console.log(`Candidate-rank coverage: ${report.top40Coverage}`);
  console.log(`Surprises we never saw coming: ${surprises.map(s => s.song).join(', ') || 'none'}`);
  console.log(`\nSaved data/scorecard-${showdate}.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
