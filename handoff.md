# Kalphishi — state of the project

**Live:** https://kalphishi.kalphishi.workers.dev
**Repo:** https://github.com/NovoRetro/KalPhishi
**Written:** 2026-08-07 (replaces the 2026-08-05 version, which predates the design pass
shipping)

> **Production is current.** `main` is at `5e80b43` and everything below is deployed.
> The long-running "production is N commits behind" warning is gone — PR #20 merged the
> whole 13-commit stack on 2026-08-07 and the deploy went green first time.

Still **closed beta** (~30 testers as of early August). The URL is public and registration
is open, but this is not a public launch — say "in beta," never "launched."

---

## Current goal

**Accumulate graded predictions.** The track record holds **one graded show**. Everything
the model claims rests on the walk-forward backtest, not on live results, and that only
changes when real people predict real shows. Dick's is **2026-09-04** (a three-night run)
and is the best available shot at a burst of them.

That reframes the priority: the app is shipped and good enough. What it needs now is
players, not features.

## Done

### Model and scoring
- **Walk-forward backtest** (`scripts/backtest.js`). Re-predicts all 174 shows in the era
  window against naive baselines, with paired standard errors and a per-year split. The
  model core lives in `lib/model.mjs` so the backtest and production run the same code; it
  throws if handed a row dated on/after the target show.
- **Day-repeat curve** replaced the show-gap recency term. Recall 25.0% → 27.7%, precision
  26.4% → 29.3%. `k` chosen on shows through 2024 by the one-standard-error rule, confirmed
  on 78 held-out shows (+2.57pp, se 0.83, z 3.08). Reproduce: `npm run backtest -- --tune`.
- **Setlist points system** (`lib/scoring.mjs`): 1/call capped at 10, +2 exact placement,
  +5 openers, +5 Set 2 closer, +4 Set 1 closer, +2 per encore song, −1 per wrong guess past
  a 10/10/5 soft cap. Row points *derive* the score, so a breakdown cannot drift from the
  number beside it.
- **Scored-setlist view** — a graded prediction redraws as the setlist it was, colour-coded,
  with per-set subtotals and a show total.

### Platform
- **Prediction lock** at the published downbeat, scraped at build time
  (`scripts/fetch-showtimes.js`) and enforced **server-side** (423).
- **Moderation** — `GET /api/admin/users`, `PATCH /api/admin/users/:handle` behind
  `ADMIN_TOKEN`. Rename or ban; a ban revokes sessions and hides the account without
  deleting data.
- **Display-text hardening** — NFKC + invisible/bidi stripping, length cap on registration,
  avatar must actually be an emoji.
- **Leaderboard split** — setlist points and bingo scores are separate and never averaged.

### Design pass (shipped 2026-08-07)
- Landing view opens on the games, not All Data: **45,175px → ~2,700px on a phone**.
- Tabs are **Phish Bingo | Setlist Bets | Data**, Data holding five sub-tabs.
- Title centred; the freshness stamp moved out of the `<h1>` to the right end of the tab
  row as "Last updated:".
- **Rotating tagline** — `TAGLINES` in `web/index.html`. The list is meant to grow; new
  lines go there and nowhere else. Rotates on load, on a 60s cadence while the tab is
  visible, and on sign-in via the `onSignedIn` hook.
- **The light rig** (see the `CK5` comment block in `index.html`). A dark hall behind the
  top of the page carries angled beams from mirrored fixture positions, blended additively
  so crossings brighten, masked so light falls off rather than ending on an edge. Cards are
  translucent so it reads through them. Peaks on save and on BINGO. Parked by
  `IntersectionObserver` when scrolled away.
- Bingo squares reorder — drag on desktop, tap-then-tap on touch.
- All tap targets ≥44px on phones.

### Games simplification (shipped 2026-08-07)
- Save joined the control row; the rest fold into one **Actions** menu (Randomize,
  Kalphishi's Prediction, Clear, the scoring rules).
- The account line, show picker and next-show restatement are **gone** from above the
  board. Saved/scored status rides the heading row. Four bingo rows now fit on a phone
  where one did.
- **A saved bingo card stays editable until the show locks.** Checking squares off is a
  during-the-show act, so the lock starts it, not the save. "Reload last save" appears once
  the board differs from the save.

### Audio (shipped 2026-08-07)
- `web/relisten.js` plays past shows from **Song Rotation** (dates), **Venue History**
  (every song, that show's performance — 846 across 42 shows) and **Ranked Songs** (the
  performance phish.in's users have liked most).
- Relisten indexes; **phish.in hosts the bytes**, and the recordings are audience tapes
  shared under Phish's taping policy for non-commercial use. Hence: Data side only, nothing
  autoplays, `preload="none"`, and credit to both renders with the player rather than buried
  in a footer. Tests guard all of that.

## In progress

Nothing half-done. Working tree clean, 186 tests passing, production current.

## Next steps

1. **Get people playing before Dick's (2026-09-04).** The beta has testers; the track
   record has one graded show. Nothing else matters as much as closing that gap.
2. **Calibration** — a model change with no UI. Turn scores into probabilities via Platt
   scaling fitted *inside* the walk-forward loop. Highest value-to-cost item on the model
   side, and a prerequisite for anything probabilistic later. **See the caveat in step 5.**
3. Deferred, in rough priority: bingo scoring rework, the `obscenity` profanity filter,
   rehoming the era window / tour totals, rehoming the attendance toggle.
4. **"Nerd Zone" — low priority, revisit after fall tour 2026.** A user-selectable analysis
   mode (calibrated probabilities / simulated odds / etc., current model as default).
   Deferred on **timing, not merit** — don't re-litigate whether it's a good idea; it
   probably is. This fandom compiles encyclopedic data about the band for fun.

   The blocker is the one graded show. Any alternative mode needs its own walk-forward
   backtest to be shown with the same authority as the current one, so a menu of lenses now
   would present unvalidated output as validated — the one thing that would cost the app its
   credibility. Revisit around ~30 graded shows.

   Two conclusions worth keeping so they aren't rediscovered:
   - Calibrated / Bayesian / Monte Carlo are **not alternatives** — they're layers of one
     pipeline (Bayesian fits parameters → calibration makes them probabilities → Monte Carlo
     turns those into outcome odds). A menu presenting them as mutually exclusive teaches
     the audience most likely to notice something false. If it ships, the axis is *how much
     uncertainty do you want to see*: ranked picks → probabilities → odds.
   - It's safe to expose at all only because predictions are graded against the real
     setlist, never against the model — so a user's mode can't touch their points or the
     leaderboard. It **would** fragment Track Record, which grades the model.
5. **Calibration caveat, found while scoping the above.** `lib/model.mjs` gates the opener,
   closer, set-2-opener and encore pools on `c.score > 0` (four places, in the block
   building `openerPool`/`closerPool`/`s2openPool`/`encorePool`). Score accumulates
   penalties from zero (−15 just played, −10 played at last tour show, −5 for 3+ tour plays)
   against a base of only `freq × 30`, so those gates are **load-bearing**. A calibrated
   probability is never ≤ 0, so *replacing* `score` silently makes all four vacuous and
   changes the predicted setlist. Add `p` alongside `score`; do not swap it.

## Key files

Anchors, not line numbers — the previous version of this doc cited a tagline at "line 343"
that had drifted 80 lines by the time anyone read it.

| Path | Role |
|---|---|
| `lib/model.mjs` | The prediction model, pure. Leakage guard at the top of `buildModel`. The `score > 0` pool gates are near the bottom. |
| `lib/dayrepeat.mjs` | Day-since-last-play curve; `DAY_CURVE_K` lives in `model.mjs`. |
| `lib/scoring.mjs` | Setlist + bingo scoring. `SETLIST_POINTS`, `SETLIST_SOFT_CAP`, per-row `rows`/`setTotals`. Mirrored in `predictor.js`; a test asserts they stay in step. |
| `lib/showtime.mjs` | Showtime parsing, venue→timezone, `lockStateFor`, `preferResolved`. |
| `lib/identity.mjs` | Email/handle rules **and** `sanitizeLine`/`sanitizeBlock`/`sanitizeAvatar`. |
| `web/index.html` | Everything: all CSS, dashboard, tab bar, header. Find things by symbol — `TAGLINES`, the `CK5` comment block, `.hall`/`.rig`, `renderTabs`, `venueShowsGrid`, `songCell`. |
| `web/predictor.js` | The games. `initPredictor(mount, A, opts)` returns `{setMode,getMode}`. `renderBingo` holds the swap + lock logic; `actionsMenu` builds the Actions dropdown. |
| `web/relisten.js` | The audio player. `slugify` is the single source of truth for phish.in slugs — index.html borrows it rather than keeping a copy. `bind(container)` wires a container's `data-listen-*` triggers. |
| `src/worker.mjs` | Every route. Lock check and admin endpoints here. |
| `src/db.mjs` | D1 queries; `NOT_BANNED` and the split stats. |
| `src/showtimes.generated.mjs` | Generated lock table bundled into the Worker. Do not hand-edit. |
| `scripts/build-public.js` | The deploy allowlist **and** the content-hash stamping of script tags. Throws if a stamp matches nothing. |
| `scripts/backtest.js` | Dev tool. `--experiments`, `--tune`. Needs gitignored raw setlists. |
| `.github/workflows/deploy.yml` | Fires on push to `main`. Tests gate the deploy. Deliberately does **not** run migrations. |

## Open decisions / questions

- **Bingo scoring** — user ruled out changing the 5×5 grid. Measured: a line completes in at
  most ~8% of cases even with an optimal card, and 89.6% of shows saw no bingo among 20
  simulated cards. So "first to bingo" would fall through to total calls ~9 shows in 10.
  Unresolved.
- **Profanity filter** — `obscenity` recommended (0 deps, 149KB). Would be this repo's
  **first runtime dependency**, a stated architectural property. User's call.
- **Track record** sits under the Predicted Setlist sub-tab, not its own — flagged, never
  confirmed.
- **Era window / tour totals** are stated nowhere since the header line was cut.
- **Attendance toggle** hidden behind `SHOW_ATTENDANCE_TOGGLE = false`. While off nobody can
  mark a new show, so the points-at-shows split stops accumulating.
- **Six legacy graded predictions** remain on the old 0–100 setlist scale, excluded from
  aggregates rather than re-scored.
- **Title mismatches between catalogues.** Our setlists and the recordings' track lists
  agree on words, not always punctuation ("Thru" vs "Through"). Matching is on letters and
  digits only. **Fuzzy matching was deliberately rejected**: across the venue grid's 240
  distinct songs, `tweezer`, `axilla` and `meat` are each a prefix of another song, so a
  prefix match would serve Tweezer Reprise to someone asking for Tweezer.

## Gotchas

- **Migrations are manual and must be applied to remote BEFORE merging dependent code.**
  `npx wrangler d1 migrations apply kalphishi --remote`. CI deliberately does not do this.
  Latest applied: `0006_moderation.sql`.
- **`wrangler dev` does not pick up brand-new files.** It hot-reloads edits to existing
  ones but 404s a file added since startup — restart the dev server after adding one. Cost
  a wrong diagnosis once.
- **The asset watcher can die with `EBUSY: resource busy or locked`** on Windows, disabling
  hot reload entirely. Serving still reads from disk per request, so it affects convenience,
  not correctness — verify with a hash comparison rather than assuming staleness.
- **Script tags now carry a content hash** (`?v=<sha256[0:10]>`), so `/web/*.js` staleness
  is solved. **`index.html` itself is still browser-cached** — an open tab can keep the old
  shell through a reload. Add a `Cache-Control` revalidate header on the HTML to close it.
- **Cloudflare's edge lags a deploy** and its cache key ignores query strings. Re-check
  before diagnosing a "broken" route.
- **The Browser pane can stop compositing mid-session** — screenshots fail with *"the
  Browser pane is not displayed"* while DOM reads keep working. Geometry, copy and computed
  styles are still verifiable; only the visual check is lost. Ask for the pane.
- **`\uXXXX` escapes get mangled** when written into source through the editing tools.
  `lib/identity.mjs` uses numeric code point ranges for exactly this reason — do not "tidy"
  it into a regex class.
- **Bash tool is Git Bash, not PowerShell.** A PowerShell here-string (`@'…'@`) silently
  produced a mangled commit message. Use a heredoc.
- **`cd` resets between Bash calls** — always use absolute paths.
- **Node can't read `/c/Users/...` paths** — use `C:/Users/...` inside `node -e`.
- **Multi-statement `--command` can crash mid-way on Windows.** One statement per call.
- **Local D1 is separate from remote.** Cleanup is always surgical.
- **Drag on touch was deliberately not implemented** for bingo: `touch-action: none` on a
  grid cell would kill page scrolling on a phone.
- **`predictor` and `menuMode` in `index.html` are `let`, declared above `initPredictor`**
  on purpose — `onModeChange` can fire from inside it.
- **`.overlap` in venue setlists means "also in the current top-40 candidates."** It is an
  underline carrying data. Playable songs there are deliberately *not* underlined, so that
  signal survives — see `.setlist a.s:not(.overlap)`.
- **Never bulk-wipe `data/db.json` or D1 user rows.**
- **`data/archive/*.json` is committed on purpose** and cannot be regenerated. A test guards
  the gitignore pattern.

## Branches

```
main  5e80b43   ← production, current
```

`explain-soft-cap` and `first-run-mobile` both merged via PR #20 and can be deleted.
Branch from `main` for the next piece of work.
