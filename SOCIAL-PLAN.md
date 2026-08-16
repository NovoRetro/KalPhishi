# Crew Night — the social UX plan

**Status: Phases 0–3 implemented, plus Phase 4's superlatives** (2026-08-15, #57/#58 merged, Phase 3 on
`crew-phase-3`) — the predictions API is sealed; every member opens the roster and the
Crew page; at the lock the room flips to the reveal (chalk, sole calls, overlap, then
the scored recap) with the SVG share card. Approach labels were renamed for players
along the way (House Model / Straight Ranking / Native Model / Classic Recency). Phase 4
remains a menu to draw from. Written 2026-08-15, after the mobile MVP merge (#56). This is the design for making groups a place rather than a drawer, letting friends
see each other's picks at the right moment, and giving a thirty-person beta something to
talk about between shows. It is written against the code as it stands today; routes and
tables named below were verified against `src/worker.mjs` and `migrations/` on the date
above.

---

## Where it actually stands

Three findings shape everything below, and two of them are good news.

1. **The roster problem is UI-only.** `GET /api/groups/:id/members` is gated on
   *membership*, not ownership (`worker.mjs`, "Membership is the read permission"). Every
   member of a group can already fetch the full roster — handle, display name, avatar,
   owner flag. The reason nobody can *see* it is that the only UI that renders members
   lives inside the owner's "＋ Add" picker. Phase 1 is therefore almost free.

2. **Scoped leaderboards already exist.** `GET /api/leaderboard?scope=group:<id>` works
   today, per game, with membership checked server-side. The Crew page does not need new
   ranking machinery — it needs a room to put the existing boards in.

3. **Picks are not sealed, and they need to be.** `GET /api/predictions?user=<handle>`
   returns full payloads to anyone, signed in or not, *before the lock*. No UI exposes
   it, but anyone who reads the JS can pull a friend's setlist pre-lock and copy it. The
   moment sharing picks becomes a feature, this stops being a curiosity and becomes the
   game's integrity model. Sealing is the one server change that is not optional.

## Design principles

- **The group is the room.** Everything social happens *somewhere* — a destination with a
  name, not a fourth level of a settings drawer. The drawer keeps management (create,
  invite, leave); the room gets everything you look at.
- **Sealed until the downbeat.** Nobody sees anybody's picks until the show locks. This
  is what makes sharing safe, and it is also what makes it fun: the lock becomes an
  event — envelopes open at 19:30 Denver.
- **No free text between users.** Reactions are a fixed set (🍩 first among them), names
  come through the existing sanitizers, and there is no chat. This keeps the moderation
  surface at zero, which is the only size a one-person operation can patrol. The
  `obscenity` filter stays deferred.
- **Derived beats stored.** Rivalry records, streaks, superlatives — all computable from
  predictions already graded. Prefer features that need no new tables and no new writes.
- **Existing constraints hold.** No mail, no push, no service worker (reach.md owns
  outreach); no runtime dependencies; handle-only, never email; setlist points and bingo
  scores never merge.

---

## Phase 0 — Seal the picks *(server, ships silently, before or with Phase 1)*

Tighten `GET /api/predictions`:

- Pre-lock (`lockStateFor` says open): full payload only when the requester **is** the
  predictor. Everyone else gets `{ userHandle, showdate, type, sealed: true }` — the fact
  of a prediction, never its content.
- Post-lock: payload visible to the predictor's **friends and shared-group members**;
  scored summaries stay as public as the leaderboards already make them.
- The route keeps working signed-out for scored/historical shows, which the track record
  reads today.

No migration. One test per visibility rule, plus one asserting the sealed shape carries
no payload key at all — not a nulled one.

## Phase 1 — See your crew *(one session of work)*

The complaint that started this: *"I can't see who is actually in any of my groups."*

- **Roster for every member.** Tapping a group row in the Friends drawer opens the member
  list — avatar, display name, @handle, 👑 on the owner — using the existing members
  route. Owners keep their Add/Remove controls on the same list; members see the same
  list without the controls, plus their own Leave.
- **"In for Friday" dots.** Extend the members response: with `?showdate=`, each member
  row carries `{ setlist: bool, bingo: bool }` for that show — booleans derived
  server-side, no payloads, so nothing conflicts with Phase 0. The roster renders a
  filled dot per game: who has skin in the game before the lock.
- The drawer's group row label changes from `7 members` to `7 members · 4 in for Fri`.

No migration. The dots double as the group-scoped version of what `reach.md` does by
hand: they show who to poke, without the app sending anything.

## Phase 2 — The Crew page *(the room)*

A full destination, opened by tapping a group's name anywhere it appears — the drawer,
the standings scope picker — and reachable from ☰ once signed in.

Layout, phone-first:

```
┌───────────────────────────────┐
│ ← Helping Friendly Crew   👑7 │  name, member count, owner tools behind ⋮
│ "4 of 7 in for Friday"  ████░ │  status strip for the open show
├───────────────────────────────┤
│ [Setlist pts] [Bingo]         │  two boards, two scales, never merged
│ 1. @kim        212            │
│ 2. @robbie     188   you ▲2   │
│ ...                           │
├───────────────────────────────┤
│ THE CREW                      │
│ 🎣 Kim @kim 👑        ●● in   │  roster + per-game dots
│ 🦈 Robbie @robbie     ●○     │
│ 🐟 Pat @pat         sealed 🔒 │
└───────────────────────────────┘
```

- Status strip is the emotional center pre-lock: it counts up as the crew locks in, and
  its copy flips at lock ("Envelopes open — see everyone's calls").
- Owner tools (invite link, add friend, rename, remove) fold behind the same ⋮ pattern
  the games use. Rename needs one new route: `PATCH /api/groups/:id` `{name}`,
  owner-gated, same 40-char sanitized cap as create. No migration.
- The drawer's Groups section shrinks to rows that *link here* plus the create form.

## Phase 3 — Reveal night

The payoff for sealing. Three moments, all on the Crew page, all driven by the lock state
the server already computes:

1. **Before the lock:** members' picks show as sealed chips. Tension, not information.
2. **At the lock**, the page flips to the compare view:
   - **Consensus** — songs half or more of the crew called, with the count ("5 of 7
     called Tweezer").
   - **Sole calls** — "only @pat called Fee." The bragging-rights row.
   - **Your overlap** — per member, how many calls you share.
3. **After scoring** (the cron already grades automatically): the recap — crew average,
   top scorer, biggest sole-call hit, and each member's card one tap away exactly as the
   scored view renders it today.

**Share card:** one tap renders a pure-SVG summary (crew name, show date, top three, one
superlative) and hands it to `navigator.share` / clipboard as an image. No canvas
libraries, no dependencies; SVG-to-PNG via a data-URI image and a 2D context — worth a
spike to confirm on iOS Safari early. This is the piece that pairs with `reach.md`:
the group chat lives off-app by design, so give the chat something worth pasting.

New server surface: none beyond Phase 0's visibility rules — the compare view reads the
same predictions route, post-lock. Consensus/overlap compute client-side from at most
~10 members × 25 calls.

## Phase 4 — The engagement menu *(pick per appetite, any order)*

Each stands alone; none blocks another. Ordered by fun-per-effort as I see it:

| Feature | What it is | Storage |
|---|---|---|
| **Superlatives** — **SHIPPED 2026-08-16** | Five auto-titles after each scored show: *Bustout Prophet* (biggest-gap song that played, 31-show floor), *Lone Wolf* (a hit nobody else called), *Sharpshooter* (best hit rate, five-call floor), *Encore Whisperer* (song placed in the encore), *Chalk Artist* (most consensus calls, needs a crew of 3). Shared on ties rather than tie-broken; all five positive by design. Chips on the recap and the roster, and the headline one rides the share card. | none — derived |
| **Rivalry records** | Head-to-head W-L vs each friend across scored shows, shown on their roster row. "You lead @robbie 4–2." | none — derived |
| **Donut reactions** | One tap on a friend's revealed/scored card: 🍩 ⚡ 🎯 🤡 from a fixed set. Counts only. | one small table (reactor, target user+show+game, emoji, unique per reactor/target) |
| **Streaks** | Consecutive shows predicted, per member; crew participation % per run. | none — derived |
| **Live-night presence** — **SHIPPED 2026-08-16** | "1 of 5 checking squares right now" on the crew page during a locked show, plus a pulse on each present member's roster row. Migration 0010 adds `predictions.live_at`, stamped on every tick; the members route returns a derived `live` boolean (15-minute window) and never the raw timestamp. Polls every 45s, only on a show locked within 24h, skipped while the tab is hidden, and the handle is cleared by `render()` so it cannot leak. | migration 0010 |
| **Who's going** | Surface the attendance flag (`SHOW_ATTENDANCE_TOGGLE`, currently off) as a 🎪 chip on roster rows and the status strip. | exists |

The reactions table is the only migration in the entire plan, and it is deferrable
indefinitely.

## Explicitly not doing

- **Chat, DMs, comments** — free text between users is a moderation surface this project
  deliberately does not have.
- **Push, mail, service worker** — reach stays off-app; the share card is the bridge.
- **Follower/public graphs** — the invite link remains the only way two accounts connect.
- **Merged leaderboards** — two games, two scales, forever.
- **Public crew pages** — rooms are members-only; the share card is what leaves the room.

## Open questions

- Does the Crew page live under ☰ as "Crews", or does "Friends" become the room list?
  (Leaning: one "Friends & Crews" entry; the drawer's management-only life is short.)
- Group avatars/colors — is one emoji per crew (owner-picked, `sanitizeAvatar` already
  exists) worth it for the share card's identity? (Leaning: yes, trivial and fun.)
- Max crew size before the compare view needs pagination? (30-tester beta says ignore
  until it hurts.)
- Should sole-call bragging include *misses* ("only @pat called Fee, and Fee did not
  come")? (Leaning: yes — that is half the fun — but only post-scoring, never at reveal.)
- Consensus threshold: strict majority, or ≥3 in big crews?

## Suggested order

Phase 0 and 1 together are one working session and close the original complaint. Phase 2
is the real build (a new page, entry-point rewiring). Phase 3 is where it becomes a
product moment — target it at a real show weekend so reveal night debuts with an actual
reveal (Dick's, Sep 4–6, is three weeks out). Phase 4 is a menu to draw from whenever a
show weekend needs a new hook.
