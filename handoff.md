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

**Written:** 2026-08-15, evening (replaces the early-morning version, which predates the
entire MVP overhaul and all of Crew Night)

> **Production is current and nothing is unmerged.** **327 tests pass.** Migration
> `0009_wombat.sql` is applied to remote; nothing is pending.
>
> Five rounds merged today, in order: the mobile MVP overhaul (#56), Crew Night phases
> 0–1 (#57), phase 2 with the arm renames and the provenance tag (#58), phase 3, reveal
> night (#59), and **Wombat v1 (#60)** — the crew-only draft game (WOMBAT.md: rules,
> simulation, cascade tie rule), as the third game tab with per-game rig palettes
> (bingo violet · setlist sunset · wombat green/gold/indigo) and the mobile banner
> scrim/shadow hardening. The morning handoff was adversarially audited — 24 confirmed
> discrepancies, ~90% verified accurate — and the corrections are folded into THIS
> document; the full report is committed as `handoff-review.md`.

Still **closed beta** (~30 testers). The URL is public and registration is open, but this
is not a public launch — say "in beta," never "launched."

---

## Current goal

**Accumulate graded predictions, now with the social loop live.** The track record still
holds **one graded show**. Dick's is **2026-09-04 to 09-06** (Fri/Sat/Sun), three weeks
out, and everything shipped today points at it: reveal night debuts at the night-one lock
(**19:30 America/Denver, 2026-09-05T01:30Z**), when every crew's envelopes open at once.

**The remaining blocker is still not code.** `reach.md`'s message 1 has never been sent.
The Crew pages and the reveal are exactly what those six messages now have to point at.
If one thing happens before the show, make it that — and mint the invite link with
`maxUses: 0` first, because new links default to 10 uses and fail silently for the
eleventh person.

The immediate next conversation is **what Phase 4 actually contains** — the engagement
menu is deliberately à la carte, and the user wants to pick.

## Done

### Today, round 1 — the mobile MVP overhaul (#56)

- **Dark-mode legibility, root-caused.** The hall runs 760px down the page and
  `--card-bg` was 58% translucent, so both games' text sat on moving saturated beams.
  Cards are now **opaque in both themes**; the hall stops at 420px on phones; the header
  slimmed so each game fits one 375px screen (was ~2).
- **Per-theme secondary text.** `--muted`/`--ink-2` were single values shared by both
  themes (3.3:1 on light — an AA failure at 11–12px). Retuned per theme;
  `test/assets.test.mjs` now **recomputes the WCAG ratios from the stylesheet** on every
  run.
- **Theme toggle** (Auto / Light / Dark) in ☰, persisted in localStorage key
  `kalphishi-theme`. Three-state CSS: bare `:root` = light, the dark tokens declared
  TWICE (media-query block for Auto + `[data-theme="dark"]` for the explicit choice) —
  **a test asserts the two dark blocks are token-identical**, because drift between them
  only shows on one OS.
- **Data left the tab row** for the ☰ menu (both signed-in and signed-out states). The
  row is now `Bingo | Setlist | ▶ Play`. `window.KalphishiGoData(subtab?)` is the bridge
  from the menu IIFE into the dashboard.
- **Faster signup.** Create account above Sign in; first-time visitors land on the
  register tab (`probablyHasAccount()` checks the `kalphish-user` key, which survives
  sign-out on purpose); display name optional (server already derived handle/name);
  copy cut to "Email + password. That's it."
- **Wizard off, not deleted.** `WIZARD_ENABLED = false` at its single chokepoint
  (`wizardActive`), all five steps intact, `wizardSeen` never written while off. A test
  pins all three properties.
- **Mobile game polish**: bustout tiers as **cell borders** on the bingo card (badges
  hidden ≤560px; `--bust-mega` token minted), lock state moved from border to a
  **`--lock-wash` background fill** so locks and tier rings compose, setlist badges
  (OPENER/CLOSER/bustouts) ranged right beside the ×, control row `nowrap` so the ⋮ can
  never orphan, collapsible Set 1/2/Encore, PHISH column dropped on phones, brighter
  badges in dark.

### Today, round 2 — Crew Night phases 0–1 (#57)

- **Phase 0, the seal.** `GET /api/predictions` no longer hands payloads to anyone.
  Your own rows: always full. Anyone else's, pre-lock: `{userHandle, showdate, type,
  sealed: true}` — **no payload key at all**, not a nulled one. Post-lock: full payload
  to the predictor's friends and shared-group members (one `friendships UNION
  friend_group_members` query collapsed to a Set — never per-row). Strangers stay sealed
  forever; public accuracy lives on the leaderboards in aggregate. Lock via the same
  `lockStateFor` the save route enforces; a show missing from SHOWTIMES reads as
  not-locked and therefore **fails toward secrecy**.
- **Phase 1, the roster.** Members route gained `?showdate=` → per-member
  `{setlist, bingo}` booleans; groups route gained `inCount`. Every member can see who
  is in their group (the route was always membership-gated — only the UI was owner-only).

### Today, round 3 — the Crew page, renames, provenance (#58)

- **The Crew page** (`renderCrew`, mode `'crew'` beside history/profile). Tapping a
  group's name in the drawer opens the room: name row (owner ⋮: inline rename via new
  owner-scoped `PATCH /api/groups/:id`, and "Invites & members" →
  `KalphishiMenu.openFriends()`), the status strip ("1 of 2 in for Fri · locks in 20d
  9h" over a fill bar), both boards via `renderLeaderboard(game, wrap, fixedScope)` —
  the picker is suppressed when pinned — and the roster with dots + sealed 🔒 pills.
  Phase 1's in-drawer roster lived exactly one release and was replaced by the room.
- **Arm labels renamed for players**, keys untouched: `model` → **House Model**,
  `modelTopN` → **Straight Ranking**, `modelDuenessTopN` → **Native Model** (was
  "Fitted dueness"), `modelShowGap` → **Classic Recency**. Labels live in `LENS_ARMS`
  in `scripts/analyze.js` and ship inside the committed `data/analysis.json` —
  regenerated today (label-only diff plus timestamp). All prose naming the old labels
  updated; a test pins the mapping.
- **The provenance tag.** The 🛟 chip no longer marks "a lens is selected" — it appears
  when Our Prediction fills a board and **only while the board still IS that fill**,
  compared by snapshot (`appliedFill` / `setlistSnap` / `gridSnap`) on every render.
  First edit takes it off; recreating the exact prediction re-earns it honestly.

### Today, round 4 — reveal night (#59)

- At the lock the Crew page flips: **The chalk** (songs ≥ half the crew called, minimum
  two callers, ✅ once graded), **Sole calls** ("only @pat", 🏆-first post-scoring when
  a sole call played), **Your overlap**, and the **recap** (top scorer + crew average
  per game, never merged) once the cron grades. A member's calls are the **union** of
  setlist songs and bingo squares.
- **No new server surface** — the reveal reads the same predictions route; sealed rows
  carry no payload and drop out of every count. One visibility rule, one place.
- **Share card**: pure-SVG summary → canvas → PNG in-document, crew name XML-escaped,
  nothing fetched. Delivery chain **fails independently**: share-sheet with files →
  clipboard → named download. (First cut wrapped all three in one try; a declined
  clipboard permission aborted with a good PNG in hand. Fixed and tested.)
- **Verified by flipping the lock locally**: set 2026-09-04's `lockAt` into the past in
  BOTH `src/showtimes.generated.mjs` and `data/showtimes.json`, rebuilt, and watched the
  full lifecycle live — seal open to crewmate, shut to stranger, chalk "Tweezer 2 of 2",
  a bingo-only song in sole calls, overlap counted, PNG delivered. Restored after.
  `test/showtime.test.mjs` flagged the flipped lock as implausible while it was in
  place — remember that guard exists when you try this.

### Corrections folded in from the audit (`handoff-review.md`)

- **`npm run backtest -- --tune` no longer confirms the day curve** — it compares
  against `s.arms.model.r`, and `model` now IS the day-curve model, so it prints
  "+0.41pp z 0.63 NOT CONFIRMED". The historical +2.57pp/z 3.08 was against the
  pre-day-curve baseline, which survives as `modelShowGap`. The stale "reproduce with
  --tune" pointers at `scripts/backtest.js:570` and `lib/model.mjs:21` are **not yet
  fixed in source** — see Next steps.
- **`data/history.json` is churned by `build:history` (via `build:ci`), not by
  `npm run analyze`.** Confirmed by experience roughly five times today. `analyze` still
  bumps `data/archive/*.json` timestamps — restore both rather than committing them.
- The old handoff's 45-line era planning block ("Open: which mechanism", "expect era
  arms to score below shipping") described work that had already shipped and is deleted,
  not carried forward. What survives of it: **the control arm — centred log of the
  model's own recent play rate — beats `modelTopN` by +0.70pp at z 2.46**, real by this
  repo's own bar, and is still not built into anything. It remains the best cheap model
  idea on the table.
- Four cross-references (`reach.md:6`, `reach.md:201`, `src/worker.mjs` near the reach
  route, `test/reach.test.mjs`) still cite "handoff.md, Next steps item 4" for the
  no-mail/no-push reasoning; the renumbering broke them and the content they promise now
  lives in `SOCIAL-PLAN.md`'s constraints — see Next steps.

## In progress

**Nothing.** All four rounds are merged, deployed, and green. The next conversation —
already requested — is choosing from the Phase 4 menu.

## Next steps

### 0. Send message 1. Still. Before anything else.

Zero code. `reach.md` has it written; the crew features are its new payload. Mint the
link with `maxUses: 0` first. Then pull the baseline so the campaign can be measured:

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" https://kalphishi.kalphishi.workers.dev/api/admin/reach
```

### 1. Decide Phase 4's contents (discussion open now)

`SOCIAL-PLAN.md`'s menu, ranked there by fun-per-effort: superlatives (derived),
rivalry records (derived), donut reactions (the one migration), streaks (derived),
live-night presence (reuse `live_checked`), who's-going (flag exists, off). Each stands
alone. Anything picked should ship before Dick's to debut with real data.

### 2. Small debts from today

- Repoint the four "Next steps item 4" cross-references (two in `reach.md`, one comment
  in `src/worker.mjs`, one in `test/reach.test.mjs`) at `SOCIAL-PLAN.md`'s "Existing
  constraints hold" block, which is where that reasoning now permanently lives.
- Fix the stale `--tune` reproduce pointers (`scripts/backtest.js:570`,
  `lib/model.mjs:21`) to name `modelShowGap` as the comparison arm, the way
  `--tune-dueness` names `modelTopN`.
- Local D1 still holds test accounts `crew-a` / `crew-b` (password `crewtest1`, group
  "Helping Friendly Crew", picks saved for 2026-09-04). Harmless; delete surgically if
  wanted — **never bulk-wipe local D1.**

### 3. Dick's, 4–6 September

Three nights. The reach messages for the mornings after nights one and two are the
highest-yield in the sequence — fill their bracketed figures from the real results. The
reveal makes those mornings self-demonstrating: the recap and share card ARE the content.

### 4. Model work, unchanged in priority

- **Fitted dueness → shipping default** (now labelled Native Model) only if Dick's
  confirms the drift hypothesis: its edge is +0.75pp at z 1.23 full-window, but +2.3pp
  in 2026. Three graded shows in September are the first uncontaminated test.
  `npm run backtest -- --tune-dueness` afterwards.
- **The +0.70pp z 2.46 control-arm term** (see corrections above) — tuned and held out
  properly, this is the most evidence-backed untried change.
- **Logistic regression on existing per-song features** — must beat `modelTopN` at
  28.5%, not `model` at 27.7%.

## Key files

Anchors, not line numbers — line numbers in this doc have drifted before.

| Path | Role |
|---|---|
| `SOCIAL-PLAN.md` | Crew Night: the whole design, constraints, and the Phase 4 menu. Status header says what shipped. |
| `handoff-review.md` | The adversarial audit of the previous handoff — read before trusting any number older than today. |
| `reach.md` | The campaign: six messages, timing, targeting. Operator doc, not published. Message 1 unsent. |
| `lib/model.mjs` | The prediction model, pure. Leakage guard atop `buildModel`; inert pool-gate note near the bottom; era term. |
| `lib/showtime.mjs` | `lockStateFor(showtimes, showdate, now?)` — the ONE lock authority; unknown show ⇒ not locked ⇒ sealed. |
| `lib/calibration.mjs` / `lib/scoring.mjs` / `lib/baselines.mjs` / `lib/hazard.mjs` / `lib/shrinkage.mjs` / `lib/dayrepeat.mjs` | Unchanged today; see comments in each — shrinkage is kept as a rejected record. |
| `src/worker.mjs` | Every route. The SEAL lives in GET `/api/predictions`; groups + members + rename; `/api/admin/reach`; static assets served before any of it. |
| `src/showtimes.generated.mjs` | Lock table bundled into the Worker. Do not hand-edit — except deliberately, locally, to test reveal (restore after; a test will scream meanwhile). |
| `web/index.html` | Everything page-side: tokens (dark declared twice, on purpose), menu IIFE (`themeRow`, `openFriends`, `KalphishiGoData`), dashboard, Nerd Zone. Find by symbol. |
| `web/predictor.js` | The games + the crew. `renderCrew`, `renderReveal`, `shareRevealCard`, `appliedFill`/snapshots (provenance tag), `renderLeaderboard(game, wrap, fixedScope)`, `WIZARD_ENABLED`. |
| `scripts/analyze.js` | `LENS_ARMS` — the arm labels players see. Editing a label means regenerating `data/analysis.json` (needs local caches) and restoring archive/history churn. |
| `scripts/backtest.js` | Dev tool. `--tune`'s confirm line is misleading now — see corrections. |
| `data/analysis.json` | Committed, regenerated today (labels). `data/arms.json` / `calibration.json` untouched. |
| `test/social.test.mjs` | Crew Night guards: seal shape, lock source, visibility query, roster booleans, crew page, provenance tag, share-card chain, label mapping. |
| `test/assets.test.mjs` | Front-end guards incl. dark-block identity and computed WCAG ratios. |
| `.github/workflows/deploy.yml` | Push to `main` only; no CI on branches/PRs; never runs migrations. |

## Open decisions / questions

- **Phase 4 contents** — the open discussion. See Next steps 1.
- **Does Native Model become the shipping default?** Dick's is the test (Next steps 4).
- **Bingo scoring rework** — 5×5 line-bingo stays ruled out (89.6% of shows saw no bingo
  across 20 simulated cards). Unresolved, deferred.
- **Profanity filter** (`obscenity`, would be the first runtime dependency) — deferred;
  matters more if Phase 4 picks reactions (canned emoji only, so maybe not even then).
- **Wizard's future** — off for MVP. Either delete it eventually or rebuild it as
  something that fires at a better moment; nobody has decided.
- **Attendance toggle** still `SHOW_ATTENDANCE_TOGGLE = false`; "who's going" in Phase 4
  would flip it.
- **Era window / tour totals** stated nowhere in the UI since the header line was cut.
- **Six legacy graded predictions** remain on the old 0–100 scale, excluded from
  aggregates.
- **Title matching** stays letters-and-digits only; fuzzy matching stays rejected
  (`tweezer` is a prefix of Tweezer Reprise).

## Gotchas

### The seal (new — internalize these before touching predictions or crew code)

- **The sealed shape carries NO payload key.** Clients test `p.payload` truthiness;
  tests assert the key's absence. Never "helpfully" null it.
- **Visibility is one rule in one place** (GET `/api/predictions`). The members route
  returns booleans and must never grow a payload column; the reveal computes client-side
  from the sealed route. Adding a second server surface that reads payloads means two
  rules to keep consistent — don't.
- **To test reveal locally**: flip `lockAt` for a Dick's date into the past in BOTH
  `src/showtimes.generated.mjs` (server) and `data/showtimes.json` (client, via
  `build:ci`), restart wrangler. `test/showtime.test.mjs` fails while flipped — that is
  the guard, not a bug. `git checkout` both files after; save test picks BEFORE
  flipping, because the save route 423s once locked.
- **Unknown showtime ⇒ sealed forever to others.** Legacy shows absent from SHOWTIMES
  never reveal. Deliberate; fail toward secrecy.

### Measurement traps (carried forward, corrected)

- **`--tune` prints NOT CONFIRMED now and that is a stale comparison, not a regression**
  — the arm it compares against became the shipping model itself. See Next steps 2.
- **The `score > 0` pool gates are INERT** (measured: deleting them changes zero of 174
  shows). They bind in one direction only: a term dragging scores far negative empties a
  pool and the fallback fires. Rule for new terms: don't drag the distribution negative.
- **A held-out split is not a control when the effect is time-varying** — check the
  per-year split before believing a confirmation.
- **An affine transformation cannot reorder a ranking** — check whether a change CAN
  change the order before measuring whether it does.
- **`data/backtest.json` only regenerates under `--json`** and goes stale silently.
- **By-year `GAIN` is signed so positive means the BASELINE won.**
- **Only published arms get published numbers** — `modelShrunk` etc. are measured but
  absent from `arms.json`.

### Build and deploy

- **Migrations are manual, applied to remote BEFORE merging dependent code**
  (`npx wrangler d1 migrations apply kalphishi --remote`). Latest: `0008`. CI never runs
  them. Nothing pending.
- **`npm test` does not rebuild `public/`** — run `npm run build:ci` before browser
  checks, then **restart wrangler every time** (it keeps serving the old stamped
  `index.html`; compare `grep -o 'predictor\.js?v=[0-9a-f]*' public/index.html` against
  the DOM before touching source).
- **`build:ci` churns `data/history.json`'s timestamp** — `git checkout` it after every
  build. (`analyze` churns `data/archive/*` — same treatment.)
- **Regenerating `data/analysis.json`** (label edits!) needs the ~79MB gitignored year
  caches, present on this machine only.
- **Cloudflare's edge lags a deploy by a few minutes.** CRLF locally vs LF on CI —
  normalize before comparing hashes; lazy-run regexes absorb `\r` in front, not behind.
- **No CI on branches or PRs** — local `npm test` is the only pre-merge signal.

### Environment

- **`node --test` uses the spec reporter** — read `ℹ fail`, never grep "not ok".
- **Browser-pane drift**: do a whole check in ONE evaluation; the pane can stop
  compositing mid-session (screenshots fail, DOM reads keep working — geometry and
  computed styles remain verifiable).
- **Port 8787 fights**: a killed wrangler leaves workerd orphans that hold the port; a
  parent respawns its children, so kill the `node …wrangler` parents first. A wedged
  instance accepts connections and never responds (CloseWait pileup). The user sometimes
  runs their own `wrangler dev --ip 0.0.0.0` for phone testing — check whose process it
  is before killing.
- **Bash tool is Git Bash** (heredocs, not PowerShell here-strings); `cd` resets between
  calls; Node needs `C:/...` paths, not `/c/...`; one statement per `--command` on
  Windows; `\uXXXX` escapes mangle through editing tools (identity.mjs uses code points).
- **Local D1 is separate from remote; cleanup is surgical, never bulk.**
- **`data/archive/*.json` is committed on purpose and cannot be regenerated.**

### Design constraints that will bite

- **Two dark token blocks must stay identical** — a test enforces it; edit both or fail.
- **`--lock-wash` vs tier borders**: locks are FILLS, bustout tiers are BORDERS (phone).
  Reintroducing a lock border collides with `--bust-mega` red.
- **The control row never wraps ≤560px** (`.p-controls` nowrap; text buttons shrink; ⋮
  fixed). New controls go in the Actions menu, not the row.
- **`usesCalibration` is load-bearing** — only arms sharing the shipping score
  distribution may show a Chance; a test enforces it.
- **`const sections = [...app.children]` is a one-time snapshot** — cards appended after
  it render on every sub-tab at once; refill existing elements.
- **Drag on touch stays unimplemented for bingo** (`touch-action` would kill scrolling).
- **`.overlap` in venue setlists means "also in current top-40 candidates"** — playable
  songs there are deliberately not underlined.
- **No tagline names the app** — keep it that way so renames never hunt through jokes.
- **The share card must stay dependency-free and fetch-free** — a test enforces the
  data-URI SVG and the fallback order.

## TODO list (verbatim)

1. [completed] Fix dark-mode legibility: stop the light rig bleeding through cards
2. [completed] Raise contrast of --muted / secondary text in both themes
3. [completed] Add an explicit theme toggle (Auto / Light / Dark)
4. [completed] Cut text volume on both games (mobile brevity pass)
5. [completed] Move Data out of the tab row into the ☰ menu
6. [completed] Speed up account creation
7. [completed] Hide the first-run wizard without deleting it
8. [completed] Verify at 375px in both themes and get the suite green
9. [completed] Color-code bustout tiers as cell borders on mobile bingo
10. [completed] Hide setlist song sub-text on mobile
11. [completed] Make Set 1 / Set 2 / Encore collapsible
12. [completed] Brighten OPENER/CLOSER/ENCORE badges for dark mode
13. [completed] Drop the left PHISH column from mobile bingo
14. [completed] Phase 0: seal GET /api/predictions
15. [completed] Phase 1 server: roster dots + group in-counts
16. [completed] Phase 1 client: member roster for every member
17. [completed] Tests + live D1 verification + suite green
18. [completed] Phase 3: reveal view on the Crew page
19. [completed] Phase 3: share card (SVG → PNG, no deps)
20. [completed] Phase 3: tests, lock-flip live verification, commit

## Branches

```
main   6a5cfd8   ← production, current, deployed green, 315 tests
```

Nothing is ahead of `main`. Branch from it for Phase 4.

Merged today (squash residue, kept per house habit): `mvp-mobile` (#56),
`crew-phase-0-1` (#57), `crew-phase-2` (#58), `crew-phase-3` (#59). Older leftovers
unchanged from the last inventory: `backup-pre-rewrite`, `bingo-cell-icons`,
`cache-policy`, `cloudflare-migration`, `controls-and-taglines`, `drop-tagline`,
`explain-soft-cap`, `first-run-mobile`, `handoff-current`, `handoff-refresh`,
`handoff-social`, `nerd-zone`, `password-reset`, `play-a-show`, `roadmap-precache`,
`scoring-scope`, `show-autoadvance`.
