// Score the saved prediction against the actual setlist.
// Usage: node scripts/score.js [showdate]   (default: the predicted show's date)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const KEY = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/PHISHNET_API_KEY=(\S+)/)[1];

async function main() {
  const showdate = process.argv[2] || JSON.parse(fs.readFileSync(path.join(dataDir, 'analysis.json'), 'utf8')).nextShow.date;

  // Grade the ARCHIVED prediction for this show, not whatever analysis.json currently
  // holds — once NEXT_SHOW moves on, analysis.json is about a different show entirely,
  // and scoring against it would compare a prediction to the wrong setlist.
  const archiveFile = path.join(dataDir, 'archive', `${showdate}.json`);
  let A, archived = null;
  if (fs.existsSync(archiveFile)) {
    archived = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    A = { prediction: archived.prediction, candidates: archived.topCandidates, nextShow: { date: showdate } };
  } else {
    A = JSON.parse(fs.readFileSync(path.join(dataDir, 'analysis.json'), 'utf8'));
    if (A.nextShow.date !== showdate) {
      throw new Error(`No archived prediction for ${showdate}, and analysis.json is about ${A.nextShow.date}. Refusing to score a prediction against the wrong show.`);
    }
  }

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
  // Deduped by slug: a song can legitimately appear several times in one show (the
  // 2026-08-01 Tweezer sandwich hit three times), and listing it once per placement
  // reads as noise rather than three separate surprises.
  const surprises = [...new Map(
    actual.filter(a => !predSlugs.has(a.slug)).map(a => [a.slug, a])
  ).values()];

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
  // Unique songs, so a song played more than once isn't counted repeatedly against
  // (or in favour of) coverage.
  const uniqueActual = [...new Map(actual.map(a => [a.slug, a])).values()];
  const ranks = uniqueActual.map(a => ({ song: a.song, rank: rankOf.get(a.slug) ?? null }));
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
    top40Coverage: `${inTop40}/${uniqueActual.length} actual songs were in our top-40 candidates`,
    top40Hits: inTop40,
    uniqueActualCount: uniqueActual.length,
  };
  fs.writeFileSync(path.join(dataDir, `scorecard-${showdate}.json`), JSON.stringify(report, null, 1));

  // Fold the result back into the archive entry so the app has prediction + outcome in
  // one committed place, without needing the gitignored scorecard-*.json files.
  if (archived) {
    archived.scorecard = report;
    archived.actual = actual.map(a => ({ slug: a.slug, name: a.song, set: a.set }));
    fs.writeFileSync(archiveFile, JSON.stringify(archived, null, 1));
    console.log(`Merged scorecard into data/archive/${showdate}.json`);
  }

  console.log(`\n=== BATHTUB BETS SCORECARD — ${showdate} ===`);
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
