# Kalphishi — state of the project

Everything the account & social roadmap planned is shipped. This file is now the
orientation doc: what exists, how to operate it, what was decided and why, and what is
deliberately left undone. The phase-by-phase plan it replaced is in git history.

**Live:** https://kalphishi.kalphishi.workers.dev
**Repo:** https://github.com/NovoRetro/KalPhishi

---

## What it is

A Phish setlist predictor. It slices 2022+ setlist history several ways to guess the next
show, lets users make their own call (setlist draft or 5×5 PHISH bingo), grades both
against what actually got played, and keeps a public track record of how the *model*
itself has done.

Runs entirely on Cloudflare Workers + D1. No framework, no bundler, no npm runtime
dependencies — `wrangler` is the only devDependency.

---

## Shipped

| | |
|---|---|
| **Auth** | Email + password, PBKDF2 via Web Crypto, `HttpOnly; Secure` cookies, session tokens stored hashed |
| **Account menu** | Hamburger, upper right: identity, history, profile, friends, change password, sign out |
| **Predictor** | Setlist builder (touch drag-reorder) and PHISH bingo, both open to signed-out visitors — auth is only required to *save* |
| **Attendance** | Mark "I was at this show"; accuracy splits by present vs remote |
| **Friends** | Symmetric, established by invite link; no pending-request queue |
| **Groups** | Owner-managed, drawn from your friends; leaderboards scope to Everyone / Friends / a group |
| **Track record** | The model's own graded predictions, searchable, with ← Newer / Older → navigation |
| **Model** | Horizontal (rotation) + vertical (venue) + album slices, set-1/set-2 placement affinity, tour-leg and reset-venue adjustments |

Five D1 migrations, `0001`–`0005`. 87 tests, `npm test`.

---

## Operating it

### Deploys are automatic
Merging to `main` runs `.github/workflows/deploy.yml`: tests → `build:ci` → `wrangler
deploy`. Tests gate it, so a red suite cannot reach production. Requires repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (both set).

**Migrations are deliberately NOT automated.** Schema changes are irreversible against
live user data — run `npx wrangler d1 migrations apply kalphishi --remote` by hand, and
do it *before* merging the code that depends on it.

### Advancing to the next show
The predicted show resolves itself: a show is complete once phish.net publishes its
setlist, and the target becomes the first scheduled date after that. Refreshing the
caches is what moves it:

```bash
rm data/setlists-2026.json data/schedule-2026.json data/songs.json
npm run fetch && npm run analyze && npm run build
```

Then commit the changed `data/*.json` and push — that push deploys. Nothing is hardcoded
to a date or venue any more; the venue history, the "played at X Nx before" reasoning and
the "Gap at ..." column all follow whatever resolves.

### Which data files are committed, and why
`data/*.json` is gitignored **except** the five the site serves — `analysis.json`,
`songs.json`, `venues.json`, `songmeta.json`, `history.json` — plus `data/archive/*.json`.

- The five are committed so CI can deploy without a phish.net key or minutes of fetching.
- The archive is committed because it holds point-in-time predictions that **cannot be
  regenerated** once `analysis.json` advances. Losing it would destroy the accuracy record
  permanently. `test/assets.test.mjs` guards the gitignore pattern against being broadened
  to `data/**/*.json`, which would silently stop tracking it.
- The ~14MB of raw setlist caches stay ignored; they are only inputs.

---

## Decisions already settled — don't re-litigate

- **Email is unverified.** Registration is happy-path: any well-formed address is accepted,
  no confirmation. Sending mail needs a provider + verified domain + DNS, which is real
  work for little gain at this scale. Consequence: **no "forgot password"** — recovery is a
  manual D1 update.
- **`MIN_PASSWORD_LENGTH` is temporarily 6**, lowered from 12 for testing convenience.
  Raise it before this matters. Flagged in `src/auth.mjs`, README, and the test asserting
  the floor.
- **Three identifiers, not one.** `id` internal (never sent to clients), `email` the login,
  `handle` the public profile URL. Fixed a real leak where profile URLs exposed a
  slugified email.
- **Friends are symmetric and accept-free.** Redeeming a link friends both parties
  immediately. Groups are owner-managed and drawn only from friends, so the invite link is
  the single way to connect.
- **Attendance is self-reported.** No ticket integration, no geofence. Nothing downstream
  should treat it as verified.
- **The global leaderboard stays** as one scope option alongside Friends and groups.

---

## Deliberate behaviours that look like bugs

- Re-redeeming an invite you already used **succeeds** (and doesn't burn a use) rather
  than erroring — re-opening a link should reassure, not fail.
- Revoking someone else's invite, or deleting someone else's group, is a **silent no-op**,
  not a 403 — a 403 would confirm the thing exists.
- `/api/songmeta` returns **404**; it was replaced by the static `/data/songmeta.json`,
  which is what keeps 9MB of setlist dumps out of the deploy.
- The track record shows **nothing before 2026-07-31**, the app's first live prediction.
  A backfilled show would be graded against a setlist that already existed, inflating the
  numbers and claiming the model called shows it never saw.
- The prediction currently targets **September 4**, a month out. Correct — the Fenway run
  is finished and Dick's is genuinely next.

---

## Gotchas that cost time

- **Cloudflare's edge lags a deploy** by up to a couple of minutes, and its cache key
  ignores query strings — cache-busting URLs don't help, only waiting does. This produced
  three separate false "the deploy is broken" moments. Don't trust an immediate
  post-deploy check.
- **Local D1 state is keyed by `database_id`.** Changing it in `wrangler.jsonc` silently
  points `wrangler dev` at an empty database.
- **Multi-statement `--command` can crash mid-way** on Windows without applying anything.
  Run one statement per invocation.
- **User ids are random now** (`u-<uuid>`), not slugs. Cleanup queries must target
  `handle`, not `id` — targeting `id` matches nothing and silently no-ops.
- **CSS: same specificity means source order decides.** A phone breakpoint placed *before*
  the base rule it overrides does nothing. Encoded as a test.
- **`predictor.js` rebuilds its own `<h2>` on render**, so anything bound directly to that
  heading is discarded. Collapse uses delegation + a MutationObserver for this reason.
- **Deploys need `data/`**, so a fresh clone cannot run `npm run build` — only
  `npm run build:ci`, which uses the committed artifacts.

---

## Open / not started

1. **Email verification** — deferred by design (above). Needs a provider, a sending
   domain, DNS, then a token flow. Only worth it if this outgrows people you can text.
2. **Raise the password floor** back to 12 before real use.
3. **Attendance granularity** — keyed on `showdate`; confirm Phish never plays two shows
   on one date (festivals?).
4. **Open registration is unrate-limited and unverified.** Fine at this scale, but the
   site is public and strangers have already signed up (`santos`, `novoretro` are real,
   unsolicited registrations — leave them alone).
5. **GitHub Actions warns** that `checkout@v4` / `setup-node@v4` / `wrangler-action@v3`
   target the deprecated Node 20 and are being forced onto 24. Harmless; bump when new
   majors ship.

---

## Key files

| Path | What |
|---|---|
| `src/worker.mjs` | Every route, one linear if-chain on pathname |
| `src/auth.mjs` | PBKDF2, cookies, sessions — Web Crypto only, so it tests in plain Node |
| `src/db.mjs` | D1 queries; `publicUser`/`publicName` are the "never leak an email" boundary |
| `lib/` | Pure, unit-tested logic: `scoring`, `identity`, `tourleg`, `phishnet-core` |
| `web/index.html` | Shell, all CSS, dashboard script, account menu, auth modal, track record |
| `web/predictor.js` | The signed-in app: builder, bingo, history, profile |
| `scripts/analyze.js` | The model. `resolveNextShow()` is what makes it self-advancing |
| `scripts/build-public.js` | Publish allowlist — an explicit list, not a filter, so secrets cannot leak |
| `migrations/` | `0001` schema → `0005` groups |
