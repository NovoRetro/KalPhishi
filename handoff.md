# Kalphishi — state of the project

**Live:** https://kalphishi.kalphishi.workers.dev
**Repo:** https://github.com/NovoRetro/KalPhishi
**Written:** 2026-08-09 (replaces the 2026-08-07 version, which predates Play a Show,
password reset and the cache policy)

> **Production is current, but the branch is ahead of it.** `main` is at `1bdf3e3` and
> everything deployed is green. Group invites (`group-invites`) are code-complete and
> unmerged, and **`0008_invite_groups.sql` is pending on remote** — see In progress.
> 206 tests passing, working tree clean.

Still **closed beta** (~30 testers). The URL is public and registration is open, but this is
not a public launch — say "in beta," never "launched."

---

## Current goal

**Accumulate graded predictions.** The track record holds **one graded show**. Everything
the model claims rests on the walk-forward backtest, not on live results, and that only
changes when real people predict real shows. Dick's is **2026-09-04** (a three-night run),
roughly four weeks out, and is the best available shot at a burst of them.

A cohort of willing phans is being assembled to test through to it. So the priority order
is: remove what could **lose** a tester, then what could **stop one playing**, then
everything else. The app is shipped and good enough; what it needs is players, not features.

## Done

### Model and scoring
- **Walk-forward backtest** (`scripts/backtest.js`). Re-predicts all 174 shows in the era
  window against naive baselines, with paired standard errors and a per-year split. The
  model core lives in `lib/model.mjs` so the backtest and production run the same code; it
  throws if handed a row dated on/after the target show.
- **Day-repeat curve** replaced the show-gap recency term. Recall 25.0% → 27.7%, precision
  26.4% → 29.3%. `k` chosen on shows through 2024 by the one-standard-error rule, confirmed
  on 78 held-out shows (+2.57pp, se 0.83, z 3.08). Reproduce: `npm run backtest -- --tune`.
- **Setlist points** (`lib/scoring.mjs`): 1/call capped at 10, +2 exact placement, +5
  openers, +5 Set 2 closer, +4 Set 1 closer, +2 per encore song, −1 per wrong guess past a
  10/10/5 soft cap. Row points *derive* the score, so a breakdown cannot drift from the
  number beside it.
- **Scored-setlist view** — a graded prediction redraws as the setlist it was, colour-coded,
  with per-set subtotals and a show total.

### Platform
- **Prediction lock** at the published downbeat, scraped at build time
  (`scripts/fetch-showtimes.js`) and enforced **server-side** (423).
- **Moderation** — `GET /api/admin/users`, `PATCH /api/admin/users/:handle` behind
  `ADMIN_TOKEN`. Rename or ban; a ban revokes sessions and hides the account without
  deleting data.
- **Password reset** — see its own section below.
- **Display-text hardening** — NFKC + invisible/bidi stripping, length cap on registration,
  avatar must actually be an emoji.
- **Leaderboard split** — setlist points and bingo scores are separate and never averaged.

### The app surface
- Landing view opens on the games: **45,175px → ~2,700px on a phone**.
- Tabs are **Phish Bingo | Setlist Bets | Data** (five sub-tabs). **Play a Show** and the
  "Last updated" stamp sit on the banner, right-aligned — neither is a view of the model, so
  neither belongs in a row of peers with the three that are.
- **Rotating tagline** — `TAGLINES` in `web/index.html`, currently 26. The list is meant to
  grow; new lines go there and nowhere else. The picker draws uniformly and only excludes
  the immediately previous line, so it needs no change as the list grows.
- **The light rig** (the `CK5` comment block in `index.html`). A dark hall behind the top of
  the page carries angled beams from mirrored fixture positions, blended additively so
  crossings brighten, masked so light falls off rather than ending on an edge. Cards are
  translucent so it reads through them. Peaks on save and on BINGO. Parked by
  `IntersectionObserver` when scrolled away.
- **Control row, both games, left to right:** Save · Pick for me · Reload last save ·
  ⟶ Actions pinned right. Actions holds Randomize, Kalphishi's Prediction, Clear and the
  scoring rules, and is deliberately the furthest thing from Save.
- **Pick for me randomizes** (it does *not* use the model — that is Kalphishi's Prediction,
  one press away in Actions) and stays on the row so it can be pressed repeatedly. Locked
  bingo squares survive a re-roll, which is what makes repeat-pressing useful.
- **Part-filled bingo cards save.** No minimum: nothing server-side enforced one, and
  `scoreBingoPrediction` already skips empty cells and still divides by 24, so an unfinished
  card just scores fewer hits. `bingoLine` treats the donut as always-counting.
- **A saved bingo card stays editable until the show locks.** Checking squares off is a
  during-the-show act, so the lock starts it, not the save.
- **The scoring panel is scoped to the game you are in**, closes on an outside click, and
  the full both-games reference lives in the account menu.
- Bingo squares reorder — drag on desktop, tap-then-tap on touch. All tap targets ≥44px.

### Audio
- `web/relisten.js` plays past shows from **Song Rotation** (dates), **Venue History**
  (every song, that show's performance — 846 across 42 shows), **Ranked Songs** (the
  performance phish.in's users have liked most) and the **Play a Show** view.
- **A show plays straight through and stops at the last track.** Never rolls into the next
  show, never loops. Nothing *starts* without a press; advancing is the continuation of a
  press that already happened. That bound is what keeps the draw on phish.in's privately
  funded bandwidth proportional to actual listening.
- Relisten indexes; **phish.in hosts the bytes**, and the recordings are audience tapes
  shared under Phish's taping policy for **non-commercial** use. Hence: Data side only,
  nothing autoplays, `preload="none"`, and credit to both renders with the player rather
  than buried in a footer. Tests guard all of it.

### Password reset (2026-08-09)
```
POST /api/admin/users/:handle/reset   ADMIN_TOKEN, returns the link once
POST /api/password/reset              unauthenticated, the token is the proof
```
An operator mints a single-use `/?reset=…` link (24h) and hands it over out of band, because
nothing is ever sent to the address on file. **Deliberately not self-service**: a public
forgot-password route with no mail delivery could only verify the requester by something
already in the database, which is the same thing an attacker would have.

Properties, all verified against a real D1 rather than by reading the code — only
`sha256(token)` is stored; issuing supersedes any outstanding link; redemption burns it and
revokes **every** session; missing/spent/expired return one identical message; no session is
issued on redeem, so the new password must be proved by signing in with it; banned accounts
are refused at issue *and* re-checked at redemption. `newToken()` lives in `auth.mjs` and
`newSession` uses it too, so session and reset tokens are the same strength by construction.

### Group invites (2026-08-09, on `group-invites` — not yet deployed)
```
POST /api/invites            { groupId?, maxUses?, expiresInDays? }   owner-only for groupId
POST /api/invites/:code/redeem   befriends the owner AND joins the group, one batch
```
`invites.group_id` is a nullable FK with **ON DELETE SET NULL**, not CASCADE: deleting a
group must not revoke links people are already holding — it degrades to the plain friend
invite the link always also was. Redemption re-resolves the group anyway, so a dangling id
fails safe even with foreign keys off.

Verified end-to-end against a real local D1, not by reading the code: an existing friend
redeeming a group link still joins; re-opening a spent-on-you link is a no-op that doesn't
burn a use; a non-owner minting into someone else's group gets 404; deleting the group
leaves the link working as a friend invite. The unit tests are source-property assertions in
`test/group-invites.test.mjs` — same pattern and same reason as the password-reset ones.

### Cache policy (2026-08-09)
`web/_headers`, published to `public/_headers` by the build:
```
/            no-cache
/index.html  no-cache
/web/*       public, max-age=31536000, immutable
```
`index.html` is the one file whose URL never changes and it carries the `?v=` stamps, so a
stale copy pins a visitor to a stale bundle — the symptom reads as "the feature you shipped
isn't there". The scripts are content-hashed, so revalidating them was a wasted round trip
per script per page load. `/data/*.json` are **deliberately absent**: they are not hashed and
change in place, so they keep revalidating.

## In progress

**Branch `group-invites` — code complete, NOT deployed.** 206 tests passing, working tree
clean. Two things stand between it and production:

1. **`0008_invite_groups.sql` must be applied to remote BEFORE this merges.** It is applied
   locally only. CI deliberately does not run migrations, and the deploy fires on push to
   `main`, so merging first means a Worker selecting `group_id` from a column that isn't
   there — every invite route 500s, including plain friend invites.
   ```
   npx wrangler d1 migrations apply kalphishi --remote
   ```
2. The branch was cut from `handoff-refresh`, so it carries this document too. That branch
   is still unmerged on its own.

## Next steps

### 0. Social readiness — before the cohort arrives

Verified against the code 2026-08-08. Friendships form **only** by redeeming an invite link;
they are instant, mutual, and have no approval step. Groups are owner-created, owner-managed,
and members must already be friends.

1. ~~Onboarding thirty people is about sixty manual steps~~ — **done on `group-invites`,
   2026-08-09.** An invite can now carry a group (`invites.group_id`), so one link both
   befriends the owner and joins the redeemer to the group. Thirty people is one link.

   The alternative — a standalone join-by-group code — was **rejected, don't revisit it
   without a reason**: group membership is drawn from the owner's friends, and carrying the
   group on the existing invite preserves that exactly, because by the time the membership
   insert runs the redeemer is already the owner's friend, established in the same batch. A
   standalone code would put non-friends on a group leaderboard and would break the
   friend-removal cascade, which assumes friendship implies the membership.

   Two decisions inside it worth keeping. Minting a group link is **owner-only** and
   **re-checked at redemption** against the invite's owner, the same way the reset flow
   re-checks bans — the mint-time check can be weeks stale by the time anyone opens the
   link. And the "already friends" early return now requires membership **as well as**
   friendship: on friendship alone, a group link handed to an existing friend would report
   success and join nobody. That is the one bug this feature is shaped to avoid, and there
   is a test named for it.

2. ~~Decide the invite link's default reach~~ — **done on `group-invites`, 2026-08-09.**
   The answer to "confirm they are surfaced" was **no**: the client posted `{}` and every
   link ever created was unlimited-use and never-expiring. New links now default to
   **10 uses / 30 days**, both editable at creation, with **0 meaning no limit**.

   `pickLimit` in `worker.mjs` keeps "field omitted" distinct from "explicitly 0" —
   collapsing those is exactly how every link ended up unlimited, since the old code fell
   through to NULL for both. Existing unlimited links are untouched; the ~30 testers holding
   them keep what they have.

3. ~~Look at day one for a brand-new tester~~ — **walked 2026-08-09, empty states fixed on
   `group-invites`.** Findings worth keeping:

   - **The Data tab is fully populated on day one** — it is model output, not user data. All
     five sub-tabs are rich for someone who registered a minute ago. The empty surfaces are
     only the social ones, which is a much smaller problem than it looked.
   - The Friends board said *"scores appear once a show is graded"* to someone with **no
     friends at all** — wrong about the cause, and it prescribed waiting at the exact moment
     the reader should be sharing a link. Now distinguishes no-one-here from nobody-graded,
     and does the same for a group that is still just its owner.
   - **Still open, deliberately not fixed here: the leaderboard is buried inside My
     History**, below the prediction list, behind a menu item named after something else.
     Friends, groups and invites all exist to feed it and nothing in the UI says
     "leaderboard". A tester invited to compare against their crew has no path to the thing
     they were invited to. This is a navigation change, not copy, and it is now the most
     valuable unmade decision in this section.
   - Minor, unresolved: an empty bingo card offers only **Pick for me** and **Actions ▾** —
     no Save until something is picked, so day one shows a 5×5 of `＋` with no stated goal.
     Defensible (nothing to save yet), but nobody has decided it.

4. **Partly answered.** Both games carry a prominent live countdown — `🔓 Locks in 26d 1h ·
   19:30 local` — so a signed-in tester *looking at the app* cannot miss the deadline, and
   `No predictions yet` now names the open show too. What does not exist is anything that
   reaches somebody who **isn't** looking. With no email there is no channel, so this stays
   an in-app problem: a cohort that forgets to open the app produces no graded predictions.

5. ~~Password recovery~~ — **done 2026-08-09**, see above.

### Then

1. **Pre-cache the next track — HIGH priority, after the cohort blockers.**

   **The gap is 255ms, measured.** Captured off real transport events by grabbing the
   module's detached `Audio` and seeking to two seconds before a track's end:

   ```
   ended        0 ms   Sample in a Jar
   waiting     +1 ms   next track
   loadstart   +1 ms
   canplay   +255 ms
   playing   +255 ms   Sparkle
   ```

   The whole gap is one network round-trip. `advance()` fires in ~1ms, so nothing in our code
   is slow; `preload="none"` simply means the fetch cannot start until the previous track has
   ended. Expect ~255ms on desktop broadband; do not go looking for a bug in `advance()`.

   **Shape that fits:** two `Audio` elements ping-ponging — one plays while the other holds
   the next track pre-buffered, swap on `ended`, the old one becomes the next preloader. A
   single element cannot do this: assigning `.src` tears down the buffer it is playing from.

   **Preload late, via `timeupdate`, ~20-30s from the end.** This is what keeps it honest.
   Most sessions stop mid-track, so preloading at track start would fetch files nobody hears
   — and phish.in pays for that. Being 20s from the end is a strong signal somebody is
   actually listening. Same reasoning that put `preload="none"` there; see the header block
   in `relisten.js`.

   **Two things that will bite:**
   - `paint()` decides the playing row with `a.src === t.mp3`, and `advance()` locates itself
     with `queue.findIndex(t => t.mp3 === audio.src)`. Both assume ONE element. Two makes
     "which src counts" ambiguous, and the failure lands exactly at the swap. Needs an
     explicit active-element concept before either is touched.
   - iOS Safari restricts multiple media elements and largely ignores `preload` on cellular.
     Expect a desktop-and-Android improvement only.

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
     turns those into outcome odds). A menu presenting them as mutually exclusive teaches the
     audience most likely to notice something false. If it ships, the axis is *how much
     uncertainty do you want to see*: ranked picks → probabilities → odds.
   - It's safe to expose at all only because predictions are graded against the real setlist,
     never against the model — so a user's mode can't touch their points or the leaderboard.
     It **would** fragment Track Record, which grades the model.
5. **Calibration caveat.** `lib/model.mjs` gates the opener, closer, set-2-opener and encore
   pools on `c.score > 0` (four places, in the block building `openerPool`/`closerPool`/
   `s2openPool`/`encorePool`). Score accumulates penalties from zero (−15 just played, −10
   played at last tour show, −5 for 3+ tour plays) against a base of only `freq × 30`, so
   those gates are **load-bearing**. A calibrated probability is never ≤ 0, so *replacing*
   `score` silently makes all four vacuous and changes the predicted setlist. Add `p`
   alongside `score`; do not swap it. The calibrator must also be fitted inside the
   walk-forward loop, or the backtest gets optimistically wrong in a way that looks like the
   calibration helped.

## Key files

Anchors, not line numbers — an older version of this doc cited a tagline at "line 343" that
had drifted 80 lines by the time anyone read it.

| Path | Role |
|---|---|
| `lib/model.mjs` | The prediction model, pure. Leakage guard at the top of `buildModel`. The `score > 0` pool gates are near the bottom. |
| `lib/dayrepeat.mjs` | Day-since-last-play curve; `DAY_CURVE_K` lives in `model.mjs`. |
| `lib/scoring.mjs` | Setlist + bingo scoring. `SETLIST_POINTS`, `SETLIST_SOFT_CAP`, per-row `rows`/`setTotals`. Mirrored in `predictor.js`; a test asserts they stay in step. |
| `lib/showtime.mjs` | Showtime parsing, venue→timezone, `lockStateFor`, `preferResolved`. |
| `lib/identity.mjs` | Email/handle rules **and** `sanitizeLine`/`sanitizeBlock`/`sanitizeAvatar`. |
| `src/auth.mjs` | Hashing, sessions, cookies. `newToken()` mints both session and reset tokens. `RESET_TTL_MS`, `PBKDF2_ITERATIONS`. |
| `src/worker.mjs` | Every route. Lock check, admin endpoints, password reset. Static assets are served **before** this runs. |
| `src/db.mjs` | D1 queries; `NOT_BANNED` and the split stats. |
| `src/showtimes.generated.mjs` | Generated lock table bundled into the Worker. Do not hand-edit. |
| `web/index.html` | Everything: all CSS, dashboard, tab bar, banner. Find by symbol — `TAGLINES`, the `CK5` block, `.hall`/`.rig`, `renderTabs`, `stage-actions`, `venueShowsGrid`, `songCell`. |
| `web/predictor.js` | The games. `initPredictor(mount, A, opts)`. `renderBingo` holds swap + lock logic; `actionsMenu`; `renderPasswordReset`. |
| `web/relisten.js` | The audio player. `slugify` is the single source of truth for phish.in slugs. `bind(container)` wires `data-listen-*`; `playFrom()` is the only way playback starts; `advance()` stops at the queue end. |
| `web/_headers` | Cache policy. Opposite rules for the HTML and the hashed scripts — read the file, it explains why. |
| `scripts/build-public.js` | The deploy allowlist, the content-hash stamping, and publishing `_headers`. Throws if a stamp matches nothing. |
| `scripts/backtest.js` | Dev tool. `--experiments`, `--tune`. Needs gitignored raw setlists. |
| `.github/workflows/deploy.yml` | Fires on push to `main`. Tests gate the deploy. Deliberately does **not** run migrations. |

## Open decisions / questions

- **Bingo scoring** — the 5×5 grid is ruled out for change. Measured: a line completes in at
  most ~8% of cases even with an optimal card, and 89.6% of shows saw no bingo among 20
  simulated cards. So "first to bingo" would fall through to total calls ~9 shows in 10.
  Unresolved.
- **Profanity filter** — `obscenity` recommended (0 deps, 149KB). Would be this repo's
  **first runtime dependency**, a stated architectural property.
- **Track record** sits under the Predicted Setlist sub-tab, not its own — flagged, never
  confirmed.
- **Era window / tour totals** are stated nowhere since the header line was cut.
- **Attendance toggle** hidden behind `SHOW_ATTENDANCE_TOGGLE = false`. While off nobody can
  mark a new show, so the points-at-shows split stops accumulating.
- **Six legacy graded predictions** remain on the old 0–100 setlist scale, excluded from
  aggregates rather than re-scored.
- **Title mismatches between catalogues.** Our setlists and the recordings' track lists agree
  on words, not always punctuation ("Thru" vs "Through"). Matching is on letters and digits
  only. **Fuzzy matching was deliberately rejected**: across the venue grid's 240 distinct
  songs, `tweezer`, `axilla` and `meat` are each a prefix of another song, so a prefix match
  would serve Tweezer Reprise to someone asking for Tweezer.

## Gotchas

- **Migrations are manual and must be applied to remote BEFORE merging dependent code.**
  `npx wrangler d1 migrations apply kalphishi --remote`. CI deliberately does not do this.
  Latest applied to remote: `0007_password_resets.sql`. **`0008_invite_groups.sql` is
  pending** — local only, and `group-invites` must not merge before it lands.
- **`wrangler dev` does not pick up brand-new files.** It hot-reloads edits to existing ones
  but 404s a file added since startup — restart after adding one. Cost a wrong diagnosis
  twice.
- **`npm test` does not rebuild `public/`.** Editing `web/*` and then testing in the browser
  serves the OLD bundle. Run `npm run build:ci` first. This is the single most common way to
  waste ten minutes here, and it looks exactly like a caching bug.
- **The asset watcher can die with `EBUSY: resource busy or locked`** on Windows, disabling
  hot reload. Serving still reads from disk per request, so it affects convenience, not
  correctness — verify with a hash comparison rather than assuming staleness.
- **Cloudflare's edge lags a deploy by a few minutes.** Right after a merge some fraction of
  fetches return the previous version; it converges on its own. **Re-check before
  diagnosing** — this has produced false "the route is broken" and false "the stamp didn't
  update" readings more than once. No header fixes it.
- **Local files are CRLF, CI builds on Linux with LF**, so a hash of a local build never
  matches the deployed one. Normalise with `tr -d '\r'` before comparing, or you will
  "discover" a deploy problem that does not exist.
- **`node --test` uses the spec reporter (✖), not TAP.** Grepping its output for `not ok`
  silently counts zero failures — which once produced a false pass while mutation-testing a
  guard. Read the `ℹ fail` line instead.
- **Browser tests drift between tool calls.** Holding a DOM reference across a repaint, or a
  tab selection across calls, has produced two false results. Do a whole browser check in
  ONE evaluation.
- **The Browser pane can stop compositing mid-session** — screenshots fail with *"the Browser
  pane is not displayed"* while DOM reads keep working. Geometry, copy and computed styles
  are still verifiable; only the visual check is lost. Ask for the pane.
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
- **`predictor` and `menuMode` in `index.html` are `let`, declared above `initPredictor`** on
  purpose — `onModeChange` can fire from inside it.
- **`.overlap` in venue setlists means "also in the current top-40 candidates."** It is an
  underline carrying data. Playable songs there are deliberately *not* underlined so that
  signal survives — see `.setlist a.s:not(.overlap)`.
- **Never bulk-wipe `data/db.json` or D1 user rows.**
- **`data/archive/*.json` is committed on purpose** and cannot be regenerated. A test guards
  the gitignore pattern.

## Branches

```
main            1bdf3e3   ← production, current
handoff-refresh           ← this document, unmerged
group-invites             ← branched from handoff-refresh; needs 0008 on remote first
```

Everything is merged. Nine branches are fully merged and safe to delete: `explain-soft-cap`,
`first-run-mobile`, `bingo-cell-icons`, `scoring-scope`, `play-a-show`, `show-autoadvance`,
`controls-and-taglines`, `password-reset`, `cache-policy`. A further ~13 older branches carry
commits unreachable from `main` (squash-merge leftovers) — `backtest-harness` and
`leaderboard-split` are the two I would not delete unexamined.

Branch from `main` for the next piece of work.
