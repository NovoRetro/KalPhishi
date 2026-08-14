# Bathtub Bets — state of the project

**Live:** https://kalphishi.kalphishi.workers.dev
**Repo:** https://github.com/NovoRetro/KalPhishi

> **Renamed from Kalphishi.** The rename is the *product name* — everything a person reads.
> Deliberately **not** renamed, because each would break something live:
> the Worker name and D1 `database_name` in `wrangler.jsonc` (a new name deploys a second
> Worker at a new URL and unbinds the database), `SESSION_COOKIE = 'kalphishi_session'` and
> the `kalphish-user` / `kalphishi-pending-invite` browser keys (renaming signs every tester
> out and drops invites mid-redemption), the `window.Kalphishi*` globals, the repo, and the
> `0001_schema.sql` comment. `wrangler` commands in this doc are literal for that reason.
> `'kalphishi'` also stays in the reserved-handle list — a retired brand is exactly what
> somebody would register to look official.

**Written:** 2026-08-14, late (replaces the earlier 2026-08-14 version, which predates the
reach listing, the Nerd Zone merge, the diagnostics, and both model experiments)

> **Production is current and nothing is unmerged.** `main` is at `3c92d80`, everything on it
> is deployed and green, **272 tests pass**, and **no migrations are pending**
> (`0008_invite_groups.sql` is applied to remote). The working tree is clean.
>
> The previous version of this doc opened by saying `nerd-zone` was code-complete and
> unmerged. It is merged. There is no outstanding branch.

Still **closed beta** (~30 testers). The URL is public and registration is open, but this is
not a public launch — say "in beta," never "launched."

---

## Current goal

**Accumulate graded predictions.** The track record holds **one graded show**. Everything the
model claims rests on the walk-forward backtest, not on live results, and that only changes
when real people predict real shows. Dick's is **2026-09-04 to 09-06** (Fri/Sat/Sun, Labor Day
weekend), about three weeks out, and is the best available shot at a burst of them.

**The remaining blocker is not code, and has not been for a while.** Every in-app blocker is
closed — group onboarding, invite reach, day-one empty states, password recovery, the first-run
wizard, the pre-lock nudge. What was missing was *reach*: nothing the app can do touches a
tester who does not open it, and there is deliberately no mail, no service worker and no push.

That is now as solved as it is going to get before Dick's, in two halves:

- **The campaign is written** — `reach.md`, six messages over three weeks, ready to paste.
- **The targeting exists** — `GET /api/admin/reach` answers "who has not predicted the next
  open show", per game, so the messages can be aimed and checked afterwards.

**What has not happened is a human sending message 1.** That is the single highest-value action
available and it needs no code. If only one thing happens before the show, make it that.

## Done

### This session (2026-08-14)

- **Reach listing** — `GET /api/admin/reach`, admin-gated like moderation and scoring. Defaults
  to the next show still open, resolved through `lockState` so it can never disagree with the
  lock the save route enforces; rolls to night two the moment night one locks; returns
  `show: null` after the run rather than erroring. `?showdate=` overrides, locked dates
  included. Per game, ordered warmest first. Handle only, never the email. **It sends nothing
  and a test asserts it never learns how.** Verified live: 403 without a token, 403 with a
  wrong one, 404 for a route that does not exist.
- **`reach.md`** — the campaign the listing aims. Six messages, when to send each, how to pull
  the @ list. Not published (the build allowlist takes named files only).
- **The Nerd Zone shipped**, including the judgement call that had been holding it: it publishes
  the finding that the slot logic *costs* accuracy.
- **Nerd Zone diagnostics** — four measurements the walk-forward had been making, printing once
  and throwing away. See below.
- **Bayesian shrinkage: measured and rejected.** Kept as the record of what was tried.
- **Fitted dueness: measured, published as a sixth arm**, and it tops the table.

### The diagnostics (Nerd Zone, below the approach picker)

Measurements of the shipping model, **not** approaches. Nothing there re-ranks anything and
there is nothing to select — a diagnostic leaking into `LENS_ARMS` would become selectable, and
selecting it would re-rank the site under a lens with no ranking behind it while still rendering
a plausible number. `test/diagnostics.test.mjs` asserts the separation.

| diagnostic | what it says |
|---|---|
| One show is mostly luck | 4.98 hits mean, but the middle 80% is 2–8 and the range 1–13. Drawn as a histogram because the *shape* is the finding. |
| Never reachable | 2.13 songs/night have no play in the trailing 30, capping recall at 88.6%. Of what *is* reachable the model finds 31.3%. |
| Is it holding up | Model recall is flat while the baseline collapses 23.9% → 17.4% and unreachable rises to 2.65/night. |
| Do the percentages mean anything | Isotonic, out of sample over 145 shows: average miss 0.41pp, worst row 4.9pp, top bucket plays 26%. |

They ride in `data/arms.json`, **not** `data/backtest.json` — see Gotchas.

**The drift finding is the most interesting thing measured here and nothing else surfaces it:**
the model is not improving; the naive baseline is collapsing because the band is rotating
harder. 2026 is simultaneously the model's worst absolute year and its best relative one.

### The arm menu, as it now stands

| arm | precision | recall | hits/show | vs baseline |
|---|---|---|---|---|
| Fitted dueness | **30.9%** | **29.2%** | **5.25** | +5.01pp, z 4.47 |
| No slot logic | 30.1% | 28.5% | 5.12 | +4.26pp, z 3.62 |
| Day curve *(shipping)* | 29.3% | 27.7% | 4.98 | +3.45pp, z 2.82 |
| Show-gap recency | 26.4% | 25.0% | 4.48 | +0.74pp, z 0.65 |
| Recent, minus repeats | 25.7% | 24.2% | 4.37 | baseline |
| Most played lately | 13.4% | 12.9% | 2.28 | −11.31pp |

### Model and scoring

- **Walk-forward backtest** (`scripts/backtest.js`). Re-predicts all 174 shows in the era window
  against naive baselines, with paired standard errors and a per-year split. The model core
  lives in `lib/model.mjs` so the backtest and production run the same code; it throws if handed
  a row dated on/after the target show.
- **Day-repeat curve** replaced the show-gap recency term. Recall 25.0% → 27.7%. `k` chosen on
  shows through 2024 by the one-standard-error rule, confirmed on 78 held-out shows (+2.57pp,
  se 0.83, z 3.08). Reproduce: `npm run backtest -- --tune`.
- **Calibration is isotonic, not Platt** (`lib/calibration.mjs`), fitted by `npm run backtest`,
  applied in `analyze.js`. Every candidate carries `p` alongside `score`, shown as a **Chance**
  column. Platt was tried and rejected on evidence: it beat the base rate on Brier and log loss
  and was still unusable, saying 74.6% where reality was 35.0%. **This is why the reliability
  table is printed and not just Brier.** The honest ceiling is ~29% — even the highest-scoring
  candidate plays about three times in ten.
- **`p` is attached in `analyze.js` AFTER `buildModel` returns.** `lib/model.mjs` never sees a
  probability, so the four `score > 0` pool gates cannot be affected. Do not move it inside.
- **Setlist points** (`lib/scoring.mjs`): 1/call capped at 10, +2 exact placement, +5 openers,
  +5 Set 2 closer, +4 Set 1 closer, +2 per encore song, −1 per wrong guess past a 10/10/5 soft
  cap. Row points *derive* the score, so a breakdown cannot drift from the number beside it.
- **Scored-setlist view** — a graded prediction redraws as the setlist it was, colour-coded,
  with per-set subtotals and a show total.

### Platform

- **Prediction lock** at the published downbeat, scraped at build time and enforced
  **server-side** (423). Dick's locks at 19:30 America/Denver each night — 21:30 ET.
- **Moderation** — `GET /api/admin/users`, `PATCH /api/admin/users/:handle` behind
  `ADMIN_TOKEN`. Rename or ban; a ban revokes sessions and hides the account without deleting
  data.
- **Password reset** — operator-minted single-use `/?reset=…` links (24h), handed over out of
  band. **Deliberately not self-service**: a public forgot-password route with no mail delivery
  could only verify the requester by something already in the database, which is the same thing
  an attacker would have. Only `sha256(token)` is stored; issuing supersedes; redemption burns
  the link and revokes **every** session; no session is issued on redeem; banned accounts are
  refused at issue *and* re-checked at redemption.
- **Group invites** — one link both befriends the owner and joins the redeemer to the group.
  `invites.group_id` is a nullable FK with **ON DELETE SET NULL**, not CASCADE. Minting a group
  link is **owner-only** and **re-checked at redemption**. The "already friends" early return
  requires membership **as well as** friendship — on friendship alone a group link handed to an
  existing friend would report success and join nobody.
- **Invite defaults are 10 uses / 30 days**, both editable at creation, with **0 meaning no
  limit**. `pickLimit` in `worker.mjs` keeps "field omitted" distinct from "explicitly 0" —
  collapsing those is exactly how every early link ended up unlimited.
- **Display-text hardening** — NFKC + invisible/bidi stripping, length cap, avatar must be an
  emoji.
- **Leaderboard split** — setlist points and bingo scores are separate and never averaged.

### The app surface

- Landing view opens on the games: **45,175px → ~2,700px on a phone**.
- Tabs are **Phish Bingo | Setlist Bets | Data**, with **Play a Show pinned right on the same
  row**. Only the "Updated" stamp stays on the banner.
- **Data has six sub-tabs**: Predicted Setlist · Song Rotation · Album Coverage · Venue History ·
  Ranked Songs · **Nerd Zone**. Pill-to-card mapping is by **exact string identity** between
  `DATA_TABS` and each card's `dataset.section`; a test checks every tab has a card.
- **`const sections = [...app.children]` is a ONE-TIME snapshot**, taken after every card is
  appended. A card appended later renders on *every* sub-tab at once — which looks like a CSS
  bug and is not one. Anything that re-renders a card must refill the **existing element**.
- **The standings are not a tab.** They open **per game from that game's Actions menu**, plus a
  standalone button on a scored bingo card. Per game, not combined: the two scales are never
  merged. The API orders by setlist points, so the bingo board **re-ranks client-side**.
- **The row shortens below 560px.** **The JS breakpoint and the CSS rule size one row between
  them and must agree** — a test asserts it. Swept 320 → 1440 after every change; tightest is
  320px with 50px spare.
- **Rotating tagline** — `TAGLINES` in `web/index.html`, currently 25. **No tagline names the
  app any more**, so a future rename does not have to hunt through the jokes.
- **The light rig** (the `CK5` comment block). Parked by `IntersectionObserver` when scrolled
  away.
- **Control row, both games:** Save · Ask Diego? · ⟶ Actions pinned right. **The row holds one
  line at 375px and that is load-bearing** — 282px in a 290px row. Any new control has ~8px of
  slack; put it in the menu instead.
- **Ask Diego? randomizes** (it does *not* use the model — that is Our Prediction, one press
  away in Actions).
- **Lock mode** (bingo only) turns the card into a lock picker; a locked square is a **red
  border** (`--lock`), not an icon. `aria-pressed` carries the state.
- **Part-filled bingo cards save.** A saved bingo card stays editable until the show locks.
- **The account menu is ordered by engagement, not architecture.** Change password lives at the
  foot of Profile.
- **First-run wizard** — five steps inline above the game, never over it. "Seen" is
  `profile.wizardSeen`, needing `PROFILE_FLAGS` kept separate from `PROFILE_FIELDS`: running
  `sanitizeLine` over a boolean persists the string `"true"`, truthy on the way back out.
- **Pre-lock nudge** — a strip above the control row, only for a signed-in user with no saved
  prediction for the open show *in the game they are looking at*. Dismissible per show and per
  game. A strip, **not a modal**: the landing view opens on the games on purpose.

### Audio

- `web/relisten.js` plays past shows from Song Rotation, Venue History, Ranked Songs and Play a
  Show. **A show plays straight through and stops at the last track.** Nothing *starts* without
  a press.
- **phish.in hosts the bytes** under Phish's taping policy for **non-commercial** use. Hence:
  Data side only, nothing autoplays, `preload="none"`, credit rendered with the player.
- **Gapless: the 255ms gap is 0ms**, measured off real transport events. Two `Audio` decks
  ping-ponging; `currentMp3` is the only answer to "what is playing". Preload fires late via
  `timeupdate` ~20–30s from the end, which keeps the draw on phish.in's bandwidth proportional
  to actual listening. `assets.test.mjs` guards that specifically — it does not show up as a
  broken feature when it regresses, it shows up as somebody else's bill.

### Cache policy

`web/_headers`, published to `public/_headers` by the build: `/` and `/index.html` `no-cache`;
`/web/*` immutable for a year. `/data/*.json` are **deliberately absent** — not hashed, they
change in place, so they keep revalidating.

## In progress

**Nothing.** The working tree is clean, `main` is deployed, and there is no unmerged branch.

## Next steps

### 0. Send message 1. Before anything else.

Zero code. `reach.md` has it written. Everything below is worth less than this.

**Mint the invite link with `maxUses: 0` first.** New links default to **10 uses**, which a
thirty-person chat burns through in an afternoon and then fails silently for the eleventh
person. This is the one step that happens outside the code and the one that fails quietly.

Then pull the baseline so the campaign can be measured:

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" https://kalphishi.kalphishi.workers.dev/api/admin/reach
```

Re-read `totals` a few hours after each send. It is the only signal the app can give that a
message worked.

### 1. Dick's, 4–6 September

Three nights, six cards per tester. The messages for the mornings after nights one and two are
the **highest-yield in the sequence** and are marked as such in `reach.md`: everything before
them asks people to act on faith, while those two have real standings behind them. Fill in their
bracketed figures from the real result — a generic version of those two is worth much less than
a specific one.

### 2. Dick's is also the clean test of the dueness hypothesis

`modelDuenessTopN` gains over `modelTopN` only in recent years (−1.4pp in 2024, +2.3pp in 2026),
consistent with the drift measurement. That pattern was noticed *after the fact*, so it is a
hypothesis, and the 174 shows it was found in cannot test it. **Three graded shows in September
are the first uncontaminated evidence.** If it holds there, promoting fitted dueness to the
shipping default becomes a defensible change rather than a marginal one.

Re-run afterwards: `npm run backtest -- --tune-dueness`.

### 3. Model work, in the order the evidence now supports

The shrinkage post-mortem produced a rule that should govern this list: **a change that only
moves the tail of the ranking cannot buy recall.** 104 of 174 shows scored identically under
shrinkage because the songs it reordered never reach the top 17.

- **Promote fitted dueness to default** — if Dick's confirms it. See step 2.
- **Logistic regression on the existing per-song features.** Still the biggest untried idea. Fit
  **inside** the walk-forward, refitting per target. **It must beat `modelTopN` at 28.5%, not
  `model` at 27.7%** — beating the shipping arm while losing to "delete the slot code" would not
  be a win. **The `score > 0` trap applies with full force**: four pools in `assembleSetlist`
  gate on it, and a fitted model emitting probabilities has no negatives, so those gates go
  vacuous and the predicted setlist changes silently.
- **Exponentially-decayed recency instead of the hard trailing-30 window.** Lower confidence than
  it looked: it mostly re-weights the tail, which is what just failed.
- **Deferred:** bingo scoring rework, the `obscenity` profanity filter, rehoming the era window /
  tour totals, rehoming the attendance toggle.

### 4. Monte Carlo odds — closed, with a number

Previously filed as "blocked by song dependence". Now quantified, so it does not need
rediscovering. Across 30,876 candidate pairs in the cached setlists: **55.2% have never
co-occurred**, and **75.9% of the pairs that have were seen once or twice**. The joint
distribution is not thin, it is absent — and more shows will not fix it, because the pair space
grows quadratically while shows arrive linearly.

*(Computed over the 160 cached setlists, which skew to famous shows, so treat the exact
percentages as indicative. The conclusion is robust to the sample.)*

**Expected hits remains the free, valid odds-flavoured number** — summing `p` over a card is
correct regardless of dependence, because expectation is linear. The current predicted setlist is
worth ~3.7 hits and the one graded show returned 4.

## Key files

Anchors, not line numbers — an older version of this doc cited a tagline at "line 343" that had
drifted 80 lines by the time anyone read it.

| Path | Role |
|---|---|
| `reach.md` | The campaign: six messages, timing, how to aim them. Operator doc, not published. |
| `lib/model.mjs` | The prediction model, pure. Leakage guard at the top of `buildModel`. The `score > 0` pool gates are near the bottom. Options: `recency`, `freqEstimator`, `dueness`. |
| `lib/hazard.mjs` | Relative-time dueness curve — elapsed days over the song's *own* median gap. Header carries the full measured verdict and the held-out confound. |
| `lib/shrinkage.mjs` | **Measured and rejected**, kept as the record. Explains why common-denominator shrinkage cannot reorder anything, and why the per-window version that can still does not help. |
| `lib/dayrepeat.mjs` | The *absolute* day curve. Different quantity from hazard.mjs — both apply. |
| `lib/calibration.mjs` | score → probability. `fitIsotonic`/`isoProb` ship; `fitPlatt`/`plattProb` kept as the rejected comparison. Plus `brier`, `logLoss`, `reliability`. |
| `lib/baselines.mjs` | The naive baselines, shared by backtest and analyze so a shipped ranking cannot drift from the accuracy printed under it. |
| `lib/scoring.mjs` | Setlist + bingo scoring. Mirrored in `predictor.js`; a test asserts they stay in step. |
| `lib/showtime.mjs` | Showtime parsing, venue→timezone, `lockStateFor`, `preferResolved`. |
| `lib/identity.mjs` | Email/handle rules **and** `sanitizeLine`/`sanitizeBlock`/`sanitizeAvatar`. |
| `src/auth.mjs` | Hashing, sessions, cookies. `newToken()` mints both session and reset tokens. |
| `src/worker.mjs` | Every route. Lock check, admin endpoints, password reset, **`/api/admin/reach`**. Static assets are served **before** this runs. |
| `src/db.mjs` | D1 queries; `NOT_BANNED` and the split stats. |
| `src/showtimes.generated.mjs` | Generated lock table bundled into the Worker. Do not hand-edit. |
| `web/index.html` | Everything: all CSS, dashboard, tab bar, banner, Nerd Zone + diagnostics. Find by symbol — `TAGLINES`, the `CK5` block, `renderTabs`, `nz-diag`, `nz-picker`. |
| `web/predictor.js` | The games. `renderBingo` holds swap + lock logic; `actionsMenu`; `renderPasswordReset`; `predictNudge`; `renderWizard`. |
| `web/relisten.js` | The audio player. `decks[]`/`active`/`currentMp3`. `playFrom()` is the only way playback starts. |
| `web/_headers` | Cache policy. Opposite rules for the HTML and the hashed scripts. |
| `scripts/build-public.js` | The deploy allowlist, content-hash stamping, publishing `_headers`. Throws if a stamp matches nothing. |
| `scripts/backtest.js` | Dev tool. `--experiments`, `--tune`, `--tune-dueness`, `--json`. Needs gitignored raw setlists. Writes `calibration.json` and `arms.json` unconditionally. |
| `scripts/analyze.js` | Builds `analysis.json`, including every published arm's ranking and the `lenses` block. |
| `data/arms.json` | Per-arm walk-forward accuracy, **plus `vsNearest`, `byYear`, and `diagnostics`**. Committed, not published, baked into `analysis.json`. |
| `data/calibration.json` | Fitted isotonic bins. Committed, never published. |
| `.github/workflows/deploy.yml` | Fires on push to `main` only — no CI on branches or PRs. Deliberately does **not** run migrations. |

## Open decisions / questions

- **Delete the `nerd-zone` branch?** Its content is in `main` via the squash of #51, so it is
  redundant, but git will not report it as merged. Left alone deliberately — this repo already
  keeps squash-merge residue and some of it is worth keeping.
- **Does fitted dueness become the default?** Not yet. Its edge over `modelTopN` is +0.75pp at
  z 1.23 — inside noise. Dick's is the test. See Next steps 2.
- **Bingo scoring** — the 5×5 grid is ruled out for change. A line completes in at most ~8% of
  cases even with an optimal card, and 89.6% of shows saw no bingo among 20 simulated cards, so
  "first to bingo" would fall through to total calls ~9 shows in 10. Unresolved.
- **Profanity filter** — `obscenity` recommended (0 deps, 149KB). Would be this repo's **first
  runtime dependency**, a stated architectural property.
- **Should the first-run wizard be re-openable** from the ☰ menu once dismissed? Nothing offers a
  way back to it.
- **An empty bingo card offers only Ask Diego? and the ⋮** — no Save until something is picked, so
  day one shows a 5×5 of `＋` with no stated goal. Defensible, nobody has decided it.
- **Track record** sits under the Predicted Setlist sub-tab, not its own — flagged, never
  confirmed.
- **Era window / tour totals** are stated nowhere since the header line was cut.
- **Attendance toggle** hidden behind `SHOW_ATTENDANCE_TOGGLE = false`. While off nobody can mark
  a new show, so the points-at-shows split stops accumulating.
- **Six legacy graded predictions** remain on the old 0–100 setlist scale, excluded from
  aggregates rather than re-scored.
- **Title mismatches between catalogues.** Matching is on letters and digits only. **Fuzzy
  matching was deliberately rejected**: `tweezer`, `axilla` and `meat` are each a prefix of
  another song, so a prefix match would serve Tweezer Reprise to someone asking for Tweezer.

## Gotchas

### Measurement traps — these cost real time this session

- **A held-out split is not a control when the effect is time-varying.** The standard protocol
  (tune through 2024, confirm on the 78 after) printed `CONFIRMED, z 2.25` for fitted dueness.
  The held-out window *is* a later period, and the effect only exists in later periods, so the
  confirmation was confounded. The full-window direct comparison is +0.75pp at z 1.23. **Check
  the per-year split before believing a held-out number.**
- **An affine transformation cannot reorder anything.** Beta-Binomial shrinkage on a common
  denominator is `(k+a)/(n+a+b)` — affine in `k`, therefore order-preserving by construction.
  Half a day went into building something mathematically incapable of doing what it claimed.
  Check whether a proposed change *can* change the ranking before measuring whether it does.
- **`data/backtest.json` only regenerates under `--json`.** It is gitignored and goes stale
  silently. Mine was ten days old and described the pre-day-curve model, which produced one wrong
  reading. Check its `generated` field before trusting per-show numbers.
- **The by-year `GAIN` column is signed so positive means the BASELINE won** (documented in
  `scripts/backtest.js`). Under a header called `GAIN`, 2026's `-8.7pp` reads as the model
  degrading when it is the model's best relative year.
- **`npm run analyze` bumps the `generated` timestamp inside `data/archive/*.json` and
  `data/history.json`** even when the content is identical. The archive is the record of what was
  published *before* a show — restore it rather than committing a date that misrepresents that.
- **Only published arms get published numbers.** `arms.json` carries figures for arms the site
  actually offers; `modelShrunk`, `modelShrunkTopN` and `modelDueness` are measured and printed
  but not published.

### Build and deploy

- **Migrations are manual and must be applied to remote BEFORE merging dependent code.**
  `npx wrangler d1 migrations apply kalphishi --remote`. CI deliberately does not do this. Latest
  applied: `0008_invite_groups.sql`. **Nothing pending.**
- **`npm test` does not rebuild `public/`.** Editing `web/*` then testing in the browser serves
  the OLD bundle. Run `npm run build:ci` first. The single most common way to waste ten minutes
  here, and it looks exactly like a caching bug.
- **Restart `wrangler dev` after every `npm run build:ci`.** Not "if hot reload seems stuck" —
  every time. A rebuild rewrites `public/index.html` with new `?v=` stamps and the running server
  keeps serving the previous one. The scripts on disk are current the whole time, which is what
  makes it so convincing.
- **The stale-`index.html` symptom.** Presents as "my change didn't take", never as an error.
  **Compare the stamp on disk against the stamp in the DOM before touching any source:**
  ```bash
  grep -o 'predictor\.js?v=[0-9a-f]*' public/index.html
  ```
  Different stamps means restart the server; the code was never the problem. **Same stamps means
  it is a real bug.**
- **`wrangler dev` does not pick up brand-new files** — restart after adding one.
- **Cloudflare's edge lags a deploy by a few minutes.** Re-check before diagnosing.
- **Local files are CRLF, CI builds on Linux with LF.** Normalise with `tr -d '\r'` before
  comparing hashes. **This also breaks test regexes:** `/\n  }/` matches a CRLF file but
  `/  }\n/` does not — the `\r` is absorbed by a lazy run in front of it, not behind.
- **No CI on branches or PRs.** The workflow fires on push to `main` only, so a PR shows no
  checks. Local `npm test` is the only signal until it merges.

### Environment

- **`node --test` uses the spec reporter (✖), not TAP.** Grepping for `not ok` silently counts
  zero failures. Read the `ℹ fail` line.
- **Browser tests drift between tool calls.** Do a whole browser check in ONE evaluation.
- **The Browser pane can stop compositing mid-session** — screenshots fail with *"the Browser pane
  is not displayed"* while DOM reads keep working. Geometry, copy and computed styles stay
  verifiable; only the visual is lost. Ask for the pane.
- **`\uXXXX` escapes get mangled** when written into source through the editing tools.
  `lib/identity.mjs` uses numeric code point ranges for exactly this reason.
- **Bash tool is Git Bash, not PowerShell.** A PowerShell here-string (`@'…'@`) silently produced
  a mangled commit message. Use a heredoc.
- **`cd` resets between Bash calls** — always use absolute paths.
- **Node can't read `/c/Users/...` paths** — use `C:/Users/...` inside `node -e`.
- **Multi-statement `--command` can crash mid-way on Windows.** One statement per call.
- **Local D1 is separate from remote.** Cleanup is always surgical. **Never bulk-wipe
  `data/db.json` or D1 user rows.**
- **`data/archive/*.json` is committed on purpose** and cannot be regenerated. A test guards the
  gitignore pattern.

### Design constraints that will bite

- **Drag on touch was deliberately not implemented** for bingo: `touch-action: none` on a grid
  cell would kill page scrolling on a phone.
- **`predictor` and `menuMode` in `index.html` are `let`, declared above `initPredictor`** on
  purpose — `onModeChange` can fire from inside it.
- **`.overlap` in venue setlists means "also in the current top-40 candidates."** Playable songs
  there are deliberately *not* underlined so that signal survives.
- **`usesCalibration` is load-bearing.** The isotonic bins were fitted on the *shipping* model's
  score distribution. Only arms sharing those exact scores may show a Chance — a test enforces it
  and it caught a real mistake this session.

## Branches

```
main   3c92d80   ← production, current, deployed green, 272 tests
```

Nothing is ahead of `main`. Branch from it for the next piece of work.

Merged and deleted this session: `reach-targeting` (#50), `nerd-zone-diagnostics` (#51, which
folded in `nerd-zone`).

Older leftovers still around (squash-merge residue, commits unreachable from `main`):
`bingo-cell-icons`, `cache-policy`, `controls-and-taglines`, `drop-tagline`, `first-run-mobile`,
`handoff-refresh`, `handoff-social`, `nerd-zone`, `password-reset`, `play-a-show`,
`roadmap-precache`, `scoring-scope`, `show-autoadvance`, plus local-only `backup-pre-rewrite` and
`cloudflare-migration`. **`nerd-zone` is now fully contained in `main`** and is safe to delete
whenever you want to.
