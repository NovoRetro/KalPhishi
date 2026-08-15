# Review — `handoff.md` (Bathtub Bets / Kalphishi), 2026-08-15

## 1. Verdict

**Trustworthy, with a defined stale layer.** 203 claims were independently verified as accurate against the repo, 22 survived adversarial challenge as genuine discrepancies, and 26 further findings were refuted on challenge (i.e. the doc was right and the auditor was wrong). That is roughly a **90% verified-accurate rate**, and the accurate portion is unusually load-bearing: every one of the nine arm-table rows, all four diagnostics blocks, every era-lens figure, all 25 Key-files paths, and the 294-test claim reproduce exactly against `data/arms.json`, `data/eras.json` and a live `npm test` run. The errors are not scattered — they cluster in three places: (a) a **45-line pre-build planning block** at `handoff.md:286-331` that was carried forward byte-for-byte and now contradicts the shipped code above it, (b) **cross-references broken by the Next-steps renumbering**, and (c) a handful of **numbers computed in-session with no script behind them**. A fresh session that reads this doc will get the architecture, the model, the platform and the traps right. It will get burned in exactly three places (below), all fixable in under an hour.

---

## 2. Must fix

Ordered by how badly a fresh session would be misled.

### 2.1 The `--tune` reproduce command now prints the opposite verdict (`handoff.md:123-125`)

The doc says the day curve was confirmed on held-out data (+2.57pp, se 0.83, z 3.08) and tells you to reproduce with `npm run backtest -- --tune`. Running it today prints `+0.41pp  se 0.64  z 0.63 … NOT CONFIRMED — inside noise on held-out data`. A reader following the instruction concludes the day curve was never confirmed.

Cause: `scripts/backtest.js:570-571` pins the held-out comparison to `s.arms.model.r`, and the `model` arm is now the *shipping* model, which already carries `DAY_CURVE_K = 5` (`lib/model.mjs:22`). The historical numbers are truthful — the pre-day-curve baseline survives as `modelShowGap` (`scripts/backtest.js:262`, `recency: 'shows'`), whose held-out recall over the 78 post-2024 shows is 24.66% vs 27.2%, matching the ~2.5pp preserved at `lib/model.mjs:17-21`.

> **Day-repeat curve** replaced the show-gap recency term. Recall 25.0% → 27.7%. `k` chosen on shows through 2024 by the one-standard-error rule, confirmed on 78 held-out shows against the pre-day-curve baseline (+2.57pp, se 0.83, z 3.08). **`npm run backtest -- --tune` no longer reproduces this** — `scripts/backtest.js:570-571` compares against `s.arms.model.r`, which now *is* the day-curve model, so it prints +0.41pp / z 0.63 / NOT CONFIRMED. The correct comparison arm is `modelShowGap`, the way `--tune-dueness` deliberately compares against `modelTopN` (`scripts/backtest.js:613-616`).

Fix the same stale pointer at `lib/model.mjs:21`, which repeats "Reproduce with: npm run backtest -- --tune".

### 2.2 `npm run analyze` does not touch `data/history.json` (`handoff.md:559-561`)

`npm run analyze` is a bare `node scripts/analyze.js` with no chaining and no `postanalyze` hook. `analyze.js` requires only `fs` and `path` (lines 1-2), has no `child_process`, and contains zero references to `history.json` across its 445 lines. The only writer is `scripts/build-history.js:66-67`, reachable via `build:history`, `build`, or `build:ci` — the last of which this same doc tells you to run before every browser check. Current timestamps prove they are separate runs: `archive/2026-09-04.json` is `2026-08-04T10:51:07Z`, `history.json` is `2026-08-15T04:25:55Z`, eleven days apart.

> **`npm run analyze` bumps the `generated` timestamp inside `data/archive/*.json`** even when the content is identical (`scripts/analyze.js:368, 425`). The archive is the record of what was published *before* a show — restore it rather than committing a date that misrepresents that. **`data/history.json` churns for a different reason**: it is written by `scripts/build-history.js:66-67` under `build:history` / `build` / `build:ci`, so every rebuild re-stamps it. Same advice, different culprit.

### 2.3 The "Open: which mechanism" block is answered 70 lines above itself (`handoff.md:301, 323-331`)

`handoff.md:286-331` is byte-for-byte identical to the previous handoff's lines 250-295 (`git show 2952084^:handoff.md` diffs to nothing). Under a section headed `### Era what-if lenses — BUILT`, a fresh session reading top-to-bottom is told the work is finished, then handed live-sounding planning text:

- **Line 323, "Open: which mechanism"** — closed. Candidate one shipped: `lib/model.mjs:301-315` computes `adj: eraK * (logRate(s) - mean)`, applied at `:378`, with `ERA_K = 3` at `:49` and a declared-not-tuned rationale at `:38-48`. The pool was not widened (`lib/model.mjs:285` unchanged). The doc already says this at line 252.
- **Lines 329-331, "Expect era arms to score BELOW the shipping model"** — falsified, in the doc's own table. `data/arms.json`: era 3.0 = 29.17%, era 2.0 = 27.90%, both **above** shipping `model` at 27.69%; only era 1.0 (25.13%) is below. The framing problem that actually occurred is the inverse and is documented at `handoff.md:274-277`: era 3.0 *looks* like a win but the control matches it at −0.02pp.
- **Line 306-309, "an arm built on raw prevalence would make 2.0 the loudest and noisiest"** — the shipped arm *is* built on raw prevalence (`lib/model.mjs:307` logs `table.rates[...]`, filled by `scripts/build-eras.js` as `(dates.size + 0.5) / (n + 1)`), and **1.0** came out loudest: sd 2.63 / 1.37 / 1.51 (`lib/model.mjs:46`), 6.45 / 4.85 / 3.19 songs moved (`lib/model.mjs:44`), −3.36pp z −4.65 vs 2.0's −0.60pp z −0.94. `lib/shrinkage.mjs` was never applied to eras; add-half smoothing tied to each era's own *n* did the damping.
- **Line 288-290, "the extra files are inert until something asks for them"** — the first clause is still right (`scripts/backtest.js:138` hardcodes `[2022…2026]`), the conclusion is not. `scripts/build-eras.js:48-64` walks 1983→2021 and writes the git-tracked `data/eras.json`, consumed at `scripts/analyze.js:164` and `scripts/backtest.js:113`.

**Delete lines 301 and 323-331 outright.** Keep 286-299 and 315-321 — the era definition table matches `data/eras.json` exactly and the boundary-handling paragraph is still correct — but rewrite the inert-files sentence:

> The model still reads only 2022+ (`scripts/backtest.js` hardcodes the year list), but the pre-2022 files are no longer inert: `scripts/build-eras.js` reads 1983–2021 to produce the committed `data/eras.json` the era lenses run on. The raw setlists stay gitignored; only `eras.json` travels with the repo.

### 2.4 Four live cross-references point at the wrong section (`reach.md:6`, `reach.md:201-202`, `src/worker.mjs:804`, `test/reach.test.mjs:82`)

All four cite "handoff.md, Next steps item 4" for the no-mail/no-service-worker/no-push reasoning. Item 4 is now `### 4. Monte Carlo odds — closed, with a number` (`handoff.md:389`). The pointers were correct at commit `f232631`; commit `2952084` rewrote Next steps and left them dangling.

Worse than a broken link: `reach.md:201-202` promises the target holds "the full reasoning and for what a later build would need," and that content was **deleted, not moved**. Grepping current `handoff.md` for VAPID, PushManager, suppress, MailChannels, manifest, Home Screen returns zero hits. All that survives in the handoff is the bare clause at line 42. (`reach.md:203-210` independently keeps a compressed version, so it is not lost from the repo.)

Fix: repoint all four at `handoff.md` Current goal, or restore the rationale under a stable anchor. Note that commit `2952084` itself added the Gotchas rule about grepping prose when a test's invariant changes — the rule its own renumbering violated.

### 2.5 The reach campaign's highest-priority action requires manual splicing (`reach.md:189-195`)

`handoff.md:335` says "Send message 1. Before anything else… Everything below is worth less than this." But `reach.md:189-195` still carries an unresolved conditional — "## If the Nerd Zone has merged by message 1 — Add a bullet:" — and message 1's feature list (`reach.md:81-91`) does not contain it. The condition resolved three PRs ago: Nerd Zone is `DATA_TABS[5]` at `web/index.html:2764`, merged in `3c92d80` (#51), `8927d1a` (#52), `c6c4265` (#53), all before `2952084` (#55). `handoff.md:66` says "The Nerd Zone shipped." `reach.md:183` already treats it as an existing standard-setter.

Fix in `reach.md`: paste the bullet into message 1's list and delete the conditional section.

---

## 3. Should fix

Time-wasters, not misleaders.

| Where | What | Correction |
|---|---|---|
| `handoff.md:19-25` | Status block is one PR stale in its own terms — says five PRs (#50-#54) and `main daffbb9`, but #55 (`2952084`) is the tip of local and origin main. Same for the Branches code block at :628. | `main` is at `2952084`; six PRs merged since the last version. |
| `handoff.md:637-641` | Branch map omits two surviving local branches. 18 local branches; the doc accounts for 16. Missing: `explain-soft-cap` (1bc86d0, never named anywhere in the doc) and `handoff-current` (21c082d). | Add both to the local-only list. Note `explain-soft-cap` is fully patch-contained in main (`git cherry main explain-soft-cap` → 0) and safe to delete outright — a cleaner statement than the one made about `nerd-zone`. |
| `handoff.md:634` | `handoff-current` is described as folded into #52. It survives locally with two commits not in main (`21c082d`, `0d5c4de`), and `git branch --no-merged main` lists it. Content is superseded, so no risk — but a future session running `git branch` finds it unaccounted for. | Add to the leftovers list, noting origin's copy is gone. |
| `handoff.md:480` and `:590-591` | "Fires on push to `main` only." `.github/workflows/deploy.yml:6-9` has two triggers: `push: branches: [main]` **and** `workflow_dispatch`, which the file's own comment (:3-5) calls "the escape hatch for redeploying after a data refresh." The manual deploy path appears nowhere in the handoff. | "Fires on push to `main`, plus manual `workflow_dispatch` from the Actions tab (the redeploy escape hatch) — no `pull_request` trigger, so branches and PRs get no checks." |
| `handoff.md:143` | "scraped at build time" — `scripts/fetch-showtimes.js` runs only under `npm run fetch` (package.json:7) or `fetch:showtimes` (:22). Not `build`, not `build:ci`, not `deploy`, not CI. What build does is bundle the committed `src/showtimes.generated.mjs`. Consequence the wording hides: **rebuilding does not refresh lock times**. | "scraped at data-refresh time, bundled at build time, enforced server-side (423)." |
| `handoff.md:562-564` | Four arms are measured-but-unpublished, not three. `modelLogFreqTopN` is missing — graded at `scripts/backtest.js:348`, printed at `:479`/`:495`, excluded at `:766-767` under its own comment at `:764-765`. It is the one a reader hits, since it is named in every `vsControl` block (`arms.json:177, 225, 273`). The doc gets this right at :277. | Add `modelLogFreqTopN` to the list. |
| `handoff.md:478` | `data/arms.json` row omits `vsControl`, which `handoff.md:115` calls a reason the file exists and which carries the doc's most emphasized caveat (era 3.0 vs control = −0.02pp). | "plus `vsNearest`, `vsControl`, `byYear`, and `diagnostics`." |
| `handoff.md:230, 239` | Six top-level collapsible sections, not seven — `makeSection` at `web/index.html:2201, 2228, 2284` (nested, `nz-sec-nested`), and four diagnostics at `:2478, 2508, 2520, 2555`. "3–7" allocates five slots to four diagnostics. | Either "Six collapsible sections … 3–6. The four diagnostics" (counting the scoreboard inside section 2, as :237-238 already does), or "Seven collapsibles … 4–7." |
| `handoff.md:520-523` | "A test now asserts no user-facing copy instructs a shell command." `test/assets.test.mjs:29-41` scans only `web/index.html`. `web/predictor.js` and `web/relisten.js` are read into the same test file (lines 15, 17) but never scanned, and they do carry user-facing copy (`relisten.js:356, 392, 447`; `predictor.js:1546, 1635`). Clean today by accident, not enforcement. | "A test asserts `web/index.html` carries no shell command in user-facing copy." Or extend the assertion to `predictor` and `relisten` — that is the better fix. |
| `handoff.md:287` | "79MB" — the 44 files total 75,964,510 bytes = 76.0 MB (`du -ch` says 73M). The figure looks inherited from `.gitignore:36`, which attaches ~79MB to the 1983-2021 subset (actually 66.7 MB). 79 is likely a whole-`data/` measurement (78.59 MiB). Count and coverage are exactly right. | 76MB. Fix `.gitignore:36` to ~67MB while you're there. |
| `handoff.md:421-423` | Three of six festival multipliers are wrong in the first decimal. Under the pipeline that reproduces every other cell of the table exactly (27/1931 shows, 266/935 songs, 27.6/20.1 mean): `scents-and-subtle-sounds` 5.80, `when-the-circus-comes` 5.73, `meatstick` 5.51, `water-in-the-sky` 4.22, `boogie-on-reggae-woman` 3.70, `punch-you-in-the-eye` 3.35. The list is also headed "Most over-represented" but is not sorted descending — that non-monotonicity is the tell. Secondary: the prose says "against their regular rate" but the denominator is the all-shows rate (a true regular denominator gives 6.13/5.88/6.22/4.41/3.85/3.47, matching none). | Use the six values above in descending order, and say "against their all-shows rate." |
| `handoff.md:294-298` | The ρ column is not reproducible. No script in the repo computes a rank correlation, none ever did in git history, and `handoff.md` is the only file containing the strings 0.551/0.699/0.785. Reconstructing with the repo's own conventions gives 0.532 / 0.679 / 0.778 — a 56-variant sweep found nothing landing on the published trio. Every *other* cell in that table verifies exactly, including the unstored 4.0 row (250 shows / 366 songs recomputes precisely). | Restate as ~0.53 / 0.68 / 0.78, or commit the script. The qualitative claims survive either way: still 0.53–0.78, still nowhere near 1, still monotone in distance. `handoff.md:419`'s festival Spearman of 0.747 is the same genre of number — it *does* reproduce (0.74709 under naive ordinal ranking), but only because I could infer the method. |

---

## 4. Gaps

Things a fresh session needs and cannot find here.

**Numbers with no derivation anywhere.** Three sets exist only as prose in this file:
- **Bingo simulation** (`handoff.md:490`): "89.6% of shows saw no bingo among 20 simulated cards" and "~8% even with an optimal card." `git log --all -S "89.6"` returns one commit, `92a5078`, which touched only `handoff.md`. No script ever existed; `scripts/score-users.js` (deleted in `fc709e5`) contains no simulation. Neither "optimal card" nor the sampling method is defined. `lib/scoring.mjs:191-211` recovers the *geometry* (24 cells, free centre at 12, 12 lines) but not the inputs. **This one is genuinely lost if the handoff is discarded.**
- **Monte Carlo** (`handoff.md:391-398`) and **festival stats** (`handoff.md:411-425`): I reproduced both, but only by inferring undocumented definitions — candidates = songs in ≥3 of 160 cached shows (the one threshold yielding 249 songs → 30,876 pairs), mean songs/show counts rows not distinct songs, all-shows denominator. Item 4's promise that this "does not need rediscovering" is one context reset from being false. A ~40-line script under `scripts/` would make it true.
- **The festival venue list** (`handoff.md:423-425`) exists nowhere in code. `lib/tourleg.mjs`'s `RESET_VENUE_RE` covers only Watkins Glen and The Woodlands; the other six venues appear in no file. The "curated venue list" the section says is required does not exist in any pickup-able form.

**Files the Key files table should carry.** `lib/tourleg.mjs` (named twice in the body as the anchor for Next-steps 5), `scripts/build-eras.js` (cited at :268; its header is where the whole no-4.0 leakage argument lives), `data/eras.json` (committed, not published, baked into analysis.json — the exact arrangement that earned `arms.json` and `calibration.json` their rows), `web/reorder.js` (one of three publish-allowlisted, content-hash-stamped scripts), `migrations/` (manual application is a release blocker per Gotchas), and `test/` (18 files; five are named in prose as invariant guards with no pointer to where they live). Also unmentioned anywhere: `lib/phishnet-core.mjs` and `src/phishnet.mjs`.

**No route to regenerating `data/eras.json`.** `scripts/build-eras.js` has no npm script and no table row; grep is the only way to find it.

**`build` vs `build:ci`.** The doc only ever names `build:ci` (`:572, :574`). `package.json:16` vs `:21` — `build:ci` skips `build:songmeta`, which needs the gitignored raw setlists. A session on a populated machine will silently skip songmeta regeneration.

**Stale remote-tracking refs.** `git branch -a` is actively misleading here: `origin/reach-targeting`, `origin/nerd-zone-*` and ~40 other dead `origin/*` refs still appear even though `git ls-remote --heads origin` proves they are gone. The Branches section should say `git fetch --prune` or "trust `ls-remote`."

**Not verifiable from the repo at all** (state this as such rather than asserting it): whether a human has sent message 1; whether the invite link is minted with `maxUses: 0`; whether `0008_invite_groups.sql` is applied to remote D1; whether the live Worker serves `2952084` and is green; the "~30 testers" and "six legacy graded predictions" counts (both remote D1); the 0ms gapless measurement (`handoff.md:211` — the 255ms baseline is in `web/relisten.js:151-155`, but nothing records the 0ms result); and every rendered-pixel figure (45,175px→2,700px, 2886px→1650px, 498px/1179px/1143px, 282px in a 290px row).

**Small omissions worth a clause each.** The setlist encore is scored by *membership*, not index (`lib/scoring.mjs:71, 125-127`), unlike sets 1 and 2 — "+2 per encore song" reads as parallel to "+2 exact placement" when the rules differ. Closer bonuses require `set.length > 1` (`lib/scoring.mjs:78-80`). `pickLimit` (`src/worker.mjs:44-49`) mints an unlimited link for *any* non-finite or ≤0 value, not just an explicit 0. `PROFILE_FLAGS`/`PROFILE_FIELDS` live in `src/worker.mjs:29-33`, not in either web file. A fifth relisten surface exists — Track Record (`web/index.html:2982`). The "baseline collapses 23.9% → 17.4%" excludes thin years (`web/index.html:2521`, `THIN = 10`) and is not monotone (2024 rebounds to 29.0%). `captured` (31.3%) is `4.98 / meanReachable 15.885` — a restatement of the mean hits, not a second measurement.

**Three stale comments in the code, not the doc**, noticed in passing: `.github/workflows/deploy.yml:20-21` describes a `paths:` filter that does not exist; `web/index.html:2379` cites `test/lenses.test.mjs:168` where the note is actually at `:195` — the exact drifted-line-number failure mode the Key files header warns about; `web/index.html:657` still says "Five sub-tabs" where there are six. And `scripts/analyze.js:333` ships era 1.0's blurb claiming "it is the worst-scoring approach on this page" while `freq` at 12.92% is published and far worse — a live instance of exactly the stale-copy failure the Gotchas section is about.

---

## 5. What is genuinely good

**Do not sand these off.**

- **Every published number reproduces.** All nine arm-table rows (`handoff.md:100-110`) match `data/arms.json` to the digit, including the awkward ones. All four diagnostics rows match. All three era-lens rows match, including `vsNearest` and `vsControl`. The era definition table matches `data/eras.json` byte-for-byte, and the unstored 4.0 row recomputes exactly. 294 tests pass, verified by running them. This is a very high bar and the doc clears it.

- **"Anchors, not line numbers"** (`handoff.md:451-452`) is the right call and it held: all 25 Key-files paths resolve, and every named symbol (`predictNudge`, `nz-picker`, `CK5`, `playFrom`, `NOT_BANNED`, `lockStateFor`…) exists where claimed. The one place a line number crept back in — `web/index.html:2379` citing `lenses.test.mjs:168` — has already drifted, which proves the policy.

- **The doc anticipates its own misreadings and pre-empts them.** "Do not read the what-if rows off the vs baseline column" (`:112-115`) exists precisely because the column misleads for those rows. Multiple challenges against this doc failed because the paragraph two lines below already answered them. The "Older leftovers still around (squash-merge residue, commits unreachable from `main`)" framing at `:637` is another: it is the caveat that makes `git branch --merged` behaviour legible.

- **Recording what was measured and rejected** — shrinkage, Platt, the pool-widening option, the `score > 0` gate correction — is the highest-value content here. The gate correction (`:530-542`) is exemplary: it names the old wrong claim, the measurement that killed it, the direction it *does* bind in, and the two experiments that were shaped around the error.

- **The Gotchas section is disproportionately accurate** — CRLF, the signed GAIN column, `usesCalibration`, the `const sections` snapshot, `let predictor`, touch-drag, the stale-`index.html` stamp diagnostic. Every one verified, several with a passing test behind them. Four separate challenges to this section were refuted.

- **Naming what cannot be verified from the repo** (live 403s, remote D1 state, rendered pixels) rather than pretending. Extending that habit to the ρ column and the bingo simulation would close most of section 4.