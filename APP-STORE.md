# Shipping Bathtub Bets as an app — readiness review

**Written 2026-08-16.** A review of where the app stands against Apple App Store and
Google Play requirements, what is genuinely blocking, and the order to fix it in. Nothing
here is implemented yet.

**The framing first: none of this lands before Dick's (2026-09-04).** Store review alone
is days-to-weeks, and Google Play's new-developer testing requirement is measured in
calendar weeks. The web app reaches every tester today with zero review friction. Treat
store presence as a post-Dick's project, and do not let it displace `reach.md` — which is
still the single highest-value action available and still has not happened.

---

## The strategy: three tiers, increasing cost

| Tier | What it is | Cost | Verdict |
|---|---|---|---|
| **1. Installable PWA** | Add-to-home-screen, own icon, no browser chrome | ~one session, $0 | **Do this first, regardless.** Most of the felt "it's an app" benefit. |
| **2. Google Play (TWA)** | The PWA wrapped in a Trusted Web Activity via Bubblewrap | $25 one-time + calendar time | Reasonable. Play officially blesses TWA. |
| **3. Apple App Store** | WKWebView wrapper or Capacitor shell | $99/yr + real risk | Hardest. See Guideline 4.2 below. |

Tier 1 is a prerequisite for tier 2, and most of tier 3. It is also the only tier that
pays off immediately, so it is the only one worth doing before the store question is even
settled.

## Hard blockers, verified against the repo today

### 1. No web app manifest, no icons — blocks every tier

There is no `manifest.webmanifest` and no app icon of any size anywhere in the repo (the
only images the app has ever needed were emoji). Both stores and PWA installability need,
at minimum: name, short_name, start_url, display `standalone`, theme/background colors,
and 192px + 512px icons (plus a maskable variant for Android, and `apple-touch-icon` for
iOS).

**This is also a design task, not just a build task** — the app has no logo. It has a
wordmark set in system-ui and a light rig. Something has to become the icon.

### 2. No in-app account deletion — hard Apple rejection

Apple's Guideline 5.1.1(v) requires any app supporting account creation to also support
account deletion *from inside the app*. We have registration and no delete path — I
checked; there is no route and no UI. This is an automatic rejection, and it is the single
most likely thing to bounce a first submission.

Worth building regardless of stores: it is also the right answer to a tester who asks.
The work is a `DELETE /api/me` that cascades (the schema already has
`ON DELETE CASCADE` on predictions, sessions, friendships, group members — so the row
delete does most of it), a confirmation flow, and a note about what is irreversible.

### 3. No privacy policy — required by both stores

Both stores require a reachable privacy policy URL before a listing goes live, and Play
additionally requires the Data safety form. We collect email, a display name, and
predictions. This is a short honest document, not a legal epic, but it has to exist at a
stable URL.

### 4. The `.workers.dev` domain — blocks trust, and now three other things

Play's TWA needs Digital Asset Links at `/.well-known/assetlinks.json` on the domain, and
both stores' reviewers will see the URL. `kalphishi.kalphishi.workers.dev` reads as a
staging URL, and the product is called Bathtub Bets — the name mismatch is its own small
credibility tax.

**The domain is now the shared blocker on three separate things**: passkeys (parked for
exactly this reason — passkeys bind to the domain that mints them), store listings, and
the brand. That makes "settle the domain" the highest-leverage non-code decision on the
board after the reach campaign.

### 5. Apple Guideline 4.2, Minimum Functionality — the real risk

Apple rejects apps that are repackaged websites without native capability. A WKWebView
around the current site is exactly the shape they bounce. Clearing 4.2 usually means at
least one genuine native integration — push notifications being the usual answer, plus
offline behaviour, share-sheet integration, haptics.

This collides head-on with a deliberate architectural decision (no push, no mail, no
service worker, per `reach.md`). See the nuance below — it is smaller than it looks.

## The service-worker nuance — worth reading before re-litigating anything

The "no service worker" rule was adopted to rule out **push notifications and background
reach**, and that reasoning still holds. But a **cache-only service worker is a different
animal**: it makes the app installable, gives it an offline shell, and reintroduces
exactly zero of the push machinery (no VAPID keys, no subscription storage, no
permission prompt, no way to interrupt anybody).

Installability on Android requires a fetch handler. So tier 1 needs a service worker, and
it can be one that only caches the shell — which does not violate the spirit of the
original decision at all. Worth stating explicitly in the handoff so a future session does
not treat "no service worker" as absolute and get stuck.

## Smaller gaps found in the same pass

- **No `theme-color`** — in standalone mode the status bar has no colour to follow, so it
  falls back to white and fights the dark stage. Should be theme-aware.
- **No safe-area handling** — the viewport is plain `width=device-width`. Installed on a
  notched iPhone, content runs under the notch and the home indicator. Needs
  `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on the stage and the fixed ☰
  button, which currently sits at `top: 10px` and would land under the status bar.
- **No `apple-mobile-web-app-*` meta** — iOS add-to-home-screen keeps browser chrome
  without them.
- **No offline state** — the analysis fetch has a catch (good), but a cold offline load is
  a blank page. A TWA shows a system error screen, which Play reviewers do notice.
- **No `<meta name="description">`** — irrelevant to stores, relevant to link previews when
  testers share the URL in a group chat, which is the actual distribution channel.

## Age rating — a risk to manage, not a blocker

The app is called **Bathtub Bets**, has "standings", "points", and a game called Setlist
*Bets*. There is no wagering, no currency, and nothing purchasable — so it is not gambling
by either store's definition. But Apple's rating questionnaire has a "Simulated Gambling"
axis, and a reviewer skimming the metadata sees the word "Bets" repeatedly.

Manage it in the listing copy rather than the product: say plainly, in the description and
the review notes, that it is a free prediction game with no wagering, no purchases, and no
currency of any kind. Do not rename anything — the name is good and the beta knows it.

## Suggested order

1. **Account deletion** — required for Apple, right for testers, independent of everything
   else. Smallest useful piece.
2. **PWA foundation** — manifest, icon set, theme-color, safe-area insets, apple meta,
   cache-only service worker. This is the session that makes it feel like an app.
3. **Settle the domain** — unblocks passkeys, stores, and brand at once.
4. **Privacy policy + a real About/legal surface.**
5. **Google Play via Bubblewrap** — note Play's closed-testing requirement for new personal
   developer accounts (12 testers, 14 continuous days, before production access). **The
   ~30-person beta is exactly the right size for this**, so starting the clock early is
   free — but verify the current rule text, it has changed more than once.
6. **Apple, last**, once there is something native enough to clear 4.2 — most likely push,
   which is a real re-opening of the reach decision and should be decided on its own terms.
