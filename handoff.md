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

**Written:** 2026-08-20 (replaces the 2026-08-16 midday version)

> **Production is current and nothing is unmerged.** `main` is at `9cd6f0c`, deployed to
> production today (Worker version `59b341cc`), **360 tests pass**, the working tree is
> clean, and **no migrations are pending** — `0010_live_presence.sql` is still the latest,
> applied to remote.
>
> Four commits since the 08-16 version: the Data menu de-emoji (`5f75e2f`), Wombat's
> pre-lock line in the crew room (`871014d`), and the Ask Diego strobe (`bac44ca`, tuned
> in `9cd6f0c`). Everything from the big 08-15/16 push is in underneath.

Still **closed beta** (~30 testers). The URL is public and registration is open, but this
is not a public launch — say "in beta," never "launched."

---

## Current goal

**Dick's, 2026-09-04 to 09-06 — 15 days out.** Everything social now exists: crews, sealed
picks, reveal night, Wombat, superlatives and live presence. The track record still holds
**one graded show**, and three nights in September are the first real chance to change
that.

**The blocker has not been code since the 14th and still is not.** `reach.md`'s message 1
was still unsent as of the 08-16 version, and nothing in the 08-20 session sent it either.
It has Wombat, the crew room, reveal night, superlatives, live-night presence and now a
light show to point at, and it needs no code at all.

## Done

### Today (2026-08-20)

- **The Ask Diego strobe** (`bac44ca`, tuned `9cd6f0c`). Pressing ✨ Ask Diego? in any
  game halts the conical rig — the heads go dark and **hold their sweep phase** (paused,
  not torn down) — while hard white pops pepper the banner: twenty 25–80px bursts on
  random beats plus two broad washes, all confined to the strip **above the game tabs**.
  Constraints that are load-bearing and pinned by the 360th test: the two washes sit at
  fixed beats 820ms apart (under the three-large-flashes-a-second photosensitivity line),
  and **reduced motion skips the strobe entirely**. The strobe belongs to the BUTTON —
  the Actions-menu shuffle doesn't fire it, and Save keeps its existing white peak.
  Iterated three rounds against the deployed app on a phone; the knobs (count, size
  range, `STROBE_MS`, wash beats, envelope) all sit at the top of `rigStrobe()` /
  `.strobe-flash` in `web/index.html`.
- **Wombat's pre-lock line in the crew room** (`871014d`). "N of M have a Wombat pick
  in" rides the status strip, pre-lock only. Deliberately NOT a third board tab: Wombat's
  score stays `null` by design (resolved fresh per crew at the reveal, never aggregated),
  so there is no standings board to give it — the strip line answers the one thing worth
  asking before the lock, and the reveal's draft section still owns the rest.
- **Data menu de-emoji** (`5f75e2f`). The 📊 was the only icon in the account menu; the
  test that greps for the menu item now matches `item('Data'`.
- **Verified, no code needed** (worth not re-investigating): the **setlist closer bonus
  is already length-independent** — 10 called songs against a 6-song set closing on the
  same song pays call + closer (5 pts) and nothing for the unplayed middle, confirmed by
  running `scoreSetlistPrediction` on the exact scenario. And the **crew room reads
  correctly from a non-owner member** (signed in as crew-b): owner tools hidden, sealed
  picks invisible, roster and boards identical.
- **Two production deploys** — prod is `9cd6f0c` exactly (Worker version `59b341cc`).

### 2026-08-16

- **The invite door** (`8da9aff`). New `GET /api/invites/:code/preview` — deliberately the
  only invite route with no session check, because the reader has no account yet and
  holding a 16-byte code IS the authorisation. Answers three things and structurally
  cannot answer a fourth: display name (via `publicName`, so a legacy email-as-name cannot
  leak), avatar, crew name. No email, no handle, **not even the group id**. Verdicts are
  worded identically to redeem so one link cannot read two ways. The modal now says
  **"🎣 Crew A invited you to Helping Friendly Crew."** before anyone types a password, and
  a dead link says so up front while still offering signup.
- **Redemption lands you IN the crew** rather than announcing it — a 2.5s toast is the
  wrong medium at the worst moment on a phone. Two bugs caught by live testing: the flash
  was being **destroyed by the very re-render that navigated away** (announce-then-navigate
  wipes the announcement; order is now load-bearing and pinned by a test), and **a ban did
  not reach links the account had already minted** — moderation was one old URL away from
  being bypassed. Both fixed.
- **The copy pass** (`VOICE.md` applied). 19 strings rewritten toward the community's own
  nouns. The Nerd Zone is untouched on purpose.
- **Account deletion** (`0e7898f`). `DELETE /api/me`, password-confirmed (a session alone
  is the wrong bar for something irreversible — the realistic threat is an unlocked phone,
  and that hand already has the session). Legacy passwordless accounts pass on their
  session. Real deletion, no tombstone. **Found: `password_resets` carries a bare `user_id`
  with no FK at all** — it is cleared by hand. **D1 does enforce foreign keys** (verified,
  since SQLite defaults them off). Owned crews die with the account and the panel names
  them first.
- **PWA foundation** (`4508f34`). Generated icon set (`scripts/build-icons.js` — a CRC,
  three chunks and zlib, no dependencies; the mark is the light rig), manifest,
  theme-color per colour scheme, safe-area insets, apple-touch meta, and a **cache-only
  service worker** with an offline shell. Verified by killing the dev server: the app
  rendered fully offline and recovered cleanly.
- **Superlatives** (`cb14296`). Five auto-awarded titles from a scored show, derived —
  no migration, no route. **And the real find: a Phase 3 bug.** The reveal read
  `p.result.rows`, but rows live under `result.breakdown.rows`, so the setlist branch had
  been a **silent no-op since reveal night was built** — no setlist hit ever reached
  `hitSlugs`, and the reveal's ticks came only from bingo and wombat. Exposed because a
  superlative put a *number* on it: Sharpshooter said 67% for a player who had hit 5 of 6.
- **Live-night presence** (`dd30b7e`). Migration **0010** adds `predictions.live_at`
  (plain ADD COLUMN), stamped on every tick; the members route returns a **derived
  boolean**, never the timestamp. "1 of 5 checking squares right now" plus roster pulses.
  Verified end to end including the poll clearing itself with no interaction.
- **Two review docs** (`53766ed`): `APP-STORE.md` and `VOICE.md`. See below.

### 2026-08-15, still current

Mobile MVP overhaul (#56), Crew Night phases 0–1 (#57), the Crew page + arm renames +
provenance tag (#58), reveal night (#59), Wombat (#60), sliding sessions (#61). The
morning handoff was adversarially audited — the report is committed as
`handoff-review.md`, and its corrections are folded into this document.

## In progress

**Nothing.** Every change above is merged, deployed and green. The working tree is clean.

## Next steps

### 0. Send reach message 1. Still. Before any code.

Zero code, written and waiting in `reach.md`. **Mint the link with `maxUses: 0` first** —
new links default to 10 uses and fail silently for the eleventh person. Then pull the
baseline so the campaign can be measured:

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" https://kalphishi.kalphishi.workers.dev/api/admin/reach
```

### 1. Settle the domain

Now the shared blocker on **three** things: passkeys (parked for exactly this — passkeys
bind to the domain that mints them, so every one minted on `.workers.dev` breaks on the
day of a move), store listings, and the brand mismatch with "Bathtub Bets". The highest-
leverage non-code decision on the board after the reach campaign.

### 2. Phase 4 leftovers — deliberately AFTER Dick's

Rivalry records and streaks are both derived and cheap, but they would **debut empty**:
everyone's streak is 0 or 1 right now, and head-to-head needs multiple graded shows for
both people. Features that debut empty read as broken. Wait for the run.

### 3. Remaining store work (`APP-STORE.md`)

Two of five blockers are closed (icons/manifest, account deletion). Left: **a privacy
policy**, **the domain**, and for Apple only **Guideline 4.2** (they reject repackaged
websites — clearing it most likely means push, which is a real re-opening of the reach
decision and should be decided on its own terms). Google Play's TWA path is the cheaper
one, and its 12-testers-for-14-days requirement fits the ~30-person beta.

### 4. Small debts

- Four cross-references still cite "handoff.md, Next steps item 4" for the
  no-mail/no-push reasoning (`reach.md:6`, `reach.md:201`, a comment in `src/worker.mjs`,
  `test/reach.test.mjs`). Repoint at `SOCIAL-PLAN.md`'s constraints block.
- The `--tune` reproduce pointers (`scripts/backtest.js:570`, `lib/model.mjs:21`) should
  name `modelShowGap` as the comparison arm — see Gotchas.
- Local D1 holds test accounts `crew-a` … `crew-e` (password `crewtest1`) in "Helping
  Friendly Crew", with predictions for 2026-09-04 that were **scored offline against a
  synthetic setlist** and then **un-scored again** during presence testing. Harmless and
  useful for reveal work; delete surgically if wanted, **never bulk-wipe local D1**.

### 5. Model work, unchanged in priority

- **Native Model → shipping default** only if Dick's confirms the drift hypothesis (+0.75pp
  at z 1.23 full-window, but +2.3pp in 2026). `npm run backtest -- --tune-dueness` after.
- **The +0.70pp z 2.46 control-arm term** — centred log of the model's own recent play
  rate. Still the most evidence-backed untried change, still not built into anything.
- **Logistic regression on existing per-song features** — must beat `modelTopN` at 28.5%,
  not `model` at 27.7%.

## Key files

Anchors, not line numbers.

| Path | Role |
|---|---|
| `SOCIAL-PLAN.md` | Crew Night: design, constraints, Phase 4 menu. Status header says what shipped. |
| `WOMBAT.md` | Wombat's rules, the 3,000-crew simulation behind them, and the cascade tie rule. |
| `APP-STORE.md` | Store readiness: five blockers, three tiers, what is closed. |
| `VOICE.md` | The copy audit: rules, rewrites, retire-these-words, and a protect list. |
| `handoff-review.md` | The adversarial audit of an older handoff — read before trusting any old number. |
| `reach.md` | Six messages, timing, targeting. Message 1 unsent. |
| `lib/model.mjs` | The model, pure. Leakage guard atop `buildModel`; the inert pool-gate note near the bottom. |
| `lib/scoring.mjs` | Setlist/bingo/wombat scoring. **Setlist rows live under `result.breakdown.rows`.** |
| `lib/showtime.mjs` | `lockStateFor` — the ONE lock authority. Unknown show ⇒ not locked ⇒ sealed. |
| `src/worker.mjs` | Every route. The seal in GET `/api/predictions`; invite preview; `DELETE /api/me`; live-check stamping `live_at`; `LIVE_PRESENCE_MS`. |
| `src/auth.mjs` | Hashing, sessions. Sessions **slide**; the cookie outlives the server window on purpose. |
| `web/index.html` | Tokens (dark declared twice), PWA head, safe-area insets, menu IIFE, the rig (`rigPeak`/`rigStrobe`), dashboard, Nerd Zone. Find by symbol. |
| `web/predictor.js` | Games + crew. `renderCrew`, `renderReveal`, `computeSuperlatives`, `resolveWombat`, `shareRevealCard`, `redeemPendingInvite`, `stopLivePoll`, `WIZARD_ENABLED`. |
| `web/sw.js` | Cache-only worker. Mirrors `_headers` deliberately. `__BUILD__` is stamped by the build. |
| `scripts/build-icons.js` | Draws the icon and encodes PNG with stdlib only. Output is gitignored and regenerated in CI. |
| `scripts/build-public.js` | Publish allowlist, content-hash stamping, SW cache-name stamping. |
| `test/` | 360 tests. `social`, `wombat`, `superlatives`, `account`, `pwa`, and the strobe constraints in `assets` are the newest. |

## Open decisions / questions

- **The domain** — blocking passkeys, stores and the brand. See Next steps 1.
- **Does Native Model become the shipping default?** Dick's is the test.
- **Apple Guideline 4.2** — clearing it probably means push, which contradicts a standing
  decision. Decide on its own terms, not as a side effect of wanting a store listing.
- **Privacy policy** — needs writing before any store listing.
- **Wombat's zero-point rate** (~36% of players blank on a night, by simulation). Options
  in `WOMBAT.md`: accept for v1 (leaning, with Dick's as a three-night cumulative race),
  widen the card to 7, or score the full surviving list. Re-measure with real lists.
- **Wizard** — off for MVP, intact behind `WIZARD_ENABLED`. Delete or rebuild eventually.
- **Bingo scoring** — 5×5 line-bingo ruled out; unresolved and deferred.
- **Profanity filter** (`obscenity`) — would be the first runtime dependency. Deferred.
- **Attendance toggle** still `SHOW_ATTENDANCE_TOGGLE = false`.
- **Six legacy graded predictions** remain on the old 0–100 scale, excluded from aggregates.

## Gotchas

### The newest ones

- **The strobe's floor is the tab row, measured live at press time** — never a fraction
  of the hall (the header stacks on phones and the hall is 760px against 420px). The
  clamp is on each pop's **bottom edge** and the ceiling is the invariant the band bends
  to; bending the ceiling to the band is exactly how the first cut poked into the tabs.
- **Strobe pop removal is on a timer, NOT `animationend`** — a page that isn't painting
  (background tab, hidden pane) never fires animationend, and the pops pile up forever.
  Same family as the compositing gotcha below.
- **The test accounts all have emails now** (`crew-X@test.local`, password `crewtest1`).
  The legacy name+password login path is dead for them — `anyUserLacksEmail` is false —
  so sign in with the email, not the handle.
- **Setlist rows are at `result.breakdown.rows`, NOT `result.rows`.** `hits`/`stressors`
  stay at the top level so older results still render. Reading `result.rows` is a silent
  no-op that shipped once already and went unnoticed for a day.
- **Presence never ships `live_at`** — the members route returns a derived boolean. Keep it
  that way; a timestamp says more than the question needs.
- **The live poll must stay leak-proof**: one handle, cleared unconditionally at the top of
  `render()`, re-armed only by `renderCrew`, skipped while the tab is hidden, bounded to a
  show locked within 24h.
- **The service worker must stay cache-only.** A test strips comments and greps for `push`,
  `notificationclick`, `showNotification`, `pushManager`, `periodicsync`, `Background`.
  Note the pattern: **two tests have now failed because their own explanatory comments
  contained the banned string** — strip comments before grepping source in a test.
- **The SW cache name is a hash of the built `index.html`**, and local builds are CRLF while
  CI is LF — so the same commit yields different cache names locally and in production.
  Harmless; do not treat it as a build fingerprint.
- **Cloudflare's edge lags a deploy by 1–2 minutes.** A brand-new path 404s briefly. Today
  that looked exactly like a broken deploy for `manifest.webmanifest`. Re-probe before
  diagnosing.

### The seal and the crew

- **The sealed shape carries NO payload key.** Never "helpfully" null it.
- **Visibility is one rule in one place** (GET `/api/predictions`). The members route
  returns booleans and must never grow a payload column.
- **To test reveal/presence locally**: flip `lockAt` for a Dick's date into the past in
  BOTH `src/showtimes.generated.mjs` and `data/showtimes.json`, rebuild, restart wrangler.
  `test/showtime.test.mjs` fails while flipped — that is the guard, not a bug. Save any
  test predictions BEFORE flipping (the save route 423s once locked), and `git checkout`
  both files after.
- **A scored show turns live mode off**, so presence testing needs the rows un-scored.

### Measurement traps

- **`npm run backtest -- --tune` prints NOT CONFIRMED, and that is a stale comparison, not
  a regression** — it compares against `s.arms.model.r`, and `model` IS the day-curve model
  now. The historical +2.57pp was against `modelShowGap`.
- **`data/history.json` is churned by `build:history` (via `build:ci`)**, not by
  `npm run analyze`; `analyze` churns `data/archive/*`. `git checkout` after every build.
- **The `score > 0` pool gates are INERT** (measured: deleting them changes zero of 174
  shows). Rule for a new term: do not drag the distribution negative.
- **A held-out split is not a control when the effect is time-varying** — check the
  per-year split before believing a confirmation.
- **An affine transformation cannot reorder a ranking.**
- **By-year `GAIN` is signed so positive means the BASELINE won.**

### Build and deploy

- **Migrations are manual and go to remote BEFORE merging dependent code.** Latest: `0010`.
  CI never runs them.
- **`npm test` does not rebuild `public/`** — run `npm run build:ci`, then **restart
  wrangler every time**. Compare `grep -o 'predictor\.js?v=[0-9a-f]*' public/index.html`
  against the DOM before touching source.
- **Regenerating `data/analysis.json`** (arm label edits) needs the ~79MB gitignored year
  caches — this machine only.
- **No CI on branches or PRs.** Local `npm test` is the only pre-merge signal.

### Environment

- **`node --test` uses the spec reporter** — read `ℹ fail`, never grep "not ok".
- **Do a whole browser check in ONE evaluation**; the pane can stop compositing mid-session
  (screenshots fail, DOM reads keep working). Worse: a fresh pane tab can sit at a
  **0×0 viewport with no layout at all** — `offsetWidth` reads 0 and every geometry
  number is garbage. Check `innerWidth` before trusting measurements, and know that CSS
  transitions/animations do not advance while nothing is painting, so animation-driven
  events never fire there.
- **The pane's launcher caches `.claude/launch.json` per session** — edits and even
  renamed configurations do not take; it keeps running the first command it saw. And
  `npm run dev -- --ip 0.0.0.0` does not get the flag through to wrangler (still binds
  127.0.0.1). For phone testing, run `npx wrangler dev --ip 0.0.0.0` in a real terminal
  and hit the machine's Wi-Fi IP (was `192.168.1.11`); `.claude/launch.json` is untracked
  and holds a url-attach entry so the pane can hook onto that server.
- **A stale service worker can serve an old bundle during local testing.** Unregister and
  clear caches at the start of a browser check after any rebuild.
- **Port 8787**: a killed wrangler leaves `workerd` orphans; kill the `node …wrangler`
  parents first. The user sometimes runs their own `wrangler dev --ip 0.0.0.0` — check
  whose process it is before killing.
- **Bash tool is Git Bash**; `cd` resets between calls; Node needs `file:///C:/...` URLs for
  ESM imports; one statement per `--command` on Windows.
- **Heredocs mangle backslash escapes.** Two edits were corrupted this session by `\n`
  inside a quoted heredoc; build such strings with `chr(92)`/`chr(10)` instead.
- **`wrangler d1 execute` truncates multi-statement UNION queries** — use one
  `SELECT (SELECT …), (SELECT …)` row instead.
- **Local D1 is separate from remote. Cleanup is surgical, never bulk.**

### Design constraints that will bite

- **Two dark token blocks must stay identical** — a test enforces it.
- **Locks are FILLS (`--lock-wash`), bustout tiers are BORDERS** on phones. Reintroducing a
  lock border collides with `--bust-mega`.
- **The control row never wraps ≤560px.** New controls go in the Actions menu.
- **`usesCalibration` is load-bearing** — only arms sharing the shipping score distribution
  may show a Chance.
- **`const sections = [...app.children]` is a one-time snapshot.**
- **The share card must stay dependency-free and fetch-free** — a test enforces it.
- **Superlatives are all positive.** A wooden spoon was considered and cut; a test blocks
  the obvious names.
- **The strobe's two washes stay on fixed beats 820ms apart and reduced motion refuses
  the whole effect** — a test enforces both. The beats are the photosensitivity budget;
  putting the washes on the random schedule spends it blind.
- **Only the Ask Diego? button strobes.** The Actions-menu shuffle is the same function
  without the light show, and Save keeps the white peak — three different moments, three
  different lights.

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
21. [completed] Wombat v1: server (migration, POST, cron facts, roster dot)
22. [completed] Wombat v1: builder tab + crew reveal resolution
23. [completed] Per-game rig palettes + mobile banner legibility
24. [completed] Wombat: tests, lock-flip verify, remote migration, ship
25. [completed] Invite preview endpoint (unauthenticated, no leaks)
26. [completed] Invite UX: named door + land in the crew
27. [completed] Apply the VOICE.md copy pass
28. [completed] Account deletion: DELETE /api/me with re-auth
29. [completed] Live-night presence: who's checking squares
30. [completed] Investigate: add Wombat to group/crew view
31. [completed] Investigate: setlist closer scoring vs song count
32. [completed] Verify crew member view as invited/authenticated user
33. [completed] Strobe effect on Ask Diego press

## Branches

```
main   9cd6f0c   ← production, current, deployed green, 360 tests
```

Nothing is ahead of `main`. Branch from it for the next piece of work.

Merged and deleted recently: `mvp-mobile` (#56), `crew-phase-0-1` (#57), `crew-phase-2`
(#58), `crew-phase-3` (#59), `wombat` (#60), `session-slide` (#61). Everything since
went straight to `main`. Older squash-merge residue is unchanged from the last inventory:
`backup-pre-rewrite`, `bingo-cell-icons`, `cache-policy`, `cloudflare-migration`,
`controls-and-taglines`, `drop-tagline`, `explain-soft-cap`, `first-run-mobile`,
`handoff-current`, `handoff-refresh`, `handoff-social`, `nerd-zone`, `password-reset`,
`play-a-show`, `roadmap-precache`, `scoring-scope`, `show-autoadvance`.
