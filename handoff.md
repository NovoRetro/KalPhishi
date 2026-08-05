# Kalphishi — state of the project

Replaces the orientation doc written 2026-08-03, which predates the points system, the
prediction lock, moderation and the design pass.

**Live:** https://kalphishi.kalphishi.workers.dev
**Repo:** https://github.com/NovoRetro/KalPhishi
**Written:** 2026-08-05

> **Production is ten commits behind this working copy.** `main` is at `d0d2e3d`. The
> scored-setlist view, the whole first-run/mobile redesign and the bingo reordering are
> committed locally and NOT live. Do not describe them as shipped.

---

## Current goal

Make the app good enough that people stay, before any adoption push — poor UX would cost
the graded predictions the model needs to be evaluated at all. Next concrete task: a
**tagline carousel**, rotating punny hybrids of the game and iconic Phish lyrics.

## Done

### Model and scoring
- **Walk-forward backtest** (`scripts/backtest.js`). Re-predicts all 174 shows in the era
  window against naive baselines, with paired standard errors and a per-year split. The
  model core was extracted to `lib/model.mjs` so the backtest and production run the same
  code; it throws if handed a row dated on/after the target show.
- **Day-repeat curve** replaced the show-gap recency term. Recall 25.0% → 27.7%, precision
  26.4% → 29.3%. `k` chosen on shows through 2024 by the one-standard-error rule, confirmed
  on 78 held-out shows (+2.57pp, se 0.83, z 3.08). Reproduce: `npm run backtest -- --tune`.
- **Setlist points system** (`lib/scoring.mjs`): 1/call capped at 10, +2 exact placement,
  +5 openers, +5 Set 2 closer, +4 Set 1 closer, +2 per encore song, −1 per wrong guess past
  a 10/10/5 soft cap. Row points now *derive* the score, so a breakdown cannot drift from
  the number beside it.
- **Scored-setlist view** — a graded prediction redraws as the setlist it was, colour-coded
  (green placed / blue called / red struck-through miss with what actually played), per-set
  subtotals and a show total.

### Platform
- **Prediction lock** at the published downbeat. Times scraped from phish.com at build time
  (`scripts/fetch-showtimes.js`), resolved to a UTC instant offline. Enforced **server-side**
  (423); live check-off deliberately stays open.
- **Moderation** — `GET /api/admin/users`, `PATCH /api/admin/users/:handle` behind
  `ADMIN_TOKEN`. Rename (display name + handle) or ban. A ban revokes sessions, blocks
  login after the password check, and hides the account everywhere without deleting data.
  **Migration `0006_moderation.sql` is already applied to remote D1.**
- **Display-text hardening** — NFKC + invisible/bidi stripping, a length cap on
  registration (there was none), and the avatar must actually be an emoji.
- **Leaderboard split** — setlist points and bingo scores are separate and never averaged.
  Pre-points setlist results are excluded from the points aggregate rather than rewritten.

### Design pass (all local, none live)
- Landing view opens on the games, not All Data: **45,175px → ~2,700px on a phone**.
- Tabs are now **Phish Bingo | Setlist Bets | Data**, Data holding five sub-tabs.
- Helper text cut back to rules you cannot infer from the screen.
- Lock countdown moved inline onto the heading row; "How scoring works" moved into the
  control row, right-aligned; attendance toggle hidden; header stats line removed.
- **Bingo squares reorder** — drag on desktop, tap-then-tap on touch.
- Save button reads **"Bag it, Tag it"** signed in.
- All tap targets ≥44px on phones.

## In progress

Nothing half-done. Working tree clean, 180 tests passing, remote migrations current.

## Next steps

1. **Tagline carousel.** Replace the single hard-coded tagline in `web/index.html` (the
   `header .tagline` element, set in markup around line 343) with a rotating set of punny
   game/lyric hybrids. The current text — *"Guess what Phish plays next. We score you
   against the real setlist."* — was **rejected as too sterile/gimmicky** and is only still
   there because replacing it was deliberately pinned. Options already floated and liked,
   for reference:
   - "Bag it, tag it — call the setlist before they play it." (Reba)
   - "Set the gearshift for the high gear of your soul." (Weekapaug)
   - "You enjoy myself. We'll do the scoring." (YEM)
   - "Call the show before the hose comes on." (phan idiom)
   The user wants a **rotating carousel**, not one line. Respect `prefers-reduced-motion`.
2. **Get the Browser pane rendering** before more visual work — see Gotchas.
3. On/after **2026-09-01**, merge (see Gotchas — freeze). Land `explain-soft-cap` first,
   confirm production, then the design branch. Ideally done before Dick's on **2026-09-04**.
4. Deferred, in rough priority: bingo scoring rework, the `obscenity` profanity filter,
   rehoming the era window / tour totals, rehoming the attendance toggle.

## Key files

| Path | Role |
|---|---|
| `lib/model.mjs` | The prediction model, pure. Leakage guard at the top of `buildModel`. |
| `lib/dayrepeat.mjs` | Day-since-last-play curve; `DAY_CURVE_K` lives in `model.mjs`. |
| `lib/scoring.mjs` | Setlist + bingo scoring. `SETLIST_POINTS`, `SETLIST_SOFT_CAP`, and the per-row `rows`/`setTotals` detail. |
| `lib/showtime.mjs` | Showtime parsing, venue→timezone, `lockStateFor`, `preferResolved`. |
| `lib/identity.mjs` | Email/handle rules **and** `sanitizeLine`/`sanitizeBlock`/`sanitizeAvatar`. |
| `web/index.html` | Everything: all CSS, dashboard, tab bar, header. Tagline ~line 343; tab logic ~line 1130. |
| `web/predictor.js` | The games. `initPredictor(mount, A, opts)` returns `{setMode,getMode}`. Bingo swap logic in `renderBingo`. |
| `src/worker.mjs` | Every route. Lock check and admin endpoints here. |
| `src/db.mjs` | D1 queries; `NOT_BANNED` and the split stats. |
| `src/showtimes.generated.mjs` | Generated lock table bundled into the Worker. Do not hand-edit. |
| `scripts/backtest.js` | Dev tool. `--experiments`, `--tune`. Needs gitignored raw setlists. |
| `migrations/0006_moderation.sql` | Applied to remote already. |

## Open decisions / questions

- **Tagline** — pinned by the user, now the next task. They want a rotating carousel.
- **Bingo scoring** — user ruled out changing the 5×5 grid. Measured: a line completes in
  at most ~8% of cases even with an optimal card, and 89.6% of shows saw no bingo among 20
  simulated cards. So "first to bingo" would fall through to total calls ~9 shows in 10.
  Unresolved.
- **Profanity filter** — `obscenity` recommended (0 deps, 149KB). Would be this repo's
  **first runtime dependency**, which is a stated architectural property. User's call.
- **Track record** currently sits under the Predicted Setlist sub-tab, not its own — my
  judgment call, flagged, not confirmed.
- **Era window / tour totals** are now stated nowhere after the header line was cut.
- **Attendance toggle** hidden behind `SHOW_ATTENDANCE_TOGGLE = false`. While off, nobody
  can mark a new show, so the points-at-shows split stops accumulating.
- **Six legacy graded predictions** remain on the old 0–100 setlist scale, excluded from
  aggregates rather than re-scored. Re-scoring is available if uniformity is preferred.

## Gotchas

- **GitHub Actions freeze until 2026-09-01. Do not merge to main.** Branch pushes and PRs
  cost nothing — `.github/workflows/deploy.yml` triggers only on `push: branches: [main]`
  and `workflow_dispatch`, with no `pull_request` trigger. Only merging spends minutes.
- **The Browser pane never composited frames this whole session.** Every screenshot failed
  with *"the Browser pane is not displayed"*. All UI work was verified by DOM measurement,
  not by looking. Fine for geometry and copy; **not** fine for the aesthetic work coming
  next. Ask the user to open the pane before continuing the design pass.
- **Migrations are manual and must be applied to remote BEFORE merging dependent code.**
  `npx wrangler d1 migrations apply kalphishi --remote`.
- **Cloudflare's edge lags a deploy** and its cache key ignores query strings. A bad
  immediate post-deploy check produced a false "the route is broken" this session. Re-check
  before diagnosing.
- **The browser caches `/web/predictor.js` hard.** After a deploy an already-open tab can
  keep the old script through a normal reload; it took a cache-busting URL to shake it.
  Consider a content hash in `scripts/build-public.js`.
- **`\uXXXX` escapes get mangled** when written into source through the editing tools —
  they landed as literal control characters twice. `lib/identity.mjs` uses numeric code
  point ranges for exactly this reason. Do not "tidy" it back into a regex class.
- **Bash tool is Git Bash, not PowerShell.** A PowerShell here-string (`@'…'@`) silently
  produced a mangled commit message. Use a heredoc.
- **`cd` resets between Bash calls** — always use absolute paths.
- **Node can't read `/c/Users/...` paths** — use `C:/Users/...` inside `node -e`.
- **Multi-statement `--command` can crash mid-way on Windows.** One statement per call.
- **Local D1 is separate from remote.** Test users were created and cleaned up surgically;
  one local test account's passhash was overwritten during testing (local only).
- **Drag on touch was deliberately not implemented** for bingo: `touch-action: none` on a
  grid cell would kill page scrolling on a phone. Touch gets tap-then-tap by design.
- **`predictor` and `menuMode` in `index.html` are `let`, declared above `initPredictor`**
  on purpose — `onModeChange` can fire from inside it, and `const` after the call would sit
  in the temporal dead zone.
- **Never bulk-wipe `data/db.json` or D1 user rows.** Cleanup is always surgical.
- **`data/archive/*.json` is committed on purpose** and cannot be regenerated. A test
  guards the gitignore pattern.

## Branches

```
main  d0d2e3d                            ← production
 └─ explain-soft-cap  (3 commits)        ← scoring
     └─ first-run-mobile  (7 commits)    ← design pass, current branch
```

Stacked, so merging `first-run-mobile` brings all ten in one PR and one Actions run.

## TODO list (verbatim)

```
#1  [completed] Extract model core into lib/model.mjs
#2  [completed] Rewire analyze.js and verify identical output
#3  [completed] Build scripts/backtest.js walk-forward harness
#4  [completed] Add tests for model module and leakage guards
#5  [completed] Tune k on a train/test split
#6  [completed] Wire the day curve into the live model
#7  [completed] Implement the new setlist point system
#8  [completed] Test the scoring rules and the worked example
#9  [completed] Update the predictor UI for the new scoring
#10 [completed] Build showtime parsing and timezone resolution
#11 [completed] Fetch showtimes at build time into committed data
#12 [completed] Enforce the lock server-side and surface it in the UI
#13 [completed] Add moderation columns migration
#14 [completed] Make a ban take effect everywhere
#15 [completed] Add admin rename and ban endpoints
```
