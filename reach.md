# Reach — the run-up to Dick's

The project's goal is **graded predictions**, and the track record holds one. Dick's is
**Fri 4 – Sun 6 September 2026**, three nights, and it is the best available shot at a burst
of them. Nothing the app can do reaches a tester who does not open it, and there is no mail,
no service worker and no push — deliberately (see `handoff.md`, Next steps item 4).

So the channel is **a person writing in the group chat**. This file is that campaign: the
messages, when to send them, and the one query that aims them.

Everything here is copy-paste. Nothing in it is automated, on purpose.

---

## The aiming query

`GET /api/admin/reach` answers "who has not predicted the next open show", per game.

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" https://kalphishi.kalphishi.workers.dev/api/admin/reach
```

```jsonc
{
  "show":   { "showdate": "2026-09-04", "locked": false, "local": "19:30", "timeZone": "America/Denver" },
  "totals": { "users": 31, "setlist": 12, "bingo": 9, "both": 6, "neither": 16, "neverPlayed": 4 },
  "missing": [ { "handle": "…", "name": "…", "lifetime": 7, "needs": ["setlist"] } ]
}
```

- Defaults to the **next open show**; it rolls to night 2 the moment night 1 locks.
  `?showdate=2026-09-04` overrides, locked dates included — "who missed night one" is a fair
  question on the Saturday morning.
- `missing` is ordered **warmest first**. The top of that list is people who play every show
  and merely haven't got to this one; they convert on a single nudge. `lifetime: 0` at the
  bottom are people who have never played at all and need the intro, not the reminder.
- `needs` is per game, because the two are scored separately and plenty of people only play
  one. Do not @ somebody about bingo when bingo is the one they already saved.
- **Re-read `totals` a few hours after each message.** It is the only way to tell whether one
  worked, and it is the whole reason to send the next one differently.

**Before the first message, mint the invite link with enough uses.** New links default to
**10 uses / 30 days**, which a 30-person chat burns through in an afternoon and then fails
silently for everyone after the tenth. Use `maxUses: 0` (no limit) or a comfortable 50 for a
blast, and check the expiry clears 6 September.

---

## The sequence

Six messages over three weeks. That is deliberately few. Three-times-daily reminders for
twenty days is how a cohort mutes you, and a muted chat is worse than no message at all —
it takes the channel away right before the run that needs it.

| # | When | Purpose |
|---|---|---|
| 1 | now (~20 days out) | Re-introduce. The name changed; most of the app changed. |
| 2 | Fri 28 Aug | The ask, made small. |
| 3 | Fri 4 Sep, morning | Night 1 lock time. First targeted @s. |
| 4 | Sat 5 Sep, morning | **Highest yield** — night 1 is graded, so there are scores. |
| 5 | Sun 6 Sep, morning | Same shape, last chance. |
| 6 | Mon 7 Sep | Close the loop. Buys the next run. |

Messages 4 and 5 are the ones that matter most. Everything before them is asking people to
do something on faith; after night 1 there are real standings, which is a reason to come back
rather than a favour being requested.

---

### 1 — now

> Alright, a proper update on the Phish prediction thing, because it's changed a lot and it
> now has a name that isn't a typo.
>
> **It's called Bathtub Bets.** Same app, same link — the URL still says `kalphishi` and will
> keep saying it, because renaming it would sign every one of you out and break the invite
> links people are holding. Ignore the address bar, basically.
>
> 👉 https://kalphishi.kalphishi.workers.dev
>
> What's new since you last looked:
>
> • **It tells you the odds now.** Every song carries a real probability, not a vibe — fitted
>   against 145 past shows. The honest headline: even the single most likely song on the board
>   plays about **3 nights in 10**. The whole predicted setlist is worth about 3.7 hits. That's
>   the ceiling, and now the app says so instead of pretending otherwise.
> • **Two games, scored separately** — Phish Bingo and Setlist Bets. Play either, play both.
> • **You can fill a card in one tap** (Our Prediction uses the model, Ask Diego? just rolls
>   the dice) and then change whatever you disagree with. A half-filled card still saves.
> • **Listen to any show in the app**, gapless, straight through — pulled from phish.in.
> • First time in, there's a quick five-step intro. Skip it if you like.
>
> **The point of all this is Dick's — 4, 5 and 6 September.** Three nights, and predictions on
> each close at the downbeat, 7:30pm MT. The model has been graded against exactly one real
> show so far, which is not enough for anyone to trust it, including me. Three nights of you
> lot playing fixes that.
>
> Anyone you want to bring in, one link does it — it makes you friends and drops them in the
> group in one go: [INVITE LINK]

---

### 2 — Friday 28 August

> One week to Dick's. 🛁
>
> If you want to be in the standings for it, the whole job is: open it, hit **Our Prediction**,
> change the three songs you disagree with, hit Save. Under a minute.
>
> https://kalphishi.kalphishi.workers.dev
>
> Three nights, three separate cards. You can do all three now — no need to come back Friday.
>
> (You can also just do bingo and ignore the setlist side, or the other way round. They're
> scored separately and nobody's averaging them.)

---

### 3 — Friday 4 September, morning

> **Dick's night one. Predictions lock at 7:30pm MT** — that's 9:30 Eastern, 8:30 Central,
> 6:30 Pacific. After the downbeat nothing can be edited, which is the whole point.
>
> https://kalphishi.kalphishi.workers.dev
>
> If you've not filled one in: Our Prediction fills the card, Save keeps it. Ten seconds.
>
> @… @… @… — you three have played before and aren't in for tonight yet. 👀

*Pull the @ list from `/api/admin/reach` an hour or two before you send this. Take the top of
`missing` — the warm ones. Do not @ the `lifetime: 0` accounts here; they need message 1's
intro, not a countdown they have no context for.*

---

### 4 — Saturday 5 September, morning ⭐

> **Night one is scored.** [WINNER] took it with [N] points. Standings are in each game's
> ⋮ Actions menu → 🏆 Standings.
>
> The model got [N] of its [N] calls, [beat / lost to / matched] the room average. [One real
> detail — the bustout it missed, or the Set 2 closer it nailed.]
>
> https://kalphishi.kalphishi.workers.dev
>
> **Night two locks at 7:30pm MT.** If last night was a write-off, this is a clean slate —
> the two nights score independently.

*This is the message with the highest return in the whole sequence, because it is the first
one that is not a favour being asked. Send it even if the turnout on night 1 was poor —
especially then. Fill the bracketed bits in from the real result; a generic version of this
message is worth much less than a specific one.*

---

### 5 — Sunday 6 September, morning

> Last one. **Night three locks at 7:30pm MT.**
>
> [Current standings top three.] [Whoever can still catch them.]
>
> https://kalphishi.kalphishi.workers.dev
>
> Whatever happens tonight, this weekend roughly [N]×'d the number of graded predictions the
> thing has ever had. Genuinely — thank you. 🙏

---

### 6 — Monday 7 September

> **Dick's, done.** Final standings are in each game's Actions menu.
>
> [Winner, both games.] 🏆
>
> What the weekend actually bought: the model went from **one** graded show to **[N]**. Its
> real hit rate across the three nights was [N]%, against the [N]% the backtest predicted —
> so it's [holding up / running hot / flattering itself]. That comparison did not exist on
> Friday and now it does, because you played.
>
> Next run, [DATE]. Same drill.

*Whatever the numbers say, publish them. The app's whole credibility rests on it reporting
its own results honestly — that is the standard the Nerd Zone and the calibration write-up
already set, and the first time a bad number gets quietly dropped is the moment none of the
good ones mean anything.*

---

## If the Nerd Zone has merged by message 1

Add a bullet:

> • **A "Nerd Zone" tab** if you want to see the workings — every approach the model was
>   tested against, with its real accuracy next to it, including the ones that beat the one
>   that ships.

---

## What this is not

No push notifications, no email, no service worker. Not an oversight — see `handoff.md`,
Next steps item 4 for the full reasoning and for what a later build would need. The short
version: `users.email` has never been verified, mail would be this project's first external
service dependency, and repeat-suppression is a table that does not exist. For thirty people
already in a group chat, a human writing in that chat is a better channel than any of it, and
it works today.

If a real channel does get built later, the thing to get right first is **suppression**, not
delivery.
