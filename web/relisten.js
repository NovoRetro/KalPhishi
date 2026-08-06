// Listen to a past show, via Relisten.
//
// Relisten is an index; phish.in hosts the audio, and the recordings are fan-taped
// audience sources published under Phish's official taping policy — which permits sharing
// for non-commercial purposes only. Three consequences are deliberate here and should not
// be quietly undone:
//
//   1. This only ever attaches to a show REFERENCE on the Data side. It is not ambient
//      background audio, and it must not appear on, or be bundled with, anything paid.
//   2. Nothing autoplays. Every stream is one deliberate press, which keeps the draw on
//      phish.in's privately funded bandwidth proportional to actual listening — and is
//      required anyway, since browsers block autoplay with sound.
//   3. Credit renders with the player itself, not in a footer someone has to go find.
//      Both sources are named and linked every single time.
//
// No API key, and both the API and the audio send permissive CORS headers, so this is
// plain fetch + <audio> with no dependency and no server involvement.
(function () {
  const API = 'https://api.relisten.net/api/v2/artists/phish/shows/';
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // showdate -> Promise<show|null>. Cached because the track record re-renders the detail
  // card on every arrow-key step, and stepping back to a show already opened should not
  // re-hit the API.
  const cache = new Map();

  function load(showdate) {
    if (!cache.has(showdate)) {
      cache.set(showdate, fetch(API + encodeURIComponent(showdate))
        .then(r => (r.ok ? r.json() : null))
        .then(normalize)
        .catch(() => null));
    }
    return cache.get(showdate);
  }

  // Relisten returns every known source for a date. phish.in carries one recording per
  // show, so the first source is the one they chose — there is no "best" to pick between.
  function normalize(j) {
    if (!j || !Array.isArray(j.sources) || !j.sources.length) return null;
    const tracks = [];
    for (const set of j.sources[0].sets || []) {
      for (const t of set.tracks || []) {
        if (t.mp3_url) tracks.push({ title: t.title, mp3: t.mp3_url, duration: t.duration });
      }
    }
    return tracks.length ? { venue: j.venue && j.venue.name, tracks } : null;
  }

  const mmss = s => {
    if (!s && s !== 0) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s - m * 60)).padStart(2, '0')}`;
  };

  // One element for the whole page: starting a track anywhere has to stop whatever was
  // already playing, and two <audio> tags racing is the usual way that goes wrong.
  let audio = null;
  let onChange = null;
  function player() {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      for (const ev of ['play', 'pause', 'ended', 'error']) {
        audio.addEventListener(ev, () => { if (onChange) onChange(); });
      }
    }
    return audio;
  }

  // host: where the control goes. showdate: ISO. label: what to call the show in the
  // link out. Returns nothing — it renders itself and manages its own state.
  function attach(host, showdate, label) {
    const wrap = el('div', 'rl');
    host.appendChild(wrap);

    const open = el('button', 'rl-open', 'Listen to this show');
    open.title = 'Stream this show from phish.in, via Relisten';
    open.addEventListener('click', () => { open.remove(); expand(); });
    wrap.appendChild(open);

    async function expand() {
      const box = el('div', 'rl-box');
      box.appendChild(el('div', 'rl-status', 'Looking for a recording…'));
      wrap.appendChild(box);

      const show = await load(showdate);
      box.innerHTML = '';

      // Every path renders credit, including the empty one — the link out is useful even
      // when we have no audio, and the attribution is not conditional on success.
      const credit = el('div', 'rl-credit',
        `Audience recording hosted by <a href="https://phish.in/${encodeURIComponent(showdate)}" target="_blank" rel="noopener noreferrer">phish.in</a>, ` +
        `indexed by <a href="https://relisten.net/phish/${encodeURIComponent(showdate)}" target="_blank" rel="noopener noreferrer">Relisten</a>. ` +
        `Shared under Phish's taping policy.`);

      if (!show) {
        box.appendChild(el('div', 'rl-status', 'No recording available for this show.'));
        box.appendChild(credit);
        return;
      }

      const nowPlaying = el('div', 'rl-now');
      box.appendChild(nowPlaying);

      const list = el('div', 'rl-tracks');
      const a = player();

      // Redrawn rather than diffed: the list is one show's tracks, and the alternative is
      // hand-tracking which row was previously current across pause/ended/error.
      function paint() {
        list.innerHTML = '';
        show.tracks.forEach((t, i) => {
          const current = a.src === t.mp3;
          const playing = current && !a.paused && !a.ended;
          const row = el('button', 'rl-track' + (current ? ' current' : ''),
            `<span class="rl-ico">${playing ? '&#9646;&#9646;' : '&#9654;'}</span>` +
            `<span class="rl-title">${esc(t.title)}</span>` +
            `<span class="rl-dur">${mmss(t.duration)}</span>`);
          row.addEventListener('click', () => {
            if (current) { if (playing) a.pause(); else a.play(); return; }
            a.src = t.mp3;
            a.play().catch(() => { nowPlaying.textContent = 'That track would not play.'; });
          });
          list.appendChild(row);
        });
        const cur = show.tracks.find(t => a.src === t.mp3);
        nowPlaying.textContent = cur
          ? (a.paused ? `Paused — ${cur.title}` : `Playing — ${cur.title}`)
          : `${show.tracks.length} tracks${show.venue ? ' · ' + show.venue : ''}`;
      }

      // The shared element outlives this card, so the callback is re-pointed at whichever
      // player is currently on screen rather than accumulating one listener per card.
      onChange = paint;
      box.appendChild(list);
      box.appendChild(credit);
      paint();
    }
  }

  window.KalphishiListen = { attach };
})();
