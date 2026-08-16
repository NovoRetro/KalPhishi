# Wombat — design doc

**Status: v1 implemented and live** (2026-08-15, same day it was pitched — branch
`wombat`, migration `0009` applied to remote). The builder is the third game tab, the
draft resolves on each crew's page at the lock, and the cron marks played-facts. One
amendment to the sketch below as built: the cron is NOT fully hands-off — it grades
wombat rows as facts (`result.played` per ranked song, score NULL) so the reveal can
tick hits without needing the actual setlist client-side; points and ownership stay
computed per crew at read, exactly as designed. Pitched and parameterized 2026-08-15,
simulated the same evening (`sim-wombat.js`, session scratchpad — promote to `scripts/`
if the numbers need re-deriving). A crew-only third game: NFL draft crossed with
ranked-choice voting, over Phish songs.

Wombat is the first game that is social in its **mechanics** rather than its packaging,
and it is only playable on what shipped today: it needs sealed simultaneous submissions
(the Phase 0 seal), a defined member set to resolve against (crews), and a moment when
every list flips over at once (reveal night). It slots into that machinery with almost
no new server surface.

## The rules (canonical)

1. Wombat is played **inside a crew**. Before the lock, each participating member
   submits an **ordered list of 10 songs** — one list per player per show, global: the
   same list resolves independently inside every crew you belong to.
2. **A song belongs to whoever ranked it highest.** Your #1 Tweezer beats their #2
   Tweezer; they get nothing for it. This is the draft half.
3. **A tie nullifies the tied players only, and the song falls through.** Two #4
   Wolfman's cancel each other — but a third player holding it at #7 inherits it.
   (Revised 2026-08-15, same evening: the original cut killed the song for the whole
   crew, which meant a player could lose a song to a collision they were not part of.
   Under the cascade, negation is only ever self-inflicted.)
   - Precisely: walk each song's claims from best rank downward. A level held by
     exactly one player → they own the song, stop. A level shared by two or more →
     those players are out of the running for this song, continue to the next level.
     All levels tie out → the song is dead for the crew that show.
   - Two properties fall out of the walk order: nobody can be undercut by a collision
     *below* their unique claim (the walk stops before reaching it), and inherited
     songs arrive at the inheritor's own rank — which matters for rule 4.
4. **Your card is your top 5 surviving songs.** Losses and deaths slide your bench
   (ranks 6–10) up — the ranked-choice half. A card can hold fewer than 5 if more than
   five of your ten die or lose; that is the cost of mirroring the consensus (and the
   simulation says it is rare — see below).
5. **Scoring is flat: 1 point per card song the band plays that night**, any set,
   encore included. The exclusivity war is the scoring texture; the arithmetic stays
   readable at a glance.
6. Wombat points are **their own scale**. Setlist points, bingo scores and Wombat never
   merge — house rule, third instance.

### Worked example

P1: `1. Tweezer  2. Ghost  …  4. Wolfman's`
P2: `1. Ghost  2. Tweezer  …  4. Wolfman's`
P3: `…  7. Wolfman's`

- Tweezer → P1 (rank 1 beats rank 2). Ghost → P2 (same, mirrored). The symmetric case
  is the game working: contested chalk splits by conviction.
- Wolfman's → **P3 at rank 7**: the tie at 4 nullifies P1 and P2 against each other,
  and the song cascades to the next unique claim. Note where it lands — rank 7 is on
  P3's bench, so it only reaches their card if at least three of their ranks 1–6 were
  themselves lost or nullified. Inheriting chalk on the bench is a consolation, not a
  jackpot, and the simulation confirms it (see the low-baller row).

## What the simulation says

3,000 five-player crews per row, picks drawn from the model's isotonic play
probabilities (`data/analysis.json` candidates, 120 songs with p > 0.005, ~20.8
expected songs/night), shows simulated as independent Bernoulli(p) — the repo's
documented approximation. "Chalk-lover" ranks by consensus probability; "contrarian"
samples deeper cuts; "low-baller" picks chalk but ranks it bottom-up, betting on
collisions above — the strategy the cascade rule exists to enable. Both tie rules were
measured; the cascade shipped into the rules above, the dead-song variant is kept here
as the record of the road not taken.

| rule | crew makeup | dead/crew | short-card crews | avg pts | zero-pt players | winner |
|---|---|---|---|---|---|---|
| dead | 5 chalk-lovers | 1.38 | 2% | 0.93 | 36% | chalk |
| dead | 3 chalk + 2 contrarian | 1.37 | 2% | 0.94 | 35% | chalk 77% |
| dead | 4 chalk + 1 low-baller | 1.07 | 1% | 0.92 | 36% | low-baller 9% |
| **cascade** | 5 chalk-lovers | 1.26 | 2% | 0.94 | 35% | chalk |
| **cascade** | 3 chalk + 2 contrarian | 1.26 | 2% | 0.94 | 35% | chalk 77% |
| **cascade** | 4 chalk + 1 low-baller | 0.94 | 1% | 0.92 | 36% | low-baller 9% |
| **cascade** | 5 contrarians | 1.19 | 1% | 0.93 | 36% | contrarian |

Five findings:

- **The cascade is statistically almost free** — dead songs 1.38 → 1.26, everything
  else within noise. Its real value is emotional, not numerical: under the cascade a
  player only ever loses a song to a tie THEY are in, never to a collision elsewhere in
  the stack. Negation is self-inflicted by construction. Same game, less feel-bad.
- **Card shrink is a non-problem under either rule.** Average card 5.00, ~2% of crews
  ever see anyone short, worst observed 2. The 10-deep bench absorbs losses; no floor
  rule needed.
- **Low-balling is a real but capped strategy: 9% wins against a 20% fair share.**
  The card-is-top-5-survivors rule is why — inherited chalk arrives on the bench (rank
  6–10) and rarely climbs into the card. The cascade opens the door the dead rule
  welded shut, but rule 4 keeps it from becoming dominant. This is the interaction to
  re-examine if the card ever widens.
- **⚠ Scoring volume is thin under both rules: ~0.9 points per player per night, ~36%
  of players score zero.** Five exclusive songs against a ~21-song night leaves thin
  cards. A third of the crew going home with nothing most nights is the one number that
  threatens the fun. Options, none decided: (a) accept for v1 — Dick's is three nights,
  cumulative framing may carry it; (b) widen the card to top 7 of 10 (re-run the
  low-baller check if so); (c) score the whole surviving list. Option (a) costs nothing
  to try first.
- **Chalk-hunting still wins this crude model** — real humans will collide more and
  less predictably than simulated rankers, which raises both the negation rate and the
  contrarian payoff. Re-measure against real Dick's submissions before tuning anything.

The strategy model is deliberately crude (temperature on p, noisy self-ranking). Treat
the shape as real and the exact percentages as indicative.

## Implementation sketch (when it happens)

- **Submission is an ordinary prediction**: `type: 'wombat'`, payload = ordered slug
  array. The Phase 0 seal then covers Wombat for free — sealed pre-lock, open to
  crewmates at the downbeat, one visibility rule in one place. This is the entire
  reason the global-list decision matters.
- **The one real cost: migration 0009.** `predictions.type` has
  `CHECK (type IN ('setlist','bingo'))`, and SQLite cannot alter a CHECK — widening it
  is a create-new/copy/rename table rebuild. Apply to remote manually BEFORE merging
  dependent code, per house protocol. (A separate `wombat_picks` table would dodge the
  rebuild but would sit outside the seal and need its own visibility rules — rejected
  for the same reason reveal night added no server surface.)
- **Resolution is a pure function** — `lib/wombat.mjs`, `resolve(lists) → {ownerBySlug,
  deadSlugs, cards}` — computed at read time per crew, **never stored**: the same
  global list resolves differently in different crews, so resolution is a property of
  (show, crew), not of any prediction row. The cron never touches it; scoring at the
  recap is `card ∩ played` via the same result data the reveal already reads.
- **UI**: submission needs a builder (the setlist typeahead, reordered by drag — both
  exist); resolution and standings live on the Crew page as reveal-night's fourth act
  (the draft results: who stole what, what died). The tab row stays three-wide — Wombat
  is entered from the room, not the row. Placement TBD.
- Tests: resolver unit tests (pure function, finally one that needs no D1), seal
  coverage for the new type, CHECK-widening migration guard.

## Open questions

- **The zero-point problem** — accept for v1, widen the card, or score the full list?
  (See simulation. Leaning: accept for v1, framed as a three-night cumulative race at
  Dick's, and re-measure with real lists.)
- **Minimum players?** Resolution works at 2 but the game is thin below 3. Gate at 2
  and let crews discover it, or require 3?
- **Non-submitters** simply aren't in that show's Wombat — no forfeit, no ghost cards.
  (Decided by default; noting it.)
- **Does Wombat go in reach.md's messaging** for Dick's, or hold for the tour after?
  Building + migrating + testing before 2026-09-04 is plausible but competes with
  Phase 4's superlatives/presence for the same runway.
