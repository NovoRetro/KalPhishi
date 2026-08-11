// Listen to a past show, or to the best-loved version of a song.
//
// Two upstreams, and they are not interchangeable:
//   · Relisten (api.relisten.net) indexes a whole SHOW by date.
//   · phish.in (api/v2) can rank every performance of one SONG by likes, which is what
//     "highest rated version" means here — a fan vote, not a critic's.
// Either way phish.in hosts the bytes, and the recordings are fan-taped audience sources
// published under Phish's official taping policy, which permits sharing for
// non-commercial purposes only. Three consequences are deliberate and should not be
// quietly undone:
//
//   1. This only ever attaches to a show or song reference on the Data side. It is not
//      ambient background audio, and it must not appear on, or be bundled with, anything
//      paid.
//   2. Nothing starts without a press. A show does play straight through once started —
//      that is how a show is listened to, and advancing is the continuation of a press
//      that already happened rather than a stream begun on the listener's behalf — but it
//      stops at the last track. It never rolls into another show and never loops, so a
//      forgotten tab cannot sit pulling audience recordings all night. Keeping the draw on
//      phish.in's privately funded bandwidth proportional to actual listening is the point;
//      starting silent is also required anyway, since browsers block autoplay with sound.
//   3. Credit renders with the player itself, not in a footer someone has to go find, and
//      names whichever upstreams actually supplied that panel.
//
// No API key on either, and both send permissive CORS headers, so this is plain fetch +
// <audio> with no dependency and no server involvement.
(function () {
  const RELISTEN = 'https://api.relisten.net/api/v2/artists/phish/shows/';
  const RELISTEN_YEARS = 'https://api.relisten.net/api/v2/artists/phish/years';
  const PHISHIN = 'https://phish.in/api/v2/tracks';

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // phish.in lowercases a title and replaces every run of non-alphanumerics with a dash,
  // so an apostrophe becomes a SEPARATOR rather than vanishing: "Wolfman's Brother" is
  // wolfman-s-brother there and wolfmans-brother in our own data. Deriving from the title
  // rather than reusing our slug is what makes these agree — checked against the top 40
  // candidates, where the derived form matched all 40 and our own slug missed one.
  const slugify = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const mmss = s => {
    if (s == null) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')}`;
  };

  // Cached because these panels are re-opened constantly — the track record redraws its
  // detail on every arrow-key step, and a table row can be clicked repeatedly.
  const showCache = new Map();
  const songCache = new Map();

  function loadShow(showdate) {
    if (!showCache.has(showdate)) {
      showCache.set(showdate, fetch(RELISTEN + encodeURIComponent(showdate))
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!j || !Array.isArray(j.sources) || !j.sources.length) return null;
          const tracks = [];
          for (const set of j.sources[0].sets || []) {
            for (const t of set.tracks || []) {
              // Relisten reports seconds.
              if (t.mp3_url) tracks.push({ title: t.title, mp3: t.mp3_url, secs: t.duration });
            }
          }
          return tracks.length ? { venue: j.venue && j.venue.name, tracks } : null;
        })
        .catch(() => null));
    }
    return showCache.get(showdate);
  }

  // The catalogue index: which years exist, and what is in one. Separate caches from
  // showCache because they answer a different question — "what could I listen to" rather
  // than "give me this show" — and a year is fetched at most once per session.
  let yearsPromise = null;
  const yearCache = new Map();

  function loadYears() {
    if (!yearsPromise) {
      yearsPromise = fetch(RELISTEN_YEARS)
        .then(r => (r.ok ? r.json() : []))
        .then(a => (Array.isArray(a) ? a : [])
          .filter(y => y.show_count > 0)
          .map(y => ({ year: String(y.year), shows: y.show_count }))
          .sort((x, y) => y.year.localeCompare(x.year)))
        .catch(() => []);
    }
    return yearsPromise;
  }

  function loadYear(year) {
    const key = String(year);
    if (!yearCache.has(key)) {
      yearCache.set(key, fetch(`${RELISTEN_YEARS}/${encodeURIComponent(key)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(j => ((j && j.shows) || [])
          // A show with no source has nothing to play. Listing it would offer a row that
          // can only ever answer "no recording available".
          .filter(s => s.source_count > 0)
          .map(s => ({
            date: s.display_date,
            venue: (s.venue && s.venue.name) || '',
            location: (s.venue && s.venue.location) || '',
            tour: (s.tour && s.tour.name) || '',
            rating: s.avg_rating,
            soundboard: !!s.has_soundboard_source,
          }))
          // Newest first: this view is overwhelmingly used to reach a recent show.
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)))
        .catch(() => []));
    }
    return yearCache.get(key);
  }

  function loadBest(songName) {
    const slug = slugify(songName);
    if (!songCache.has(slug)) {
      songCache.set(slug, fetch(`${PHISHIN}?song_slug=${encodeURIComponent(slug)}&sort=likes_count:desc&per_page=1`)
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          const t = j && j.tracks && j.tracks[0];
          if (!t || !t.mp3_url) return null;
          return {
            title: t.title,
            mp3: t.mp3_url,
            // phish.in reports MILLISECONDS where Relisten reports seconds. Normalising
            // here rather than at the call site, because the two look identical until a
            // 12-minute Tweezer renders as 12 hours.
            secs: t.duration != null ? t.duration / 1000 : null,
            date: t.show_date,
            venue: t.venue_name,
            location: t.venue_location,
            set: t.set_name,
            likes: t.likes_count,
          };
        })
        .catch(() => null));
    }
    return songCache.get(slug);
  }

  // Two elements, ping-ponging. One plays while the other holds the NEXT track buffered;
  // on `ended` they swap roles and the one that just finished becomes the next preloader.
  //
  // Measured before this existed: a 255ms silence between tracks, and the whole of it was
  // one network round-trip. `preload="none"` means the fetch for track N+1 cannot even
  // start until track N has ended, so the gap is the request, not our code — `advance()`
  // fires in about a millisecond. A single element cannot fix it, because assigning `.src`
  // tears down the buffer it is currently playing from.
  //
  // `active` is the authoritative answer to "which one is playing", and `currentMp3` to
  // "what is playing". Both used to be read off `audio.src`, which was fine with one
  // element and ambiguous with two — and the ambiguity would have landed exactly at the
  // swap, where it is hardest to see. Nothing below derives the current track from a
  // `.src` any more.
  const decks = [];
  let active = 0;
  let currentMp3 = '';
  // What the idle deck has been told to buffer, so the same track is never fetched twice.
  let bufferedMp3 = '';

  // Preload LATE, not at track start. Most listening sessions stop somewhere mid-track, so
  // buffering the next one up front would pull files nobody ever hears — and phish.in pays
  // for those bytes. Being this close to the end is a strong signal somebody is actually
  // listening, which is the same reasoning that put `preload="none"` on the first element.
  const PRELOAD_LEAD_S = 25;

  // Every live panel repaints on every transport event, NOT just the most recent one.
  // Each Data sub-tab keeps its own panel in the DOM once opened, so several are alive at
  // once; a single "current panel" callback meant pressing play in Ranked Songs repainted
  // whichever panel happened to render last, and the row actually pressed never showed as
  // playing. Detached panels prune themselves on the next event rather than needing an
  // explicit teardown, which re-rendering a box into new nodes would otherwise require.
  const painters = new Set();

  // The list the running stream came out of, so `ended` knows what follows. Set only where
  // playback actually starts; a single-track panel leaves a queue of one and therefore has
  // nothing to advance into.
  let queue = [];

  // A show is meant to be listenable the way a show is listened to — straight through,
  // without going back to the tab between songs. Advancing is therefore continuation of a
  // press that already happened, not a new stream started on the listener's behalf.
  //
  // It stops dead at the end of the queue. It does not roll into the next show, and it does
  // not loop: leaving a browser tab quietly pulling audience recordings all night is
  // exactly the sort of draw the "one press" rule exists to keep off phish.in's privately
  // funded bandwidth.
  const nextInQueue = () => {
    const i = queue.findIndex(t => t.mp3 === currentMp3);
    return i >= 0 && i < queue.length - 1 ? queue[i + 1] : null;
  };

  function repaint() {
    for (const p of [...painters]) {
      if (p.node.isConnected) p.paint();
      else painters.delete(p);
    }
  }

  // Emptying a deck aborts any fetch still in flight for it. Worth doing rather than
  // leaving it: a skipped-past preload is bandwidth already half-spent, and there is no
  // reason to keep pulling the rest of a file that is now certainly not going to be played.
  function emptyDeck(d) {
    if (!d || !d.getAttribute('src')) return;
    d.removeAttribute('src');
    d.load();
  }

  function cancelBuffer() {
    bufferedMp3 = '';
    if (decks.length > 1) emptyDeck(decks[1 - active]);
  }

  function advance() {
    const next = nextInQueue();
    if (!next) return;
    const idle = decks.length > 1 ? decks[1 - active] : null;
    // The whole point: if the idle deck is already holding this track, the swap is
    // instant and no request happens here at all.
    if (idle && bufferedMp3 === next.mp3 && idle.getAttribute('src')) {
      const finished = decks[active];
      active = 1 - active;
      bufferedMp3 = '';
      currentMp3 = next.mp3;
      // No status target: whichever panels are live repaint from the transport events, and
      // a failure here leaves the row showing as stopped, which is the truth.
      startPlay(decks[active], () => {});
      // Release the file that just finished. It is the next preloader now, and holding a
      // whole decoded show in memory one track at a time is the slow way to a dead tab.
      emptyDeck(finished);
      return;
    }
    // Nothing buffered — either the track was too short to reach the lead time, or a second
    // element was refused. Same behaviour as before this existed, gap included.
    const a = decks[active];
    a.src = next.mp3;
    currentMp3 = next.mp3;
    startPlay(a, () => {});
  }

  function maybePreload() {
    const a = decks[active];
    // Paused counts as not listening: somebody who stopped mid-track has not asked for the
    // next one, and may never come back to it.
    if (!a || a.paused || !isFinite(a.duration) || a.duration <= 0) return;
    if (a.duration - a.currentTime > PRELOAD_LEAD_S) return;
    const next = nextInQueue();
    if (!next || bufferedMp3 === next.mp3) return;
    const idle = idleDeck();
    if (!idle) return;
    bufferedMp3 = next.mp3;
    idle.preload = 'auto';
    idle.src = next.mp3;
    idle.load();
  }

  function makeDeck() {
    const a = new Audio();
    a.preload = 'none';
    for (const ev of ['play', 'pause', 'ended', 'error']) {
      // Only the deck that is actually playing gets to repaint. The idle one fires `error`
      // routinely — emptying it is how a preload is cancelled — and that must never be
      // drawn as the current track failing.
      a.addEventListener(ev, () => { if (a === decks[active]) repaint(); });
    }
    a.addEventListener('timeupdate', () => { if (a === decks[active]) maybePreload(); });
    // Registered after the repainters, so the row that just finished is drawn as stopped
    // before the next one is drawn as playing.
    a.addEventListener('ended', () => { if (a === decks[active]) advance(); });
    return a;
  }

  function player() {
    if (!decks.length) { decks.push(makeDeck()); active = 0; }
    return decks[active];
  }

  // The second deck is built on first use, not at startup. iOS Safari restricts how many
  // media elements a page may have and largely ignores `preload` on cellular, so this is a
  // desktop-and-Android improvement that must degrade to the old single-element behaviour
  // rather than break where it cannot help.
  function idleDeck() {
    if (!decks.length) player();
    if (decks.length < 2) {
      try { decks.push(makeDeck()); } catch { return null; }
    }
    return decks.length > 1 ? decks[1 - active] : null;
  }

  // The one way playback is allowed to start. Routing every start through here is what
  // keeps `queue` and `audio.src` from disagreeing about which show is running — the bug
  // that would otherwise advance from a track in one panel into a show listed in another.
  function playFrom(list, track, onFail) {
    const a = player();
    queue = list;
    a.src = track.mp3;
    currentMp3 = track.mp3;
    // Whatever was buffered was the continuation of a queue nobody is following any more.
    cancelBuffer();
    startPlay(a, onFail);
  }

  // play() hands back a promise that rejects with AbortError whenever the media is paused,
  // or its source swapped, before playback actually begins — which happens every time
  // somebody starts a track and immediately hits pause or picks another one. Reporting
  // that as a failure told people the recording was broken at the exact moment it was
  // doing what they asked. Only a genuine failure should reach the status line.
  function startPlay(a, onFail) {
    const p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(err => { if (!err || err.name !== 'AbortError') onFail(); });
    }
  }

  function creditFor(showdate, viaRelisten) {
    const phishin = `<a href="https://phish.in/${encodeURIComponent(showdate)}" target="_blank" rel="noopener noreferrer">phish.in</a>`;
    const rl = `<a href="https://relisten.net/phish/${encodeURIComponent(showdate)}" target="_blank" rel="noopener noreferrer">Relisten</a>`;
    return el('div', 'rl-credit',
      `Audience recording hosted by ${phishin}` +
      (viaRelisten ? `, indexed by ${rl}` : '') +
      `. Shared under Phish's taping policy.`);
  }

  // Renders a row per track and repaints on every transport event. Redrawn wholesale
  // rather than diffed: the alternative is hand-tracking which row was current across
  // pause/ended/error, for a list that is at most a few dozen rows.
  function trackList(tracks, statusEl, describe) {
    const list = el('div', 'rl-tracks');
    player();
    function paint() {
      list.innerHTML = '';
      // Read the deck fresh on every paint. Capturing it once was safe with a single
      // element and is a bug with two: after a swap the closure would be describing, and
      // pausing, whichever deck had just finished.
      const a = decks[active];
      tracks.forEach(t => {
        const current = currentMp3 === t.mp3;
        const playing = current && !a.paused && !a.ended;
        const row = el('button', 'rl-track' + (current ? ' current' : ''),
          `<span class="rl-ico">${playing ? '&#9646;&#9646;' : '&#9654;'}</span>` +
          `<span class="rl-title">${esc(t.title)}</span>` +
          `<span class="rl-dur">${mmss(t.secs)}</span>`);
        row.addEventListener('click', () => {
          // Resuming needs the same guard: bare, its rejection on a quick re-pause has
          // nowhere to go and surfaces as an unhandled promise rejection.
          if (current) {
            const live = decks[active];
            if (playing) live.pause();
            else startPlay(live, () => { statusEl.textContent = 'That track would not play.'; });
            return;
          }
          playFrom(tracks, t, () => { statusEl.textContent = 'That track would not play.'; });
        });
        list.appendChild(row);
      });
      const cur = tracks.find(t => currentMp3 === t.mp3);
      statusEl.textContent = cur
        ? (a.paused ? `Paused — ${cur.title}` : `Playing — ${cur.title}`)
        : describe;
    }
    painters.add({ node: list, paint });
    paint();
    return list;
  }

  // Titles come from two different catalogues — ours and whoever labelled the recording —
  // so they agree on the words and not always on the punctuation or casing. Comparing on
  // letters and digits alone is what makes "Wolfman's Brother" match "Wolfmans Brother".
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  // opts.track — title to start playing once the show has loaded.
  // opts.start — start the recording from the top instead.
  // Both are only ever set by a press that asked for exactly this, so it remains one
  // press = one stream, not an autoplay. The press just happened before the fetch it had
  // to wait for.
  async function renderShow(box, showdate, opts = {}) {
    const wantTrack = opts.track;
    box.innerHTML = '';
    box.appendChild(el('div', 'rl-status', 'Looking for a recording…'));
    const show = await loadShow(showdate);
    box.innerHTML = '';
    // Credit renders on every path, including the empty one — the link out is useful even
    // when there is no audio, and attribution is not conditional on success.
    if (!show) {
      box.appendChild(el('div', 'rl-status', 'No recording available for this show.'));
      box.appendChild(creditFor(showdate, true));
      return;
    }
    const status = el('div', 'rl-now');
    box.appendChild(status);
    box.appendChild(trackList(show.tracks, status,
      `${show.tracks.length} tracks${show.venue ? ' · ' + show.venue : ''}`));
    box.appendChild(creditFor(showdate, true));

    if (opts.start && !wantTrack) {
      playFrom(show.tracks, show.tracks[0],
        () => { status.textContent = 'That recording would not play.'; });
      return;
    }

    if (wantTrack) {
      const t = show.tracks.find(x => norm(x.title) === norm(wantTrack));
      if (!t) {
        // A song in our setlist with no matching track: the recording is incomplete, or
        // the two catalogues split or named that segue differently. Say so and leave the
        // rest of the show playable rather than failing the whole panel.
        status.textContent = `${wantTrack} is not in this recording — pick another track.`;
        return;
      }
      playFrom(show.tracks, t, () => { status.textContent = `${t.title} would not play.`; });
    }
  }

  async function renderBest(box, songName) {
    box.innerHTML = '';
    box.appendChild(el('div', 'rl-status', `Finding the best-loved ${songName}…`));
    const best = await loadBest(songName);
    box.innerHTML = '';
    if (!best) {
      box.appendChild(el('div', 'rl-status', `No recording found for ${songName}.`));
      return;
    }
    const where = [best.venue, best.location].filter(Boolean).join(', ');
    box.appendChild(el('div', 'rl-head',
      `<b>${esc(songName)}</b> — highest rated version` +
      (best.likes != null ? ` <span class="rl-likes">${best.likes} likes on phish.in</span>` : '')));
    box.appendChild(el('div', 'rl-sub',
      `${esc(best.date || '')}${where ? ' · ' + esc(where) : ''}${best.set ? ' · ' + esc(best.set) : ''}`));
    const status = el('div', 'rl-now');
    box.appendChild(status);
    box.appendChild(trackList([best], status, 'Ready'));
    // Relisten is not involved in this one — only credit who actually supplied it.
    box.appendChild(creditFor(best.date || '', false));
  }

  // Expand-in-place, for card-shaped hosts with room for it (Track Record, Venue History).
  function attach(host, showdate) {
    const wrap = el('div', 'rl');
    host.appendChild(wrap);
    const open = el('button', 'rl-open', 'Listen to this show');
    open.title = 'Stream this show from phish.in, via Relisten';
    open.addEventListener('click', () => {
      open.remove();
      const box = el('div', 'rl-box');
      wrap.appendChild(box);
      renderShow(box, showdate);
    });
    wrap.appendChild(open);
  }

  // Delegated, for dense hosts where expanding in place would wreck the layout: mark any
  // trigger inside `container` with data-listen-date or data-listen-song and the panel
  // opens once, at the bottom of the container, reused by every trigger in it.
  function bind(container) {
    let panel = null;
    container.addEventListener('click', ev => {
      const t = ev.target.closest('[data-listen-date],[data-listen-song]');
      if (!t || !container.contains(t)) return;
      // Some triggers are real anchors. A modified or middle click means "open the link",
      // so leave it alone and let the browser do exactly that; only the plain click is
      // ours to intercept.
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
      ev.preventDefault();
      if (!panel) {
        panel = el('div', 'rl rl-panel');
        container.appendChild(panel);
      }
      let box = panel.querySelector('.rl-box');
      if (!box) { box = el('div', 'rl-box'); panel.appendChild(box); }
      for (const prev of container.querySelectorAll('.rl-chip.on')) prev.classList.remove('on');
      t.classList.add('on');
      if (t.dataset.listenDate) renderShow(box, t.dataset.listenDate, { track: t.dataset.listenTrack });
      else renderBest(box, t.dataset.listenSong);
    });
  }

  window.KalphishiListen = { attach, bind, slugify, loadYears, loadYear, renderShow };
})();
