# Kalphishi — account & social roadmap

Working plan for the next chunk of work, meant to be chipped away at across sessions.
Each phase ships something usable on its own and is safe to stop after.

Live: https://kalphishi.kalphishi.workers.dev · repo: https://github.com/NovoRetro/KalPhishi

---

## Context

The app is deployed on Cloudflare Workers + D1 and works, but accounts are thin:
you sign in with a **name**, there is no concept of other people beyond a global
leaderboard, and everything account-related is crammed into a row of buttons inside
the Predictor card. The asks:

- A hamburger menu (upper right) as the single home for identity and account actions.
- Sign in with **email + password** instead of name + password.
- Historical predictions (setlist *and* bingo) reachable from that menu.
- Friends: invite, remove, group.
- Change password.
- Mark whether you were **physically at a show**, tracked alongside stats.

---

## Where things stand today

**Identity.** `users.id = slugifyName(name)` — the primary key is derived from the
login name. `predictions.user_id` and `sessions.user_id` both FK to it
([migrations/0001_schema.sql](migrations/0001_schema.sql)).

Production D1 holds a handful of real accounts in three shapes — read the current rows
out of D1 rather than hardcoding them anywhere:

| shape | name | passhash | note |
|---|---|---|---|
| owner | an email address | PBKDF2 | the name is already an email, so the id is that email slugified |
| legacy | a display name | `NULL` | pre-password account; claimable by registering that name |
| public signup | a display name | PBKDF2 | registered through the live site after launch |

That third shape is the one to keep in mind: the site is public and registration is open,
so **the account list grows without warning**. Any auth change has to carry along people
who signed up under name-based login and never gave an address.

**Auth.** PBKDF2-HMAC-SHA-256, 100k iterations, `HttpOnly; Secure` cookie sessions with
SHA-256-hashed tokens ([src/auth.mjs](src/auth.mjs)). 12-char minimum password.

**Routes.** 13 live in [src/worker.mjs](src/worker.mjs): register, login, logout, me,
profile (PUT), profile/:id (GET), predictions (GET/POST), live-check, score/:showdate,
stats/:userId, venue-slice, leaderboard.

**Frontend.** No build step or framework — [web/index.html](web/index.html) is the shell
and inline dashboard script, [web/predictor.js](web/predictor.js) is the signed-in app.
`renderTopBar()` (predictor.js:158) draws the current inline nav: Setlist · PHISH Bingo ·
My History · Profile · Sign out. `renderHistory()` (predictor.js:~470) already lists both
prediction types plus the leaderboard.

**Profile fields.** `displayName, avatar, hometown, favoriteSong, bio` (worker.mjs:16).

---

## Design decisions

These shape several phases, so settle them before Phase 1.

### 1. Three separate identifiers, not one

Today one value is doing three jobs. Split it:

| field | role | exposed? |
|---|---|---|
| `id` | internal PK, FK target | never sent to clients after this change |
| `email` | login credential, unique | only to the owner |
| `handle` | public profile URL + @mentions | yes |

**Why this matters now:** the public profile endpoint is `/api/profile/:id`, and any
account whose name was an email has an id that is that address with its punctuation
swapped for dashes. The URL is therefore a barely-obfuscated email, publicly fetchable,
and anyone clicking a leaderboard row hits it. Adding `handle` fixes that leak.

**Recommended:** keep `id` exactly as-is and add `email` + `handle` alongside. Do **not**
rewrite `users.id` — that means rewriting `predictions.user_id` and `sessions.user_id` too,
and the win is nil once `id` stops being exposed.

### 2. Email sending is a real dependency — avoid it in v1

Anything that *sends* mail (verification, password reset, emailed invites) needs an
external provider. MailChannels' free Workers tier is gone; the realistic options are
Resend, Postmark, or SES — all need signup, a verified sending domain, and SPF/DKIM DNS
records. That is a meaningful detour.

**Recommended for v1:** invite by **shareable link/code**, which the user passes along
themselves however they like. No provider, no DNS, no cost.

Consequences to accept, and say out loud in the UI:
- **Email is unverified** — it is a login handle, not a proof of address.
- **"Forgot password" is impossible.** Change-password-while-signed-in works fine;
  account recovery does not. At friends-scale, recovery is a manual D1 update.

Revisit if the app grows past people you can text.

### 3. Attendance is self-reported

There is no ticket integration and no geofence. A user marking "I was there" is a claim,
not a fact. Fine for the intended use, but do not build anything that treats it as
verified. Allow retroactive marking — people will forget until after the show.

### 4. Friends: symmetric, accept-free in v1

Skip pending/accept state initially. Redeeming someone's invite link creates the
friendship in **both** directions immediately. Simpler schema, simpler UI, and matches how
this will actually get used (people you already know). Add request/approve later only if
strangers start showing up.

---

## Phase 1 — Email authentication ✅ (shipped 2026-08-01)

**Goal:** sign in with email + password; profile loads from that identity.

*Done and deployed. One addition found during rollout: `publicName()` in src/db.mjs —
pre-email accounts can have an email address AS their `name`, and every public shape
(leaderboard, profiles) must route names through it or the address leaks anyway. The
legacy name+password login stays until `users.email` has no NULLs, then delete the
branch in /api/login and the affordance in renderLogin.*

**Schema** — `migrations/0002_email_identity.sql`:
```sql
ALTER TABLE users ADD COLUMN email  TEXT;
ALTER TABLE users ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX idx_users_email  ON users(LOWER(email)) WHERE email  IS NOT NULL;
CREATE UNIQUE INDEX idx_users_handle ON users(LOWER(handle)) WHERE handle IS NOT NULL;
```
Backfill in the same migration, reading the live values out of D1 when you write it: set
the owner row's `email` to the address its id was derived from, and give every row a
`handle` — the legacy account can keep its existing name, and the owner needs one that is
*not* derived from the email, or the leak just moves.

**Backend** ([src/worker.mjs](src/worker.mjs), [src/db.mjs](src/db.mjs)):
- `/api/register` takes `{email, password, displayName}`; normalize email to lowercase
  and trim; validate shape; 409 on duplicate. Generate `id` (random or slug+suffix) and
  `handle` from displayName with a collision suffix.
- `/api/login` takes `{email, password}`; look up by `LOWER(email)`. Keep the response
  identical so the frontend contract barely moves.
- Add `getUserByEmail(env, email)` next to the existing `getUser` in db.mjs.
- `/api/profile/:id` → `/api/profile/:handle`; stop returning `id` from `publicUser()`.
- Keep the timing-safe compare and the generic "wrong email or password" error — do not
  reveal whether an address is registered.

**Carrying existing accounts across the cutover.** Registration is open, so this cannot be
a manual D1 edit against a known list. Decided approach: a **one-time link-email flow**.

- Login accepts either `{email, password}` or, while any row still lacks an email,
  `{name, password}` — the legacy path, verified against the same passhash.
- A session whose user has `email IS NULL` is *linked but incomplete*: `/api/me` reports
  `needsEmail: true`, and the UI prompts for an address before anything else.
- `POST /api/link-email {email}` sets it, subject to the same uniqueness check.
- The passwordless legacy row has no password to verify, so it keeps the existing claim
  path: registering its name sets a password and an email in one step.
- Delete the legacy branch once `SELECT COUNT(*) FROM users WHERE email IS NULL` is 0.

Nobody loses access or data, and no address has to be collected out of band.

**Handles.** Auto-generated at registration from the display name, slugified, with a
numeric suffix on collision — and editable later in Profile. Never derived from the email,
or the leak just moves. Existing rows are backfilled by a script that reads the live rows
rather than a hardcoded list.

**Frontend** ([web/predictor.js](web/predictor.js) `renderLogin`, ~line 107): email field,
`type="email"`, `autocomplete="email"`, plus a smaller "signed up before emails? sign in
with your name" affordance that disappears with the legacy path.

**Done when:** a fresh account registers with an email, signs out, signs back in, and sees
its own predictions; every pre-existing account can still get in and is prompted to add an
address; no endpoint returns an email-derived id.

---

## Phase 2 — Hamburger menu

**Goal:** one home, upper right, for identity and account actions.

**Placement:** into `<header>` at [web/index.html:168](web/index.html:168), floated right
of the `<h1>`. Position `fixed`/`sticky` so it stays reachable on long pages.

**Contents:**
- Signed out → "Sign in" / "Create account"
- Signed in → avatar + display name + stat line (reuse `displayName()`/`avatarOf()`,
  predictor.js:155-156), then: My History · Profile · Friends · Change password · Sign out

**Move, don't duplicate:** the inline nav in `renderTopBar()` (predictor.js:158) shrinks to
just **Setlist · PHISH Bingo** — the two things you actually build. History, Profile and
Sign out move to the menu. Avoid two competing navs.

**Change password:** new `PUT /api/password` taking `{currentPassword, newPassword}`.
Verify current, enforce the 12-char minimum, re-hash, and **delete all other sessions for
that user** so a password change kicks out other devices. Keep the caller signed in.

**Mobile — do not regress the work just done:** drawer/sheet at `max-width: 560px`, not a
dropdown. Needs Esc-to-close, tap-outside-to-close, `aria-expanded` + `aria-controls`, and
focus moved into the panel on open and restored on close. Touch targets ≥44px. Remember
the CSS ordering trap from last session: a phone breakpoint must come **after** the base
rule it overrides — same specificity means source order decides.

**Done when:** every account action is reachable from the menu on both a 375px viewport and
desktop, and the Predictor card shows only the two builders.

---

## Phase 3 — Show attendance

**Goal:** mark "I was at this show", and surface it in stats.

**Schema** — `migrations/0003_attendance.sql`:
```sql
CREATE TABLE attendance (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  showdate TEXT NOT NULL,              -- YYYY-MM-DD
  created  TEXT NOT NULL,
  PRIMARY KEY (user_id, showdate)
);
CREATE INDEX idx_attendance_showdate ON attendance(showdate);
```
Row present = attended. Unmarking deletes the row — no boolean column to keep in sync.

**Backend:** `POST /api/attendance {showdate, attended}` (upsert/delete) and
`GET /api/attendance?user=` . Extend `userStats()` ([src/db.mjs:23](src/db.mjs:23)) with
`showsAttended`, and — the genuinely interesting stat — accuracy split by whether the user
was there:
```sql
AVG(CASE WHEN a.user_id IS NOT NULL THEN p.score END) AS accuracyAtShows,
AVG(CASE WHEN a.user_id IS     NULL THEN p.score END) AS accuracyRemote
```
via `LEFT JOIN attendance a ON a.user_id = p.user_id AND a.showdate = p.showdate`.

**Frontend:** a toggle on the Predictor card near the show date ("🎟 I'm at this show"),
and a column in My History. Allow toggling for past dates.

**Done when:** the toggle round-trips, survives reload, and the split accuracy shows on
the profile.

---

## Phase 4 — Friends via invite links

**Goal:** invite, accept, remove.

**Schema** — `migrations/0004_friends.sql`:
```sql
CREATE TABLE friendships (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created   TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE invites (
  code       TEXT PRIMARY KEY,          -- random, URL-safe
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created    TEXT NOT NULL,
  expires    INTEGER,                   -- epoch ms, NULL = no expiry
  max_uses   INTEGER,                   -- NULL = unlimited
  uses       INTEGER NOT NULL DEFAULT 0
);
```
Write **both** directions into `friendships` on redeem, in one `env.DB.batch()` so a
half-formed friendship can't exist.

**Backend:**
- `POST /api/invites` → `{code, url}`; `GET /api/invites` lists own active codes;
  `DELETE /api/invites/:code` revokes.
- `POST /api/invites/:code/redeem` — reject self-redeem, already-friends, expired,
  and over-max-uses. Increment `uses` in the same batch.
- `GET /api/friends` / `DELETE /api/friends/:handle` (deletes both rows).
- Redeeming while signed out: stash the code, run it after sign-in/registration.

**Frontend:** a Friends panel in the menu — list with remove buttons, plus "Create invite
link" with a copy-to-clipboard control. The link is `/?invite=CODE`.

**Done when:** two accounts can befriend each other end-to-end via a link, and removal is
symmetric.

---

## Phase 5 — Friend groups & scoped leaderboards

**Goal:** the actual payoff — leaderboards among people you know.

**Schema** — `migrations/0005_groups.sql`:
```sql
CREATE TABLE friend_groups (
  id       TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  created  TEXT NOT NULL
);
CREATE TABLE friend_group_members (
  group_id TEXT NOT NULL REFERENCES friend_groups(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
```

**Backend:** CRUD on groups and membership, plus `GET /api/leaderboard?scope=friends` and
`?scope=group:<id>`. Extend rather than replace the existing handler (worker.mjs:207).

**Frontend:** scope selector on the leaderboard (Everyone / Friends / a group), and group
management in the Friends panel.

**Done when:** a group leaderboard ranks only its members, and attendance shows there too
("3 of 5 were at this one").

---

## Open questions

*Settled: build order (email auth first), how existing accounts cross the cutover (one-time
link-email flow), and handle format (auto from display name, editable in Profile). All
three are written into Phase 1 above.*

1. **Group membership** — owner-managed only, or can members add others? Owner-only is
   simpler and probably right for now.
3. **Attendance granularity** — Phish plays multi-night runs at one venue. Keying on
   `showdate` handles that correctly, but confirm there is never more than one show per
   date (festivals?).
4. **Does the global leaderboard stay?** Once friend leaderboards exist, a public
   all-users board may not be wanted. Easy to keep, easy to drop — your call.
5. **Email verification** — deferred per Design Decision 2. Revisit if this goes beyond
   people you can text.

---

## Working notes

- **Deploys run from this machine.** `public/` is assembled at build time from the
  gitignored `data/`, so CI can't build it. `npm run deploy`.
- **Schema changes:** add a file in `migrations/`, then
  `npx wrangler d1 migrations apply kalphishi --local` and, when ready,
  `--remote`. Local D1 state is keyed by `database_id` — changing that id in
  `wrangler.jsonc` silently points local dev at an empty database.
- **Never bulk-delete from `users`/`predictions`.** Production holds real accounts and real
  predictions, and registration is open so the count only grows. Clean up test rows by
  explicit id, as done in the deploy verification — never by truncating a table.
- **Verify at 375px**, not just desktop. Last session's mobile fixes are in
  `web/predictor.js` (Pointer Events drag) and `web/index.html` (phone breakpoint,
  tap tooltips).
- **Cron** `0 13,17,21 * * *` auto-scores past shows; it does not depend on this machine.
