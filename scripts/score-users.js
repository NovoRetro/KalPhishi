// Score all user predictions for a show, without needing the server running.
// Usage: node scripts/score-users.js [showdate]
const path = require('path');
const { readDb, writeDb, scoreSetlistPrediction, scoreBingoPrediction, fetchActualSetlist, userStats } =
  require(path.join(__dirname, '..', 'server.js'));

async function main() {
  const showdate = process.argv[2] || JSON.parse(
    require('fs').readFileSync(path.join(__dirname, '..', 'data', 'analysis.json'), 'utf8')).nextShow.date;
  const actual = await fetchActualSetlist(showdate);
  if (!actual.length) {
    console.log(`No setlist posted yet for ${showdate}.`);
    process.exitCode = 2;
    return;
  }
  const db = readDb();
  const targets = db.predictions.filter(p => p.showdate === showdate);
  if (!targets.length) { console.log(`No user predictions for ${showdate}.`); return; }
  for (const p of targets) {
    p.result = p.type === 'setlist'
      ? scoreSetlistPrediction(p.payload, actual)
      : scoreBingoPrediction(p.payload, actual);
    p.scoredAt = new Date().toISOString();
  }
  writeDb(db);
  console.log(`Scored ${targets.length} user prediction(s) for ${showdate}:`);
  for (const p of targets) {
    const u = db.users.find(x => x.id === p.userId);
    const extra = p.type === 'bingo' ? ` (${p.result.hitCount}/24${p.result.bingo ? ', BINGO 🍩' : ''})` : ` (${p.result.hits.length} hits)`;
    console.log(`  ${u?.name || p.userId} · ${p.type} · score ${p.result.score}${extra}`);
    console.log(`    lifetime: accuracy ${userStats(db, p.userId).accuracy} over ${userStats(db, p.userId).scored} scored`);
  }
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
