// Assemble data/archive/*.json into a single data/history.json for the web app.
//
// The archive is one file per predicted show (committed — see .gitignore); this flattens
// it into one slim payload the frontend can fetch once and search client-side. Slim
// matters: the archive keeps full candidate lists and raw scorecards for offline
// analysis, but the app only needs what it renders.
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const archiveDir = path.join(dataDir, 'archive');

// The track record is a claim about what THIS app predicted in advance, so it must only
// ever contain shows it actually ran on. The app's first live prediction — under its old
// name, Kalphishi — was the
// 2026-07-31 Fenway show; anything dated earlier could only be a backfill scored against
// a setlist that already existed, which would flatter the numbers and misrepresent the
// model as having called shows it never saw.
const APP_EPOCH = '2026-07-31';

const allFiles = fs.existsSync(archiveDir)
  ? fs.readdirSync(archiveDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  : [];
const files = allFiles.filter(f => f.slice(0, 10) >= APP_EPOCH);
const skipped = allFiles.length - files.length;
if (skipped) {
  console.warn(`skipped ${skipped} archived show(s) dated before ${APP_EPOCH} — predates the app`);
}

const shows = files.map(f => {
  const a = JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
  const sc = a.scorecard;
  return {
    showdate: a.showdate,
    venue: a.venue,
    city: a.city,
    asOf: a.asOf, // the last show the model had data for — evidence it predicted forward
    predicted: {
      set1: a.prediction.set1.map(s => s.name),
      set2: a.prediction.set2.map(s => s.name),
      encore: a.prediction.encore.map(s => s.name),
    },
    // null until the show is played and `npm run score` grades it
    result: sc ? {
      hits: sc.hits,
      misses: sc.misses,
      surprises: sc.surprises,
      precision: sc.precision,
      recall: sc.recall,
      setPlacementHits: sc.setPlacementHits,
      slotChecks: sc.slotChecks,
      top40Hits: sc.top40Hits ?? null,
      uniqueActualCount: sc.uniqueActualCount ?? sc.actualUnique ?? null,
      actual: a.actual || null,
    } : null,
  };
});

const graded = shows.filter(s => s.result);
const summary = graded.length ? {
  showsGraded: graded.length,
  meanPrecision: +(graded.reduce((t, s) => t + s.result.precision, 0) / graded.length).toFixed(3),
  meanRecall: +(graded.reduce((t, s) => t + s.result.recall, 0) / graded.length).toFixed(3),
} : { showsGraded: 0, meanPrecision: null, meanRecall: null };

const out = { generated: new Date().toISOString(), summary, shows };
fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify(out, null, 1));
console.log(`history.json — ${shows.length} archived show(s), ${graded.length} graded`);
