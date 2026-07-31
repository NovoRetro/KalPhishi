# Kalphishi

A Phish setlist prediction tool. Phish have played 40+ years without ever repeating a setlist — Kalphishi slices that history two ways to guess what's coming next, then lets you make your own call and keeps score.

Powered by [NovoRetro](https://github.com/NovoRetro). Data from the [Phish.net API](https://docs.phish.net).

## What it does

**Horizontal slice — the current tour.** Every song's rotation cadence across the modern era (2022+), how long since it last appeared, and where it sits in the tour's repeat rhythm. Surfaces two watchlists: *due back up* (in rotation, repeat window open) and *conspicuously absent* (era staples with zero plays this tour).

**Vertical slice — the venue.** Every prior Phish show at the venue being played next, with setlists side by side and songs overlapping the current candidate list highlighted. Search any of ~1,700 venues to generate the same slice on demand.

**Album slice.** Studio-album representation across the tour, plus each show's "era center of gravity" (mean release year of its album songs) — which is how the 2026 MSG residency shows up as a deliberate trip backwards through the catalog.

**Prediction.** A slot-aware ranked setlist (opener, set closers, encore) combining rotation strength, dueness, tour-repeat penalties, and venue affinity.

**Your predictions.** Draft a setlist with drag-to-reorder and stressor bonuses for opener/closer/encore calls, or fill a 5×5 **PHISH bingo** card (free donut center, five-in-a-line wins) and check squares off live during the show. Scores are graded against the real setlist; accuracy ratings and a leaderboard accumulate over time.

## Architecture

The app runs on Cloudflare Workers with a D1 (SQLite) database — accounts, predictions, and sessions live in D1, and the dashboard is served as static assets. The data pipeline stays offline: `scripts/` fetch from phish.net and MusicBrainz on your machine and produce the JSON artifacts that get published with each deploy.

## Setup

Requires Node 18+ and a free [phish.net API key](https://phish.net/api/keys).

```bash
cp .env.example .env   # then paste your key in
npm run fetch          # cache setlists, songs, venues (a few minutes)
npm run fetch:albums   # album tracklists from MusicBrainz
npm run analyze        # build data/analysis.json
```

`data/` is gitignored — it's a local cache of third-party API responses, all regenerable from the commands above.

## Running locally

```bash
cp .dev.vars.example .dev.vars    # phish.net key + an ADMIN_TOKEN for local use
npm run build                     # precompute songmeta.json, assemble public/
npx wrangler d1 migrations apply kalphishi --local
npm run dev                       # dashboard at http://localhost:8788
```

## Deploying

```bash
npx wrangler d1 create kalphishi   # paste the database_id into wrangler.jsonc
npx wrangler d1 migrations apply kalphishi --remote
npx wrangler secret put PHISHNET_API_KEY
npx wrangler secret put ADMIN_TOKEN   # openssl rand -hex 32
npm run deploy
```

`npm run build` copies an explicit six-file allowlist into `public/` (see `scripts/build-public.js`); nothing else is ever uploaded, so `.env` and local caches cannot be served. Deploys run from a machine with a populated `data/`.

## Scoring a show afterward

Scoring runs automatically: a cron trigger checks a few times a day for shows with unscored predictions and grades them once phish.net posts the setlist. To force it manually:

```bash
curl -X POST https://<your-worker-url>/api/score/2026-07-31 -H "x-admin-token: $ADMIN_TOKEN"
```

To grade the *model's* prediction (a local report, separate from user scoring):

```bash
npm run score          # defaults to the next show in data/analysis.json
```

## How predictions are scored

**Setlist** — 70 points pro-rata for songs that appear, plus 6 each for five stressors: show opener, Set 1 closer, Set 2 opener, Set 2 closer, and any encore hit. Max 100.

**Bingo** — 80 points pro-rata across the 24 fillable squares, plus 20 for completing a line.

A user's accuracy rating is the mean score across their graded predictions.

## Notes

- Predictions are chalk by design — they lean on rotation math and won't call a themed show or a 1,000-show bustout. The *conspicuously absent* table is where those hide.
- Auth is PBKDF2-HMAC-SHA-256 with `HttpOnly; Secure` cookie sessions; session tokens are stored hashed, so a database leak yields nothing usable. Cloudflare caps PBKDF2 at 100k iterations and the free plan allows 10ms CPU per request, which puts the work factor below OWASP's 600k recommendation — hence the 12-character minimum password. Fine for an app where accounts control nothing but Phish predictions; don't copy this KDF into something that matters more.

## License

MIT
