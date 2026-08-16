// The service worker. Cache only — no push, ever.
//
// "No service worker" was a deliberate rule (reach.md), adopted to rule out push
// notifications and background reach, and that reasoning still stands. This file honours
// it: there is no `push` listener, no `notificationclick`, no subscription, nothing that
// can interrupt anybody. What it adds is the fetch handler Android requires before it will
// offer to install a site, plus a shell that survives a dead connection — a phone in a
// venue with 20,000 people on the same tower is the actual use case, and "the app is just
// white" is the actual failure it prevents.
//
// The caching strategy is deliberately the mirror of web/_headers, because a service
// worker that disagrees with the HTTP cache policy is a second, invisible, and
// contradictory source of truth:
//
//   · index.html and /data/*.json  → NETWORK FIRST. Both change in place. Cache is the
//     fallback for a failed request, never the preference. index.html carries the ?v=
//     stamps that point at every other file, so serving a stale one pins a player to a
//     stale bundle — exactly the bug _headers' no-cache exists to prevent, and it would
//     be far worse here because a service worker can serve it with no network at all.
//
//   · /web/* and /icons/*          → CACHE FIRST. The scripts are content-hashed, so a
//     given URL's bytes can never change; the icons are stable. Safe to serve from cache
//     forever, which is also what makes the offline shell possible.
//
//   · everything else (the API)    → NOT INTERCEPTED AT ALL. A cached POST or a stale
//     /api/me is a category of bug worth refusing outright. The handler returns early.
//
// CACHE bumps on every deploy through the build (see scripts/build-public.js), which is
// what evicts the previous version — a fixed name would serve last week's shell forever.
const CACHE = 'bathtub-__BUILD__';

// Enough to render something with no network at all. Not the data files: an empty app
// that says so beats an app confidently showing last week's setlist as this week's.
const SHELL = ['/', '/icons/icon-192.png'];

self.addEventListener('install', event => {
  // addAll is atomic — one 404 and nothing installs, which is the right failure. skipWaiting
  // so a deploy reaches an open tab on the next load rather than the next browser restart;
  // safe here precisely because index.html is network-first, so an updated worker cannot
  // pin anyone to an old bundle.
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Someone else's origin is someone else's business — phish.in audio in particular, which
  // is streamed under a taping policy and must not be quietly hoarded on a device.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const immutable = url.pathname.startsWith('/web/') || url.pathname.startsWith('/icons/');

  if (immutable) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        // Only a good response is worth keeping. Caching a 404 under a hashed URL would
        // persist it for as long as the cache lives.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Network first: the page and its data.
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/')))
  );
});
