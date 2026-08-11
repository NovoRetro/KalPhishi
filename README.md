# Bathtub Bets

A Phish setlist prediction tool. Phish have played 40+ years without ever repeating a setlist — Bathtub Bets slices that history two ways to guess what's coming next, then lets you make your own call and keeps score.

**▶ [Play it here](https://kalphishi.kalphishi.workers.dev)** — no install, create an account to make predictions.

> Formerly **Kalphishi**. This rename covers the product name only — the Worker, the D1
> database, the session cookie and the live URL all still read `kalphishi`, which is why the
> `wrangler` commands below and the link above are literal rather than stale. Renaming those
> is a separate and breaking job; see the handoff.

Powered by [NovoRetro](https://github.com/NovoRetro). Data from the [Phish.net API](https://docs.phish.net).

## What it does

**Horizontal slice — the current tour.** Every song's rotation cadence across the modern era (2022+), how long since it last appeared, and where it sits in the tour's repeat rhythm. Surfaces two watchlists: *due back up* (in rotation, repeat window open) and *conspicuously absent* (era staples with zero plays this tour).

**Vertical slice — the venue.** Every prior Phish show at the venue being played next, with setlists side by side and songs overlapping the current candidate list highlighted. Search any of ~1,700 venues to generate the same slice on demand.

**Album slice.** Studio-album representation across the tour, plus each show's "era center of gravity" (mean release year of its album songs) — which is how the 2026 MSG residency shows up as a deliberate trip backwards through the catalog.

**Tour-calendar position.** Two quiet scoring nudges, both validated empirically against 2022-2026 before being added (see `lib/tourleg.mjs`):
- *Leg-end jam intensity* — the 1-2 shows right before a multi-week break (e.g. the run into Dick's Labor Day stand) historically skew toward extended/jam-chart-worthy playing over rarer songs. Detected from the forward schedule (a real calendar gap, not a show-count position — tour naming alone isn't consistent enough to find these boundaries), and applied as a small bonus scaled by each song's own historical jam-chart rate.
- *Reset venues* — MSG, Dick's, and Sphere measurably do *not* avoid material from the days right before them the way a normal tour show does; carryover ran 2-3x the dataset's baseline at every validated instance. The usual "just played it recently" penalty is softened (not removed) when the next show is at one of these.

**Prediction.** A slot-aware ranked setlist (opener, set closers, encore) combining rotation strength, dueness, tour-repeat penalties, venue affinity, and tour-calendar position.

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

## Moderating an account

Registration is open and unverified, so an offensive name can turn up at any time. The sanitiser in `lib/identity.mjs` blocks lookalike and invisible-character names, but a plainly offensive well-formed one passes it. Both endpoints use the same admin token as scoring.

List the accounts — no email or internal id is returned, since moderation works from the public handle:

```bash
curl https://<your-worker-url>/api/admin/users -H "x-admin-token: $ADMIN_TOKEN"
```

Rename one. The display name goes through the same sanitiser as self-service editing, and the handle is validated and checked for collisions. Change both: renaming the display name alone leaves an offensive handle in the profile URL.

```bash
curl -X PATCH https://<your-worker-url>/api/admin/users/<handle> -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"displayName":"Renamed Phan","handle":"renamed-phan"}'
```

Ban one. Sessions are revoked immediately, it can no longer sign in, and it disappears from the leaderboard, friend lists, public profiles and per-show prediction listings.

```bash
curl -X PATCH https://<your-worker-url>/api/admin/users/<handle> -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"banned":true,"reason":"offensive display name"}'
```

Send `{"banned":false}` to lift it. **A ban deletes nothing** — predictions are preserved so graded shows and the model's track record stay consistent, and they reappear if the ban is lifted.

## How predictions are scored

**Setlist** — 1 point per song called correctly anywhere in the show, capped at 10, plus 2 more if it lands at the exact slot it was predicted in. Openers are worth 5 each, the Set 2 closer 5, the Set 1 closer 4, and each song correctly placed in the encore 2. Lists longer than 10 / 10 / 5 are allowed — Phish plays long sets — but past that a wrong guess costs a point, which is what stops padding a list from beating predicting the show.

**Bingo** — 80 points pro-rata across the 24 fillable squares, plus 20 for completing a line.

The two are different scales and are never averaged into one figure: a setlist result is an absolute point total, a bingo result is out of 100.

Predictions lock at the show's published start time (see `scripts/fetch-showtimes.js`) and cannot be edited afterwards. Checking squares off live during the show still works — that is not part of the prediction.

## Notes

- Predictions are chalk by design — they lean on rotation math and won't call a themed show or a 1,000-show bustout. The *conspicuously absent* table is where those hide.
- Auth is PBKDF2-HMAC-SHA-256 with `HttpOnly; Secure` cookie sessions; session tokens are stored hashed, so a database leak yields nothing usable. Cloudflare caps PBKDF2 at 100k iterations and the free plan allows 10ms CPU per request, which puts the work factor below OWASP's 600k recommendation — a longer minimum password normally compensates for that. It's temporarily lowered to 6 characters (`MIN_PASSWORD_LENGTH` in `src/auth.mjs`) to make user testing easier; raise it back before this matters for real. Fine for an app where accounts control nothing but Phish predictions; don't copy this KDF into something that matters more.
- Email registration is happy-path for now: any well-formed address is accepted immediately, no confirmation step. Real verification is deferred — see the roadmap's Phase 6.

## License

MIT
