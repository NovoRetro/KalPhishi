# Kalphishi

A Phish setlist prediction tool. Phish have played 40+ years without ever repeating a setlist — Kalphishi slices that history two ways to guess what's coming next, then lets you make your own call and keeps score.

Powered by [NovoRetro](https://github.com/NovoRetro). Data from the [Phish.net API](https://docs.phish.net).

## What it does

**Horizontal slice — the current tour.** Every song's rotation cadence across the modern era (2022+), how long since it last appeared, and where it sits in the tour's repeat rhythm. Surfaces two watchlists: *due back up* (in rotation, repeat window open) and *conspicuously absent* (era staples with zero plays this tour).

**Vertical slice — the venue.** Every prior Phish show at the venue being played next, with setlists side by side and songs overlapping the current candidate list highlighted. Search any of ~1,700 venues to generate the same slice on demand.

**Album slice.** Studio-album representation across the tour, plus each show's "era center of gravity" (mean release year of its album songs) — which is how the 2026 MSG residency shows up as a deliberate trip backwards through the catalog.

**Prediction.** A slot-aware ranked setlist (opener, set closers, encore) combining rotation strength, dueness, tour-repeat penalties, and venue affinity.

**Your predictions.** Draft a setlist with drag-to-reorder and stressor bonuses for opener/closer/encore calls, or fill a 5×5 **PHISH bingo** card (free donut center, five-in-a-line wins) and check squares off live during the show. Scores are graded against the real setlist; accuracy ratings and a leaderboard accumulate over time.

## Setup

Requires Node 18+ and a free [phish.net API key](https://phish.net/api/keys).

```bash
cp .env.example .env   # then paste your key in
npm run fetch          # cache setlists, songs, venues (a few minutes)
npm run fetch:albums   # album tracklists from MusicBrainz
npm run analyze        # build data/analysis.json
npm start              # dashboard at http://localhost:5177
```

`data/` is gitignored — it's a local cache of third-party API responses plus your user database, all regenerable (except accounts) from the commands above.

## Scoring a show afterward

```bash
npm run score          # grade the model's prediction
npm run score:users    # grade all user predictions
```

Both default to the next show in `data/analysis.json`; pass a date (`node scripts/score.js 2026-07-31`) to target another.

## How predictions are scored

**Setlist** — 70 points pro-rata for songs that appear, plus 6 each for five stressors: show opener, Set 1 closer, Set 2 opener, Set 2 closer, and any encore hit. Max 100.

**Bingo** — 80 points pro-rata across the 24 fillable squares, plus 20 for completing a line.

A user's accuracy rating is the mean score across their graded predictions.

## Notes

- Predictions are chalk by design — they lean on rotation math and won't call a themed show or a 1,000-show bustout. The *conspicuously absent* table is where those hide.
- Auth is scrypt password hashing with HttpOnly cookie sessions, no dependencies. It runs over plain HTTP, so put HTTPS in front of it before exposing it beyond a trusted network.
- The JSON-file store is single-writer — fine at friends scale, not for a public deployment.

## License

MIT
