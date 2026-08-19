// Bathtub Bets user predictor: setlist builder + PHISH bingo + history.
// Called from index.html: initPredictor(containerEl, analysis)
function initPredictor(mount, A, opts = {}) {
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Date formatting is owned by index.html so both files render dates identically.
  // Resolved at call time (initPredictor runs after that script) and degrades to the raw
  // ISO string rather than throwing if it is somehow absent.
  const fmtDate = iso => (window.fmtDate ? window.fmtDate(iso) : String(iso ?? ''));

  // ---------- approach lens ----------
  //
  // The approach chosen in the Nerd Zone. index.html owns the choice and hands it over as a
  // getter, so there is one source of truth and no second copy to fall out of step.
  //
  // It reaches EXACTLY two things: what Our Prediction offers, and a label saying so. It
  // does not touch saving, scoring, points, standings or the track record — predictions are
  // graded against the real setlist and never against the model, which is the property that
  // makes changing the model safe to expose at all. Nothing about the lens is sent to the
  // server; it is a client-side reading choice.
  const lensKey = () => (typeof opts.lens === 'function' ? opts.lens() : 'model');
  const lensArm = () => (A.lenses?.arms || []).find(a => a.key === lensKey()) || null;
  const lensIsDefault = () => { const a = lensArm(); return !a || !!a.isDefault; };

  // The Actions entry that fills a card from the model, named for what it will ACTUALLY fill
  // from. Left as a fixed "Our Prediction" it was a promise the menu could not keep: with an
  // approach chosen the button hands over that approach's setlist while still calling it ours,
  // and the only warning was a chip on a different row. Always "Our Prediction" at the default,
  // because that is what the house model's answer is called everywhere else in the app.
  //
  // Evaluated per render rather than captured — render() runs on every lens change, because
  // index.html calls predictor.refresh(), so a captured string would freeze on whichever
  // approach happened to be selected when the card was first built.
  const ourPredictionLabel = () => (lensIsDefault() ? '🛟 Our Prediction' : `🛟 ${lensArm().label}`);

  // Baseline rankings ship as bare slugs and can surface a song the model never ranked, so
  // names are resolved from every source that carries them.
  const lensNameBySlug = (() => {
    const m = new Map();
    for (const c of A.candidates || []) m.set(c.slug, c.name);
    for (const t of A.horizontal?.tourSongs || []) if (!m.has(t.slug)) m.set(t.slug, t.name);
    return m;
  })();

  // The candidate order under the current approach.
  function lensRanking() {
    const arm = lensArm();
    if (!arm || arm.isDefault || arm.usesCalibration) return A.candidates || [];
    const r = A.lenses?.rankings?.[arm.key];
    if (!r) return A.candidates || [];
    const bySlug = new Map((A.candidates || []).map(c => [c.slug, c]));
    return r.map(x => {
      const slug = typeof x === 'string' ? x : x.slug;
      return bySlug.get(slug) || { slug, name: lensNameBySlug.get(slug) || slug };
    });
  }

  // The setlist Our Prediction fills from. An approach with no slot logic has no sets to
  // give, so its top 17 are laid into the same 8/7/2 shape the model produces — the order is
  // that approach's own, the shape is only so the three lists have something to hold.
  function lensSetlist() {
    const arm = lensArm();
    if (!arm || arm.isDefault) return A.prediction;
    if (arm.hasSlots && A.lenses?.predictions?.[arm.key]) return A.lenses.predictions[arm.key];
    const flat = lensRanking().slice(0, 17);
    return { set1: flat.slice(0, 8), set2: flat.slice(8, 15), encore: flat.slice(15, 17) };
  }

  const FREE = 12;
  const PHISH = ['P', 'H', 'I', 'S', 'H'];
  // Mirrors of lib/scoring.mjs. The browser cannot import it — the Worker bundles it —
  // so these are duplicated, and test/assets.test.mjs asserts they stay in step. Drift
  // here would show players one set of rules while the server scored them by another.
  const SETLIST_POINTS = { call: 1, callCap: 10, placement: 2, opener: 5, s1closer: 4, s2closer: 5, encoreSong: 2, overCap: 1 };
  const SOFT_CAP = { set1: 10, set2: 10, encore: 5 };

  let songs = [];
  let user = null; // resolved from the session cookie via /api/me
  let mode = 'setlist';
  let showdate = A.nextShow.date;
  // Which crew the crew page is showing. Set by the menu through goToCrew; meaningless
  // in any other mode.
  let crewId = null;
  let crewBoardGame = 'setlist'; // which of the two boards the crew page is on
  let crewRenaming = false;      // owner's inline rename, survives the re-render it triggers
  // Live-night presence polling. One handle, cleared unconditionally at the top of every
  // render() and re-armed only by renderCrew — which is what makes a leak impossible
  // rather than merely unlikely: every path that leaves the crew page goes through
  // render(), and none of them has to remember this exists.
  let livePollTimer = null;
  const stopLivePoll = () => { if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; } };
  // 45s: a show is three hours, squares get ticked between songs, and the presence window
  // is fifteen minutes — polling faster would spend requests to redraw the same dot.
  const LIVE_POLL_MS = 45000;
  // The applied-prediction tag. Set when Our Prediction fills a board under whatever
  // approach is selected, and shown only while the board still IS that prediction —
  // compared against a snapshot on every render, so the first edit takes the tag off
  // without anything having to remember to remove it. The tag is a statement of
  // provenance ("this board is the Native Model's call"), and a board with your own
  // fingerprints on it is yours, not the model's.
  let appliedFill = null; // { mode: 'setlist' | 'bingo' | 'wombat', label, snap }
  const setlistSnap = b => ['set1', 'set2', 'encore'].map(k => b[k].map(s => s.slug).join(',')).join('|');
  const gridSnap = g => g.map(c => (c ? c.slug : '')).join(',');
  const wombatSnap = r => r.map(s => s.slug).join(',');
  const fillLabel = () => lensArm()?.label || 'Our Prediction';
  // Wombat working state. An ordered list IS the whole prediction — rank is array
  // position — so unlike the setlist there is no shape to it beyond the order.
  let wombatRanks = []; // [{slug, name}] in rank order, at most WOMBAT_LIST_SIZE
  let savedWombat = null;
  const WOMBAT_LIST_SIZE = 10;
  const WOMBAT_CARD_SIZE = 5;
  // working state
  let build = { set1: [], set2: [], encore: [] };
  let grid = Array(25).fill(null);
  let locks = Array(25).fill(false); // build-mode only: locked squares survive Randomize
  // Lock mode turns the whole card into a lock picker: a tap on any filled square toggles
  // its lock, instead of that being an 11px icon in the corner of a 60px cell. Opened from
  // Actions, left by the button that replaces Ask Diego? while it is on.
  let lockMode = false;
  let livePrediction = null; // saved bingo prediction being played live
  let savedSetlist = null;   // saved setlist prediction, kept so it can be restored
  let bingoDeclared = false;
  // Bingo square armed for a swap: tap one, tap another, they trade places. Held out here
  // because render() rebuilds the grid and the selection has to survive that.
  let swapFrom = null;
  // Drag is offered to mice only. Dragging a grid cell on touch needs touch-action: none
  // on the cell, which kills page scrolling started anywhere on a grid that fills most of
  // a phone screen — so touch gets tap-then-tap, which costs nothing.
  const COARSE_POINTER = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  // Every show the signed-in user says they attended. Held as a set because the toggle
  // and My History both need "was I at this date?" without a round trip per row.
  let attendedDates = new Set();
  // Which leaderboard the user last chose: 'everyone', 'friends', or 'group:<id>'.
  // Kept outside renderHistory so switching tabs and back doesn't reset it.
  let leaderboardScope = 'everyone';

  let meta = {};
  fetch('/data/songs.json').then(r => r.json()).then(d => {
    songs = d.filter(s => s.artist === 'Phish' || true).map(s => ({ slug: s.slug, name: s.song, plays: s.times_played }));
    songs.sort((a, b) => b.plays - a.plays);
  });
  fetch('/data/songmeta.json').then(r => r.json()).then(d => { meta = d; });
  // Predictions close at the published downbeat. This copy is only for showing the
  // countdown and disabling the controls — the Worker enforces the same instant from a
  // bundled copy, so a stale or edited client cannot save late.
  let showtimes = {};
  fetch('/data/showtimes.json').then(r => r.json()).then(d => { showtimes = d.shows || {}; render(); }).catch(() => {});
  function lockInfo() {
    const s = showtimes[showdate];
    if (!s || !s.lockAt) return { known: false, locked: false };
    const at = Date.parse(s.lockAt);
    return { known: true, locked: Date.now() >= at, at, lockAt: s.lockAt, source: s.source, local: s.local, timeZone: s.timeZone };
  }
  // Short, human countdown — "2d 4h", "3h 12m", "8m". Never seconds: this ticks once a
  // minute and a second-by-second clock would imply a precision the source does not have.
  function untilText(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${m}m`;
  }
  setInterval(() => { if (showtimes[showdate]) render(); }, 60000);

  // bustout tiers by show-gap since last played: 31-39 minor, 40-99 major, 100+ mega
  function bustTier(slug) {
    const gap = meta[slug]?.gap;
    if (gap == null) return null;
    if (gap >= 100) return { cls: 'mega', label: 'MEGA BUSTOUT' };
    if (gap >= 40) return { cls: 'major', label: 'MAJOR BUSTOUT' };
    if (gap > 30) return { cls: 'minor', label: 'MINOR BUSTOUT' };
    return null;
  }
  const bustChip = slug => {
    const t = bustTier(slug);
    return t ? `<span class="p-bust ${t.cls}">${t.label}</span>` : '';
  };

  const api = (path, method, body) =>
    fetch(path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.status); return j; }));

  // ---------- typeahead ----------
  function typeahead(placeholder, usedSlugs, onPick) {
    const wrap = el('div', 'ta-wrap');
    const input = el('input', 'ta-input');
    input.placeholder = placeholder;
    const list = el('div', 'ta-list');
    list.style.display = 'none';
    wrap.appendChild(input);
    wrap.appendChild(list);
    let items = [], sel = -1;

    function render() {
      list.innerHTML = '';
      items.forEach((s, i) => {
        const m = meta[s.slug];
        const row = el('div', 'ta-item' + (i === sel ? ' sel' : ''),
          `${esc(s.name)} ${bustChip(s.slug)}<span class="ta-plays">${s.plays}x${m ? ' · last ' + m.lastPlayed : ''}</span>`);
        row.addEventListener('mousedown', ev => { ev.preventDefault(); pick(s); });
        list.appendChild(row);
      });
      list.style.display = items.length ? '' : 'none';
    }
    function pick(s) {
      input.value = '';
      items = []; sel = -1; render();
      onPick(s);
      input.focus();
    }
    input.addEventListener('input', () => {
      const v = input.value.trim().toLowerCase();
      if (!v) { items = []; render(); return; }
      items = songs
        .filter(s => s.name.toLowerCase().includes(v) && !usedSlugs().has(s.slug))
        .slice(0, 8);
      sel = items.length ? 0 : -1;
      render();
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); render(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); ev.preventDefault(); }
      else if (ev.key === 'Enter' && sel >= 0) { pick(items[sel]); ev.preventDefault(); }
      else if (ev.key === 'Escape') { items = []; render(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { items = []; render(); }, 150));
    return wrap;
  }

  // ---------- root render ----------
  // The header hamburger owns account actions; it reflects whatever state the
  // predictor last rendered.
  // Which game is showing is now the page's decision, not the predictor's — the top-level
  // tabs are Phish Bingo and Setlist Bets. The predictor still owns history and profile,
  // which the account menu reaches directly, so it reports back when it moves to one of
  // those and the page can surface the card whichever tab was selected.
  const notifyMode = () => { if (typeof opts.onModeChange === 'function') opts.onModeChange(mode); };
  // Distinct from authPrompt.onAuthed below — that's the deferred save that survives a
  // sign-in prompted mid-action; this just tells the page "someone arrived."
  const notifySignedIn = () => { if (typeof opts.onSignedIn === 'function') opts.onSignedIn(); };

  const menuActions = {
    goTo(m) { mode = m; actionsOpen = false; render(); notifyMode(); mount.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    // The way into a crew's page — from the drawer's group rows, and from anywhere else a
    // crew's name appears later. Resets the inline rename so one crew's half-typed name
    // never greets the next crew's owner.
    goToCrew(gid) {
      crewId = gid; crewRenaming = false; mode = 'crew'; actionsOpen = false;
      render(); notifyMode(); mount.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    async signOut() {
      await api('/api/logout', 'POST', {});
      user = null; authPrompt = null; attendedDates = new Set();
      render();
    },
    openLogin(tab) { authPrompt = { tab, message: null, onAuthed: null }; render(); },
    // The in-game panels are scoped to the game you are in, so the full reference needs a
    // home that belongs to neither. Handed over as a factory rather than a rendered node:
    // the menu can open and close repeatedly, and the constants are read at build time.
    scoringHelp: () => scoringHelp('all'),
    // A getter, not a value, same reasoning as `lens` at the initPredictor call: the
    // predictor owns which show is open and it can change after the menu is built. The
    // menu uses it to aim the roster's "in for" dots at the show the games are on.
    showdate: () => showdate,
  };

  // When set, sign-in/register renders in the header's modal (window.KalphishiAuthModal)
  // rather than inline: {tab, message, onAuthed}. Saving while signed out sets it with
  // the save as onAuthed, so the draft survives the sign-in and lands on the server
  // without being rebuilt. authPrompt is the single source of truth for whether the
  // modal should be open — every render() call reconciles the modal to match it, so a
  // dismiss via Esc/backdrop (reported through onDismiss, below) just clears this and
  // re-renders rather than needing its own close path.
  let authPrompt = null;
  let pendingAfterAuth = null; // save deferred past the link-email step

  if (window.KalphishiAuthModal) {
    window.KalphishiAuthModal.onDismiss(() => { authPrompt = null; render(); });
  }

  // First-time visitors land on Create account; anyone this browser has seen signed in
  // lands on Sign in. The stored user is the tell — it survives sign-out on purpose (only
  // a dead session clears it), so a tester on their own phone is never pushed toward
  // registering twice, and someone brand new is never asked to sign in to an account they
  // do not have. Wrong guesses cost one tap: both tabs sit at the top of the same panel.
  const probablyHasAccount = () => {
    try { return !!localStorage.getItem('kalphish-user'); } catch { return false; }
  };
  function requireAuth(message, onAuthed) {
    if (user) return onAuthed();
    authPrompt = { tab: probablyHasAccount() ? 'login' : 'register', message, onAuthed };
    render();
  }

  function render() {
    stopLivePoll();
    mount.innerHTML = '';
    if (window.KalphishiMenu) window.KalphishiMenu.update(user, menuActions);
    // Names the game and stops. The tab above says the same thing, and this audience does
    // not need bingo explained to it — the card is titled at all only because the account
    // menu scrolls straight here with the tab bar out of view.
    const HEADINGS = {
      bingo: 'PHISH Bingo',
      setlist: 'Setlist Bets',
      history: 'My history',
      profile: 'Profile',
      // The crew's NAME renders inside renderCrew, where it is data — this static label
      // just says what kind of place you are in.
      crew: 'Crew',
      wombat: 'Wombat',
    };
    // The countdown rides the heading row, pushed right and only as wide as its text.
    // As a full-width banner under the top bar it read as an alert; up here it is a
    // status the eye passes over on the way into the game.
    // p-headrow-game marks the two modes whose name is already in the tab a thumb's width
    // above — CSS hides that h2 on a phone, where a row saying what the row above said is
    // a row of the game's space. History and Profile keep theirs at every width: they are
    // reached from the menu, no tab names them, so the heading is their only label.
    const head = el('div', 'p-headrow'
      + (mode === 'bingo' || mode === 'setlist' || mode === 'wombat' ? ' p-headrow-game' : ''));
    head.appendChild(el('h2', null, HEADINGS[mode] || HEADINGS.setlist));
    // The provenance tag (2026-08-15 direction). It used to name the selected approach
    // whenever one was chosen, whether or not the board had anything to do with it — a
    // statement about a setting, worn by a board. Now it appears only while the board IS
    // that approach's prediction: set by the fill, checked against a snapshot here, and
    // gone the moment an edit deviates — a board with your fingerprints on it is yours,
    // not the model's. Nothing has to remember to remove it; the comparison happens on
    // every render, and re-creating the exact prediction by hand honestly re-earns it.
    if ((mode === 'bingo' || mode === 'setlist' || mode === 'wombat') && appliedFill && appliedFill.mode === mode) {
      const live = mode === 'setlist' ? setlistSnap(build)
        : mode === 'bingo' ? gridSnap(grid) : wombatSnap(wombatRanks);
      if (live === appliedFill.snap) {
        const chip = el('span', 'p-lensnote', `🛟 ${esc(appliedFill.label)}`);
        chip.title = `This board is ${appliedFill.label}’s call, untouched. `
          + 'Change anything and it’s yours.';
        head.appendChild(chip);
      }
    }
    const L = lockInfo();
    // The saved/scored state rides the heading row beside the game's name instead of
    // taking a line of its own above the board. It is a status, not an instruction, and
    // every row above the card is a row between arriving and playing.
    if (mode === 'bingo' && livePrediction) {
      head.appendChild(el('span', 'p-headnote', livePrediction.result
        ? `Scored: ${livePrediction.result.hitCount}/24 squares hit${livePrediction.result.bingo ? ' — BINGO!' : ''}`
        // Squares only become tappable at the lock, so the instruction to tap them only
        // appears then. Before that the useful thing to say is the opposite: it is saved,
        // and it is still yours to change.
        : L.locked
          ? 'Tap ’em as they’re played.'
          : 'Saved. Change it ’til showtime.'));
    }
    if (L.known && (mode === 'setlist' || mode === 'bingo' || mode === 'wombat')) {
      const clock = L.local ? `${L.local} local` : 'showtime';
      head.appendChild(L.locked
        ? el('span', 'p-lock p-locked', `🔒 Locked · started ${esc(clock)}`)
        : el('span', 'p-lock', `🔓 Locks in <b>${untilText(L.at - Date.now())}</b> · ${esc(clock)}`));
    }
    mount.appendChild(head);
    // A reset link outranks everything else on the panel. Whoever is holding one cannot get
    // in any other way, so offering them a sign-in box would be offering the door they
    // already know they cannot open.
    if (resetToken) {
      if (window.KalphishiAuthModal) window.KalphishiAuthModal.hide();
      return renderPasswordReset();
    }
    if (!user && authPrompt) renderAuthPanel();
    else if (window.KalphishiAuthModal) window.KalphishiAuthModal.hide();
    if (user && user.needsEmail) return renderLinkEmail();
    // Signing out of history, profile or a crew drops back to a game, and the page has to
    // hear about it or its tab bar would still be showing neither game selected. Crews are
    // in the list because every crew read needs a session — membership is the permission.
    if (!user && (mode === 'history' || mode === 'profile' || mode === 'crew')) { mode = 'setlist'; notifyMode(); }
    renderTopBar();
    // One or the other, never both: while the intro is up it is already saying what the
    // nudge would say, and stacking two strips above the board is two rows between arriving
    // and playing.
    if (wizardActive()) renderWizard();
    else predictNudge();
    const builderStart = mount.childElementCount;
    if (mode === 'setlist') renderSetlistBuilder();
    else if (mode === 'bingo') renderBingo();
    else if (mode === 'wombat') renderWombatBuilder();
    else if (mode === 'profile') renderProfile();
    else if (mode === 'crew') renderCrew();
    else renderHistory();

    // Once the show starts, everything that edits or re-saves a prediction goes dead.
    // Scoped to the builder rather than the whole panel so the top bar keeps working —
    // people still switch shows and mark attendance after the fact. Bingo cells are divs
    // and so survive this deliberately: tapping squares as songs are played is the point
    // of live mode, and it writes to live_checked, never to the prediction itself.
    if ((mode === 'setlist' || mode === 'bingo' || mode === 'wombat') && lockInfo().locked) {
      const SEL = 'button, input, select, textarea';
      for (let i = builderStart; i < mount.childElementCount; i++) {
        const node = mount.children[i];
        // The node ITSELF has to be considered, not just its descendants — the Save button
        // is appended straight onto the panel, so a querySelectorAll from it finds nothing
        // and it stayed live while everything around it went dead.
        const controls = [...node.querySelectorAll(SEL)];
        if (node.matches(SEL)) controls.push(node);
        for (const c of controls) {
          // p-keep-live opts out: the scoring-rules toggle edits nothing, and a locked
          // show is exactly when someone wants to read how they were scored.
          if (c.classList.contains('p-keep-live')) continue;
          c.disabled = true;
          c.title = 'Locked — the show has started';
        }
      }
    }
  }

  // Pre-email accounts land here after signing in: everything else waits until an
  // address is linked. Goes away once every account has one.
  function renderLinkEmail() {
    const box = el('div', 'p-login');
    mount.appendChild(box);
    box.appendChild(el('div', null, `Welcome back, <b>${esc(displayName(user))}</b>.`));
    box.appendChild(el('div', 'hint',
      'Sign-in is moving to email + password. Add your address to keep using this account — it becomes your login and is never shown to other users.'));
    const email = el('input', 'ta-input'); email.placeholder = 'email address';
    email.type = 'email'; email.autocomplete = 'email';
    const err = el('div', 'p-flash err');
    const btn = el('button', 'p-btn', 'Link email');
    async function go() {
      err.textContent = '';
      try {
        const j = await api('/api/link-email', 'POST', { email: email.value });
        user = j.user;
        const after = pendingAfterAuth;
        pendingAfterAuth = null;
        if (after) await after();
        render();
      } catch (e) { err.textContent = e.message; }
    }
    btn.addEventListener('click', go);
    email.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
    const row = el('div', 'p-row');
    row.appendChild(email); row.appendChild(btn);
    box.appendChild(row);
    box.appendChild(err);
  }

  // Builds the sign-in/register form and hands it to the header's modal (a fixed
  // overlay, not part of the page's normal scroll flow) rather than appending inline.
  function renderAuthPanel() {
    let tab = authPrompt.tab || 'login';
    let legacy = false; // sign in with a pre-email account name
    const box = el('div', 'p-login card');
    function draw() {
      box.innerHTML = '';
      if (authPrompt.message) box.appendChild(el('div', null, `<b>${esc(authPrompt.message)}</b>`));
      const tabs = el('div', 'p-modes');
      for (const [key, label] of [['login', 'Sign in'], ['register', 'Create account']]) {
        const b = el('button', 'p-mode' + (tab === key ? ' active' : ''), label);
        b.addEventListener('click', () => { tab = key; draw(); });
        tabs.appendChild(b);
      }
      const dismiss = el('button', 'p-mode', '✕ close');
      dismiss.addEventListener('click', () => { authPrompt = null; render(); });
      tabs.appendChild(dismiss);
      box.appendChild(tabs);
      // One line each, and register's does not lecture about requirements — the server
      // says exactly what is wrong if a password is short, at the moment it matters.
      box.appendChild(el('div', 'hint', tab === 'login'
        ? 'Welcome back.'
        : 'Email + password. That’s it.'));
      const email = el('input', 'ta-input');
      email.placeholder = legacy ? 'name' : 'email address';
      email.type = legacy ? 'text' : 'email';
      email.autocomplete = legacy ? 'username' : 'email';
      const pass = el('input', 'ta-input'); pass.placeholder = 'password'; pass.type = 'password';
      pass.autocomplete = tab === 'login' ? 'current-password' : 'new-password';
      // Optional, and says so. The server derives a handle either way and falls back to it
      // for the display name, and the name is editable in Profile — asking for it up front
      // was one more field between a new player and the game, for a value most people type
      // twice: once here and once when they change their mind about it.
      const disp = el('input', 'ta-input'); disp.placeholder = 'display name (optional)';
      // Claim-a-legacy-account field: hidden for now (not needed for current testing),
      // but kept so the flow still exists — its value just never leaves ''.
      const claim = el('input', 'ta-input'); claim.placeholder = 'old name to claim (optional)';
      const err = el('div', 'p-flash err');
      const btn = el('button', 'p-btn', tab === 'login' ? 'Sign in' : 'Create account');
      async function go() {
        err.textContent = '';
        try {
          const body = { password: pass.value };
          if (tab === 'login' && legacy) body.name = email.value;
          else body.email = email.value;
          if (tab === 'register') {
            body.displayName = disp.value;
            if (claim.value.trim()) body.claimName = claim.value.trim();
          }
          const j = await api(tab === 'login' ? '/api/login' : '/api/register', 'POST', body);
          user = j.user;
          notifySignedIn();
          const after = authPrompt.onAuthed;
          authPrompt = null;
          // A pre-email account must link an address first; hold the pending save and
          // run it once renderLinkEmail succeeds.
          if (after && user.needsEmail) pendingAfterAuth = after;
          else if (after) await after();
          await loadExisting();
          // An invite that was waiting on sign-in can now be redeemed.
          if (!user.needsEmail) await redeemPendingInvite();
        } catch (e) {
          err.textContent = e.message === 'claimable'
            ? 'This name has no password yet and can’t be claimed from here right now — ask the site owner for help signing in.'
            : e.message;
        }
      }
      btn.addEventListener('click', go);
      for (const inp of [email, pass, disp]) inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
      const row = el('div', 'p-row');
      row.appendChild(email); row.appendChild(pass);
      if (tab === 'register') row.appendChild(disp);
      row.appendChild(btn);
      box.appendChild(row);
      box.appendChild(err);
      if (tab === 'login') {
        // Legacy affordance: dies with the last pre-email account.
        const alt = el('button', 'p-mode', legacy ? 'Sign in with email instead' : 'Signed up before emails? Sign in with your name');
        alt.addEventListener('click', () => { legacy = !legacy; draw(); });
        box.appendChild(alt);
      }
    }
    draw();
    // draw() above mutates `box` in place for tab switches/toggles, so show() only
    // needs to run once — it inserts the node and doesn't need calling again.
    if (window.KalphishiAuthModal) window.KalphishiAuthModal.show(box);
    else mount.appendChild(box); // no-JS-module fallback, shouldn't happen in practice
  }

  const displayName = u => (u.profile && u.profile.displayName) || u.name;
  const avatarOf = u => (u.profile && u.profile.avatar) || '🎣';

  // The rules used to be a paragraph of prose under the builder, which is where nobody
  // reads them. As a table with a worked example they are actually legible, and folding
  // them behind a button keeps the builder itself uncluttered.
  let helpOpen = false;
  // The standings, folded into whichever game you are in. Same shape as helpOpen and for
  // the same reason: it is occasional, it is reference, and it belongs to one game.
  let boardOpen = false;
  // Held out here for the same reason as swapFrom: render() rebuilds the control row, so
  // an open menu has to survive being redrawn.
  let actionsOpen = false;
  // Which set columns are unfolded. Out here so folding survives the render every edit
  // triggers — a fold that re-opened on the next added song would not be a fold. All open
  // by default: folding is for getting past a set, not a state to discover the game in.
  const setOpen = { set1: true, set2: true, encore: true };

  // One button in place of a row of four. Randomize, the model's card, Clear and the
  // rules are all things you reach for occasionally; spread across the row they competed
  // for attention with the one button that matters, which is Save.
  //
  // items: [label, onPick, { keepLive }]. keepLive marks an item that survives the lock —
  // see the sweep in render(). The Actions button itself always survives, or a locked show
  // would put the scoring rules out of reach, which is exactly when they get read.
  function actionsMenu(items) {
    const wrap = el('div', 'p-actions');
    // Both labels are rendered and CSS picks one, rather than a matchMedia read at render
    // time. The tab row does it the other way because its labels have to be measured; here
    // it is pure presentation, and doing it in CSS means there is no breakpoint in JS to
    // drift out of step and nothing to rebuild on rotate. aria-label carries the name in
    // both states, so the glyph form is never an unnamed button.
    const btn = el('button', 'p-btn p-btn-alt p-keep-live p-actions-btn',
      '<span class="p-actions-word">Actions ▾</span><span class="p-actions-dots" aria-hidden="true">⋮</span>');
    btn.setAttribute('aria-label', 'Actions');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', String(actionsOpen));
    // stopPropagation so the close-on-outside-click handler does not immediately undo
    // this — by the time it ran, render() would have detached the element it fired on.
    btn.addEventListener('click', ev => { ev.stopPropagation(); actionsOpen = !actionsOpen; render(); });
    wrap.appendChild(btn);
    if (actionsOpen) {
      const menu = el('div', 'p-actions-menu');
      menu.setAttribute('role', 'menu');
      for (const [label, onPick, o = {}] of items) {
        const b = el('button', 'p-actions-item' + (o.keepLive ? ' p-keep-live' : ''), esc(label));
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', ev => { ev.stopPropagation(); actionsOpen = false; onPick(); });
        menu.appendChild(b);
      }
      wrap.appendChild(menu);
    }
    return wrap;
  }
  // Bound once, not per render: a listener added inside render() would be re-added on
  // every redraw and never removed.
  //
  // Both the Actions menu and the scoring panel dismiss on an outside click. The panel
  // checks the target first, because a click INSIDE it is someone reading — selecting a
  // number out of the table must not close the thing they are reading it from.
  //
  // Everything that opens either of these calls stopPropagation. Without that, the click
  // that opens would bubble to here in the same tick and close it again; and because
  // render() has already replaced the DOM by then, the target would be a detached node
  // whose closest() finds nothing, so it would look like the panel refused to open.
  document.addEventListener('click', ev => {
    let dirty = false;
    if (actionsOpen) { actionsOpen = false; dirty = true; }
    if (helpOpen && !ev.target.closest('.p-help')) { helpOpen = false; dirty = true; }
    // Same exemption as the rules panel: a click inside the board is somebody reading it,
    // and clicking a name to open a profile must not close the thing they clicked from.
    if (boardOpen && !ev.target.closest('.p-board')) { boardOpen = false; dirty = true; }
    if (dirty) render();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!actionsOpen && !helpOpen && !boardOpen) return;
    actionsOpen = false;
    helpOpen = false;
    boardOpen = false;
    render();
  });

  // scope: 'setlist' | 'bingo' | 'all'. Inside a game, the rules for the OTHER game are
  // noise — half the panel described a system the player was not currently using, which is
  // also most of why it grew long enough to scroll past. 'all' is the full reference and is
  // reached from the account menu, where no single game is in view.
  function scoringHelp(scope = 'all') {
    const box = el('div', 'p-help');
    const row = (what, pts) => `<tr><td>${what}</td><td class="num"><b>${pts}</b></td></tr>`;
    // "10 / 10 / 5" is shorthand that only means anything if you already know the rule, so
    // the caps are spelled out. Written from the constants, and the two sets collapse into
    // one phrase only while they actually match.
    const setCap = (SOFT_CAP.set1 === SOFT_CAP.set2
      ? `the first ${SOFT_CAP.set1} songs of a set`
      : `the first ${SOFT_CAP.set1} songs of Set 1 and ${SOFT_CAP.set2} of Set 2`)
      + ` (${SOFT_CAP.encore} in the encore)`;
    const setlistRules = `
      <div class="setlabel">Setlist</div>
      <table><tbody>
        ${row('Any song you call right, anywhere in the show', `1 each, max ${SETLIST_POINTS.callCap}`)}
        ${row('…and it lands in the exact slot you put it in', `+${SETLIST_POINTS.placement}`)}
        ${row('Show opener — first song of Set 1', `+${SETLIST_POINTS.opener}`)}
        ${row('Set 2 opener', `+${SETLIST_POINTS.opener}`)}
        ${row('Set 2 closer', `+${SETLIST_POINTS.s2closer}`)}
        ${row('Set 1 closer', `+${SETLIST_POINTS.s1closer}`)}
        ${row('Each song you correctly place in the encore', `+${SETLIST_POINTS.encoreSong}`)}
        ${row(`Each song that <em>doesn’t</em> get played, beyond ${setCap}`, `−${SETLIST_POINTS.overCap}`)}
      </tbody></table>
      <div class="p-help-note">
        Openers and closers are whatever sits first and last in each list — drag ⋮⋮ to reorder.
      </div>

      <div class="setlabel">How long can my list be?</div>
      <div class="p-help-note">
        <b>There is no maximum.</b> Phish plays long sets, so nothing stops you adding as many
        songs as you like to Set 1, Set 2 or the encore.
        <br><br>
        The first <b>${SOFT_CAP.set1}</b> songs in Set 1, <b>${SOFT_CAP.set2}</b> in Set 2 and
        <b>${SOFT_CAP.encore}</b> in the encore are free: guess wrong there and it simply doesn’t
        score. Every song you add <i>beyond</i> those is a bet — if it gets played it scores
        exactly as normal, and if it doesn’t, it costs you a point.
        <br><br>
        So going long is worth it only for songs you genuinely expect. Nothing is locked in
        either: take the extras back off before the show starts and no deduction applies.
      </div>

      <div class="setlabel">Worked example</div>
      <div class="p-help-note">Set 1 opens <b>Carini</b>, then Bathtub Gin, Meatstick, Blaze On…</div>
      <table><tbody>
        <tr><td>You said <b>Ghost</b> first — not played</td><td class="num">0</td></tr>
        <tr><td><b>Bathtub Gin</b> — called, and in slot 2 where you put it</td><td class="num"><b>3</b></td></tr>
        <tr><td><b>Sand</b> — not played</td><td class="num">0</td></tr>
        <tr><td><b>Meatstick</b> — called, but a slot later than it landed</td><td class="num"><b>1</b></td></tr>
        <tr><td><b>Blaze On</b> — called, also a slot off</td><td class="num"><b>1</b></td></tr>
        <tr><td><b>Total</b></td><td class="num"><b>5</b></td></tr>
      </tbody></table>
      <div class="p-help-note">
        Being one slot out scores the same as being ten out — placement is exact or it is not.
        No opener bonus here: the show opened Carini, not Ghost.
      </div>`;

    const bingoRules = `
      <div class="setlabel">PHISH Bingo</div>
      <table><tbody>
        ${row('Squares you call right', 'up to 80, shared across the 24')}
        ${row('Five in a line — row, column or diagonal', '+20')}
      </tbody></table>
      <div class="p-help-note">The donut in the middle is yours for free and always counts toward a line.</div>`;

    // The closing note only makes the both-scales comparison where both scales are on
    // screen. In a single game it says the one thing that game's player needs.
    const footer = {
      setlist: `<div class="p-help-note">A setlist result is a point total. It locks when the
        show starts, and is never combined with a bingo score.</div>`,
      bingo: `<div class="p-help-note">A bingo result is out of 100. It locks when the show
        starts, and is never combined with setlist points.</div>`,
      all: `<div class="p-help-note">Setlist points and bingo scores are separate scores and
        are never added together or averaged — a setlist result is a point total, a bingo
        result is out of 100. Both lock when the show starts.</div>`,
    }[scope] || '';

    box.innerHTML =
      (scope === 'bingo' ? '' : setlistRules) +
      (scope === 'setlist' ? '' : bingoRules) +
      footer;
    return box;
  }

  // Setlist points and bingo scores are different scales and are never combined. One
  // helper so every place that shows a track record says the same thing the same way.
  function statSummary(s) {
    const out = [];
    if (s.setlistPoints != null) out.push(`${s.setlistPoints} pts/setlist over ${s.setlistScored ?? 0}`);
    if (s.bingoScore != null) out.push(`bingo ${s.bingoScore} over ${s.bingoScored ?? 0}`);
    if (s.bingos) out.push(`${s.bingos} BINGO${s.bingos > 1 ? 's' : ''} 🍩`);
    return out.join(' · ');
  }

  // The only part of the "nudge them before the lock" problem that can be solved from
  // inside the app: somebody who IS here, has not saved for the open show, and has not
  // registered that it closes. It is explicitly NOT a fix for reach — nothing here touches
  // a tester who never opens the page, and the roadmap entry says so in as many words.
  //
  // Two rules keep it from becoming noise. It disappears the moment a prediction exists, so
  // it cannot nag somebody who already did the thing it asks for; and it is dismissible per
  // show AND per game, because plenty of people will only ever play one of the two.
  const nudgeKey = () => `bb-nudge-${mode}-${showdate}`;
  const nudgeDismissed = () => {
    try { return localStorage.getItem(nudgeKey()) === '1'; } catch { return false; }
  };

  function predictNudge() {
    if (!user || (mode !== 'setlist' && mode !== 'bingo')) return;
    // Saved already, or the show has started, or we do not know when it starts.
    if (mode === 'bingo' ? livePrediction : savedSetlist) return;
    const L = lockInfo();
    if (!L.known || L.locked || nudgeDismissed()) return;

    const left = L.at - Date.now();
    // Two tiers, not five. The countdown on the heading row already carries the exact
    // figure, so this only has to distinguish "soon" from "now or never".
    const urgent = left <= 48 * 3600 * 1000;
    const row = el('div', 'p-nudge' + (urgent ? ' p-nudge-urgent' : ''));
    const what = mode === 'bingo' ? 'card' : 'setlist';
    row.appendChild(el('span', null,
      `${urgent ? '⏳ ' : ''}Nothing in for <b>${esc(fmtDate(showdate))}</b>`
      + (urgent ? ` — locks in <b>${esc(untilText(left))}</b>` : '')
      + '. Ask Diego? fills one in a press.'));
    const x = el('button', 'p-nudge-x', '×');
    x.setAttribute('aria-label', 'Dismiss');
    x.title = 'Dismiss for this show';
    x.addEventListener('click', () => {
      try { localStorage.setItem(nudgeKey(), '1'); } catch { /* private mode */ }
      render();
    });
    row.appendChild(x);
    mount.appendChild(row);
  }

  // ---------- first-run wizard ----------
  //
  // Inline above the game, never over it. The landing view opens on the games deliberately,
  // and a dialog in front of that undoes the very thing it is trying to get somebody to do —
  // so this is a card in the flow that skips in one press, not a wall.
  //
  // "Seen" lives in `users.profile`, already a JSON blob with a merge-not-replace PUT, so
  // this needed no migration. Existing testers see it once; it is five steps and a Skip, and
  // they have not seen half of what it describes either.
  //
  // It does NOT fill a card for you at the end, though that was the plan. The fill and save
  // routines are closures inside the builders over `grid`/`build`, and reaching them from
  // here meant either hoisting them or clicking my own buttons by label — coupling the
  // intro to the internals of both games to save one tap. The last step hands off to the
  // pre-lock nudge instead, which renders the moment the wizard clears and says exactly
  // this, with the real button beside it.
  let wizardStep = 0;
  let wizardBusy = false;
  // ---- OFF, deliberately, and everything below it is kept.
  //
  // The intro is a good tool aimed at the wrong moment: it lands on somebody who arrived to
  // fill in a card and puts five steps between them and doing it. Turned off rather than
  // deleted — WIZARD_STEPS, renderWizard, wizardSave and the `wizardSeen` profile flag are
  // all still here and still correct, so this is one line to reverse.
  //
  // It gates at `wizardActive`, the single place anything asks whether the intro is showing,
  // so nothing downstream needs to know. With it false, `render()` falls through to
  // predictNudge() — the either/or at the top of render() — which is the strip that says the
  // useful half of what the intro said, next to the button that acts on it.
  //
  // Note the flag is NOT set when this is off: nobody is marked as having seen an intro they
  // were never shown, so turning it back on shows it to everyone who has not actually had it.
  const WIZARD_ENABLED = false;
  const wizardActive = () =>
    WIZARD_ENABLED
    && !!user && !user.profile?.wizardSeen && (mode === 'setlist' || mode === 'bingo');

  async function wizardSave(patch, after) {
    if (wizardBusy) return;
    wizardBusy = true;
    render();
    try {
      const j = await api('/api/profile', 'PUT', patch);
      user = j.user;
      try { localStorage.setItem('kalphish-user', JSON.stringify(user)); } catch { /* private mode */ }
      if (after) after();
    } catch (e) {
      flash(e.message, true);
    }
    wizardBusy = false;
    render();
  }

  const WIZARD_STEPS = [
    {
      title: 'Welcome to Bathtub Bets',
      // The only step that asks for anything. The rest is telling, and telling is cheap to
      // skip; a name is what every board will show, so it earns one screen.
      build: (body, state) => {
        body.appendChild(el('p', 'p-wiz-copy',
          'Phish have never repeated a setlist. We guess what is coming next, you make your own '
          + 'call, and both get scored against the real show.'));
        const nameLab = el('label', 'p-field', 'display name<br>');
        state.name = el('input', 'ta-input');
        state.name.value = (user.profile && user.profile.displayName) || user.name || '';
        nameLab.appendChild(state.name);
        const avaLab = el('label', 'p-field', 'avatar (an emoji or two)<br>');
        state.avatar = el('input', 'ta-input');
        state.avatar.maxLength = 24;
        state.avatar.value = (user.profile && user.profile.avatar) || '';
        avaLab.appendChild(state.avatar);
        body.appendChild(nameLab);
        body.appendChild(avaLab);
        body.appendChild(el('div', 'p-wiz-note',
          'This is what the standings show. Change it any time from the ☰ menu.'));
      },
    },
    {
      title: 'Two games, scored separately',
      build: body => {
        body.appendChild(el('p', 'p-wiz-copy',
          '<b>Setlist Bets</b> — call the songs you think they will play, in order. Points per '
          + 'call, more for openers, closers and the encore.'));
        body.appendChild(el('p', 'p-wiz-copy',
          '<b>Phish Bingo</b> — a 5×5 card, one song per square, ticked off as they are played.'));
        body.appendChild(el('div', 'p-wiz-note',
          'The two scales are never mixed. Each has its own standings, and neither is ever '
          + 'folded into the other.'));
      },
    },
    {
      title: 'Filling one in',
      build: body => {
        body.appendChild(el('p', 'p-wiz-copy',
          '<b>✨ Ask Diego?</b> rolls a random one. Press it as often as you like — on a bingo '
          + 'card, locked squares survive a re-roll.'));
        body.appendChild(el('p', 'p-wiz-copy',
          '<b>🛟 Our Prediction</b>, in the ⋮ menu, fills it with the model’s own answer.'));
        body.appendChild(el('p', 'p-wiz-copy', 'Or pick by hand. All three are fine.'));
        body.appendChild(el('div', 'p-wiz-note',
          'A part-filled card saves. There is no minimum — an unfinished one just scores fewer hits.'));
      },
    },
    {
      title: 'It closes at the downbeat',
      build: body => {
        const L = lockInfo();
        body.appendChild(el('p', 'p-wiz-copy',
          `Predictions for <b>${esc(fmtDate(showdate))}</b> lock when the show starts`
          + (L.known && L.local ? ` — ${esc(L.local)} local` : '')
          + (L.known && !L.locked ? `, <b>${esc(untilText(L.at - Date.now()))}</b> from now` : '')
          + '. After that they cannot be changed.'));
        body.appendChild(el('div', 'p-wiz-note',
          'A countdown sits beside the game’s name, so you always know how long is left. Save '
          + 'early — you can keep editing right up until it locks.'));
      },
    },
    {
      title: 'Playing against people',
      build: body => {
        body.appendChild(el('p', 'p-wiz-copy',
          '<b>🏆 Standings</b>, in the ⋮ menu, ranks everyone for the game you are in — and '
          + 'narrows to just your friends, or a group.'));
        body.appendChild(el('p', 'p-wiz-copy',
          'Friends and groups form by <b>invite link</b>, under Friends in the ☰ menu. If you '
          + 'arrived on someone’s link, you are already connected to them.'));
        body.appendChild(el('div', 'p-wiz-note',
          'That is everything. Ask Diego? fills a card in one press — the open show is waiting.'));
      },
    },
  ];

  function renderWizard() {
    const card = el('div', 'p-wiz');
    const head = el('div', 'p-wiz-head');
    head.appendChild(el('h3', null, esc(WIZARD_STEPS[wizardStep].title)));
    const skip = el('button', 'p-wiz-skip', 'Skip');
    skip.title = 'Skip the intro — all of it lives in the menus';
    skip.disabled = wizardBusy;
    skip.addEventListener('click', () => wizardSave({ wizardSeen: true }));
    head.appendChild(skip);
    card.appendChild(head);
    card.appendChild(el('div', 'p-wiz-count', `Step ${wizardStep + 1} of ${WIZARD_STEPS.length}`));

    const body = el('div', 'p-wiz-body');
    const state = {};
    WIZARD_STEPS[wizardStep].build(body, state);
    card.appendChild(body);

    const actions = el('div', 'p-wiz-actions');
    if (wizardStep > 0) {
      const back = el('button', 'p-btn p-btn-alt', 'Back');
      back.disabled = wizardBusy;
      back.addEventListener('click', () => { wizardStep--; render(); });
      actions.appendChild(back);
    }
    const last = wizardStep === WIZARD_STEPS.length - 1;
    const next = el('button', 'p-btn', last ? 'Finish' : 'Next');
    next.disabled = wizardBusy;
    next.addEventListener('click', () => {
      // Step 1 collects; the rest only tell, so it is the only one that writes.
      const patch = {};
      if (state.name) patch.displayName = state.name.value;
      if (state.avatar) patch.avatar = state.avatar.value;
      if (last) { wizardSave({ ...patch, wizardSeen: true }); return; }
      if (Object.keys(patch).length) wizardSave(patch, () => { wizardStep++; });
      else { wizardStep++; render(); }
    });
    actions.appendChild(next);
    card.appendChild(actions);
    mount.appendChild(card);
  }

  function renderTopBar() {
    const bar = el('div', 'p-topbar');
    // On History and Profile the account IS the subject, so it stays. On a game it is
    // furniture: your own name and totals are not news to you, and they sat directly
    // between the heading and the board.
    // Nothing for a signed-out visitor either way: the "Sign in to save" button says what
    // happens, at the moment they go to do it.
    if (user && (mode === 'history' || mode === 'profile')) {
      const s = user.stats || {};
      const summary = statSummary(s);
      const statText = ` · ${s.predictions ?? 0} predictions, ${s.scored ?? 0} scored${summary ? ' · ' + summary : ''}`;
      bar.appendChild(el('span', null, `<span class="p-avatar">${esc(avatarOf(user))}</span> <b>${esc(displayName(user))}</b><span class="hint">${esc(statText)}</span>`));
    }

    // The show picker is gone. `showdate` stays pinned to A.nextShow.date, which is what
    // it was defaulted to and what all but a handful of visits would ever have set it to —
    // a date field and a restatement of the show were two rows of chrome guarding a choice
    // nobody was making. The countdown on the heading row already names the show's timing,
    // and the model's own Predicted Setlist tab names the venue.
    // Restoring it means putting the input back here; nothing downstream assumed it.

    // The lock countdown now rides the heading row — see render().

    // Attendance toggle: hidden, not deleted. Marking a show you attended is a side
    // errand next to playing, and it sat directly under the thing people came to do.
    // Everything behind it still works — /api/attendance, the attended set, and the
    // points-at-shows split — so flipping this back is one line.
    //
    // Consequence while it is off: nobody can mark a NEW show, so pointsAtShows and
    // pointsRemote only keep separating for people who already marked something. Needs
    // somewhere else to live before that split means much.
    const SHOW_ATTENDANCE_TOGGLE = false;
    if (SHOW_ATTENDANCE_TOGGLE) {
      const here = attendedDates.has(showdate);
      const att = el('button', 'p-attend' + (here ? ' on' : ''),
        here ? '🎟 I was at this show' : '🎟 Mark that I was at this show');
      att.title = 'Self-reported — tracked alongside your prediction accuracy';
      att.addEventListener('click', async () => {
        const next = !attendedDates.has(showdate);
        att.disabled = true;
        try {
          await api('/api/attendance', 'POST', { showdate, attended: next });
          if (next) attendedDates.add(showdate); else attendedDates.delete(showdate);
          // Refresh stats so the points split and attended count update immediately.
          try { user = (await api('/api/me')).user; } catch { /* stats are cosmetic here */ }
          render();
        } catch (e) {
          att.disabled = false;
          flash(e.message, true);
        }
      });
      bar.appendChild(att);
    }
    // On a game with the toggle off this bar is now empty, and .p-topbar carries a bottom
    // margin — appending it anyway would leave the blank row we just removed.
    if (bar.childElementCount) mount.appendChild(bar);
  }

  async function loadExisting() {
    if (!user) { attendedDates = new Set(); render(); return; }
    // Attendance is fetched whole rather than per-date: it's a short list, and My
    // History needs all of it anyway. Failure here is non-fatal — the rest of the
    // predictor should still load if this one call fails.
    try {
      const { showdates } = await api('/api/attendance');
      attendedDates = new Set(showdates);
    } catch { attendedDates = new Set(); }
    const preds = await api(`/api/predictions?user=${user.handle}&showdate=${showdate}`);
    const sl = preds.find(p => p.type === 'setlist');
    const bg = preds.find(p => p.type === 'bingo');
    const wb = preds.find(p => p.type === 'wombat');
    // Saved predictions win, but never clobber an unsaved local draft with emptiness —
    // signing in mid-draft (e.g. via the menu) must not wipe the work in progress.
    const draftSongs = build.set1.length + build.set2.length + build.encore.length;
    if (sl) build = JSON.parse(JSON.stringify(sl.payload));
    else if (!draftSongs) build = { set1: [], set2: [], encore: [] };
    const draftCells = grid.filter((c, i) => c && i !== FREE).length;
    if (bg) grid = bg.payload.grid.slice();
    else if (!draftCells) grid = Array(25).fill(null);
    if (wb) wombatRanks = JSON.parse(JSON.stringify(wb.payload.ranks || []));
    else if (!wombatRanks.length) wombatRanks = [];
    locks = Array(25).fill(false);
    livePrediction = bg || null;
    savedWombat = wb || null;
    // Retained so the setlist builder can offer the same way back as the board does. The
    // payload is what gets restored, so it must not be the same object `build` is edited
    // through — otherwise editing the draft would quietly rewrite the thing being kept as
    // the way to undo it. `build` is already a deep copy above; this keeps the original.
    savedSetlist = sl || null;
    bingoDeclared = false;
    render();
  }

  // Same question as gridDiffersFromSaved, asked of the three lists. Compares slugs in
  // order: reordering changes no song on the list but is exactly the kind of unsaved edit
  // that matters here, since first and last in each set carry the opener and closer bonuses.
  function setlistDiffersFromSaved() {
    const saved = savedSetlist && savedSetlist.payload;
    if (!saved) return false;
    for (const key of ['set1', 'set2', 'encore']) {
      const a = build[key] || [];
      const b = saved[key] || [];
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i++) if (a[i].slug !== b[i].slug) return true;
    }
    return false;
  }

  // ---------- setlist builder ----------
  function randomSongs(n, used) {
    const pool = songs.filter(s => !used.has(s.slug));
    const totalW = pool.reduce((t, s) => t + s.plays + 1, 0);
    const out = [];
    let tries = 0;
    while (out.length < n && tries++ < 500) {
      let r = Math.random() * totalW;
      let pick = pool[pool.length - 1];
      for (const s of pool) { r -= s.plays + 1; if (r <= 0) { pick = s; break; } }
      if (!used.has(pick.slug)) { used.add(pick.slug); out.push({ slug: pick.slug, name: pick.name }); }
    }
    return out;
  }

  let dragState = null;

  // Index math lives in web/reorder.js so it can be unit tested without a DOM.
  const { resolveDropTarget, resolveDropIndex, moveItem } = self.KalphishiReorder;

  // Which row a drag is currently over, and whether it should land after it.
  // Pointer capture keeps events on the handle, so hit-testing is done by clientY.
  function dropTargetIn(list, clientY) {
    const rects = [...list.querySelectorAll('.p-songrow')].map(n => n.getBoundingClientRect());
    return resolveDropTarget(rects, clientY);
  }

  function clearDropMarks(list) {
    list.querySelectorAll('.drop-above, .drop-below')
      .forEach(n => n.classList.remove('drop-above', 'drop-below'));
  }

  function renderSetlistBuilder() {
    const usedSlugs = () => new Set([...build.set1, ...build.set2, ...build.encore].map(s => s.slug));

    // Both named, because the Actions menu and the Ask Diego? button each run one.
    const randomizeSetlist = () => {
      const used = new Set();
      const s1n = 8 + Math.floor(Math.random() * 3);              // 8–10
      const s2n = 7 + Math.floor(Math.random() * 4);              // 7–10
      const en = [1, 1, 2, 2, 2, 3, 4][Math.floor(Math.random() * 7)]; // usually 1–2, capped at 4
      build = {
        set1: randomSongs(s1n, used),
        set2: randomSongs(s2n, used),
        encore: randomSongs(en, used),
      };
      render();
    };

    const fillSetlistFromModel = () => {
      const P = lensSetlist();
      build = {
        set1: P.set1.map(s => ({ slug: s.slug, name: s.name })),
        set2: P.set2.map(s => ({ slug: s.slug, name: s.name })),
        encore: P.encore.map(s => ({ slug: s.slug, name: s.name })),
      };
      appliedFill = { mode: 'setlist', label: fillLabel(), snap: setlistSnap(build) };
      render();
      if (!lensIsDefault()) flash(`Filled from ${lensArm().label}.`);
    };

    // Row order, left to right: Save, Ask Diego?, then Actions pinned to the far right.
    // Two buttons and a menu — Reload last save moved inside Actions, which is where the
    // occasional things live and which is what lets this hold one line on a phone. Actions
    // stays deliberately the furthest thing from Save, so the destructive items inside it
    // are never adjacent to the button people press most.
    const controls = el('div', 'p-row p-controls');
    const songCount = build.set1.length + build.set2.length + build.encore.length;

    // Save only appears once there is something to save. Saving three empty lists is not a
    // thing anyone means to do, and Ask Diego? is the better answer to "how do I start".
    if (songCount > 0) {
      const save = el('button', 'p-btn', user ? 'Bag it, Tag it'
        : probablyHasAccount() ? 'Sign in to save' : 'Sign up to save');
      save.addEventListener('click', () => requireAuth('Save your setlist:', async () => {
        try {
          await api('/api/predictions', 'POST', { showdate, type: 'setlist', payload: build });
          savedSetlist = { payload: JSON.parse(JSON.stringify(build)) };
          flash('Saved.');
          window.KalphishiRig?.peak();
          render(); // Reload should disappear the moment the draft and the save agree again
        } catch (e) { flash(e.message, true); }
      }));
      controls.appendChild(save);
    }

    // Ask Diego? rolls a random setlist, and stays on the row afterwards — a first roll is
    // rarely the one you want, and hiding it meant reopening Actions to roll again. It
    // deliberately does NOT use the model: Our Prediction is one press away in the
    // menu and is a different offer, "show me the answer" rather than "give me a board".
    // Drops to secondary styling once Save is present, so the row never carries two primary
    // actions at once.
    const pick = el('button', 'p-btn' + (songCount ? ' p-btn-alt' : ''), '✨ Ask Diego?');
    pick.title = 'Roll a random setlist — press again for a different one';
    // The strobe belongs to the BUTTON, not to randomizeSetlist — the Actions menu can
    // reach the same shuffle, and a menu pick is not the moment the light show is for.
    pick.addEventListener('click', () => { window.KalphishiRig?.strobe(); randomizeSetlist(); });
    controls.appendChild(pick);

    // The way back from a mis-press, matching the board's. Only offered when there is a
    // save to return to AND the draft has actually moved away from it — otherwise it is an
    // entry that does nothing, sitting among ones that do.
    const reloadItem = savedSetlist && setlistDiffersFromSaved()
      ? [['↩ Reload last save', () => {
        // Deep copy on the way out, so editing the restored draft cannot reach back into
        // the saved payload and rewrite what "last saved" means.
        build = JSON.parse(JSON.stringify(savedSetlist.payload));
        render();
        flash('Reloaded your last saved setlist.');
      }]]
      : [];

    controls.appendChild(actionsMenu([
      // First in the menu. It is the only entry that produces a considered answer rather than
      // a shuffle or a wipe, it is the one the Nerd Zone sends people here to find, and it is
      // the one a first-timer is looking for — Randomize was above it purely by accident of
      // the order these were written in.
      [ourPredictionLabel(), fillSetlistFromModel],
      ['🎲 Randomize', randomizeSetlist],
      // Reload sits directly ABOVE Clear. They are a destroy/undo pair either way, but in
      // this order the way back is read before the way to need it, and Clear stays the
      // last thing in the group — nearest the bottom, furthest from a stray press.
      ...reloadItem,
      // Clear used to be omitted on the grounds that setlist rows are removed one at a
      // time — but that is the argument FOR it: emptying three lists by hand is twenty-odd
      // presses, where the board version was always one.
      ['🧹 Clear', () => { build = { set1: [], set2: [], encore: [] }; render(); }],
      boardMenuItem(),
      [helpOpen ? '✕ Hide scoring rules' : '❓ How scoring works',
        () => { helpOpen = !helpOpen; render(); }, { keepLive: true }],
    ]));
    mount.appendChild(controls);
    if (boardOpen) mount.appendChild(boardPanel('setlist'));
    if (helpOpen) mount.appendChild(scoringHelp('setlist'));

    const wrap = el('div', 'p-sets');
    for (const [key, label] of [['set1', 'Set 1'], ['set2', 'Set 2'], ['encore', 'Encore']]) {
      const col = el('div', 'p-setcol');
      // The set label is a toggle now, with the count folded into it. On a phone the three
      // sets stack, so a full Set 1 puts Set 2's typeahead ~10 rows down — folding a set is
      // how you get past it without scrolling through it. The count lives in the header so
      // a folded set still says how full it is; the over-cap warning line stays in the
      // body, where the rows it is warning about are.
      const isOpen = setOpen[key];
      const head = el('button', 'p-sethead',
        `<span class="p-caret"${isOpen ? ' style="transform: rotate(90deg)"' : ''}>▸</span>`
        + `<span class="setlabel">${label}</span>`
        + `<span class="p-setcount${build[key].length > SOFT_CAP[key] ? ' p-cap-over' : ''}">`
        + `${build[key].length} of ${SOFT_CAP[key]}</span>`);
      head.setAttribute('aria-expanded', String(isOpen));
      head.addEventListener('click', () => { setOpen[key] = !isOpen; render(); });
      col.appendChild(head);
      if (!isOpen) { wrap.appendChild(col); continue; }
      const list = el('div', 'p-setlist');
      build[key].forEach((s, i) => {
        const stressor =
          key === 'set1' && i === 0 ? 'OPENER' :
          key === 'set1' && i === build.set1.length - 1 && build.set1.length > 1 ? 'CLOSER' :
          key === 'set2' && i === 0 ? 'OPENER' :
          key === 'set2' && i === build.set2.length - 1 && build.set2.length > 1 ? 'CLOSER' :
          key === 'encore' ? 'ENCORE' : null;
        const m = meta[s.slug];
        const metaLine = m
          ? `<div class="p-songmeta">last: ${m.lastPlayed}${m.venue ? ' · ' + esc(m.venue) : ''} · ${m.gap} show${m.gap === 1 ? '' : 's'} ago</div>`
          : '';
        // Badges sit at the row's right edge, beside the ×, not trailing the name. Inline
        // they gave every row a different name-to-badge seam and the eye had to hunt for
        // them; ranged right they form one scannable column, and the name column stays
        // ragged-right the way a list of titles should read.
        const badges = `${bustChip(s.slug)}${stressor ? `<span class="p-stress">${stressor}</span>` : ''}`;
        const row = el('div', 'p-songrow',
          `<span class="p-songmain"><span>${esc(s.name)}</span>${metaLine}</span>`
          + (badges.trim() ? `<span class="p-rowbadges">${badges}</span>` : ''));
        // Pointer Events rather than HTML5 drag-and-drop: touch devices never fire
        // dragstart/dragover/drop, so the old handlers made this desktop-only.
        const handle = el('span', 'p-drag', '⋮⋮');
        handle.title = 'drag to reorder';
        row.prepend(handle);
        handle.addEventListener('pointerdown', ev => {
          ev.preventDefault();
          // Capture keeps move/up on the handle once the finger leaves the row.
          try { handle.setPointerCapture(ev.pointerId); } catch { /* non-active id */ }
          dragState = { key, from: i };
          row.classList.add('dragging');
        });
        handle.addEventListener('pointermove', ev => {
          if (!dragState || dragState.key !== key) return;
          clearDropMarks(list);
          const t = dropTargetIn(list, ev.clientY);
          if (!t || t.idx === i) return;
          const target = list.querySelectorAll('.p-songrow')[t.idx];
          if (target) target.classList.add(t.after ? 'drop-below' : 'drop-above');
        });
        const endDrag = ev => {
          if (!dragState || dragState.key !== key) return;
          const t = dropTargetIn(list, ev.clientY);
          clearDropMarks(list);
          row.classList.remove('dragging');
          const from = dragState.from;
          dragState = null;
          const to = resolveDropIndex(from, t);
          if (to !== from) build[key] = moveItem(build[key], from, to);
          render();
        };
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', () => {
          dragState = null;
          clearDropMarks(list);
          row.classList.remove('dragging');
        });
        const x = el('button', 'p-x', '×');
        x.addEventListener('click', () => { build[key].splice(i, 1); render(); });
        row.appendChild(x);
        list.appendChild(row);
      });
      col.appendChild(list);
      // The count moved up into the set header, where it survives folding. What stays down
      // here is only the warning: the cap is not enforced — Phish plays 15-song sets — but
      // past it a wrong guess costs a point, and that has to be visible beside the rows it
      // is about before someone saves, not as a surprise when the show is graded.
      const over = build[key].length - SOFT_CAP[key];
      if (over > 0) {
        const warn = el('div', 'p-cap p-cap-over',
          `${over} past the cap — each costs 1 point if wrong`);
        warn.title = `Songs beyond ${SOFT_CAP[key]} only score if you call them right. Each wrong one deducts a point. Remove them and no deduction applies.`;
        col.appendChild(warn);
      }
      col.appendChild(typeahead(`add to ${label}…`, usedSlugs, s => { build[key].push(s); render(); }));
      wrap.appendChild(col);
    }
    mount.appendChild(wrap);
    // Kept, unlike the rest of the guidance: which entry counts as the opener and which
    // as the closer changes the score, and there is no way to work it out from the UI.
    mount.appendChild(el('div', 'hint',
      'First is the opener, last is the closer. Drag ⋮⋮ to move.'));
  }

  // ---------- bingo ----------
  // Has the working card drifted from the one on the server? Compares slugs rather than
  // the song objects: the slug is the identity, and a stored payload built by an older
  // version of this file need not hold the same shape of object to still mean the same
  // card. Position matters — a swap changes nothing about which songs are on the card but
  // is very much an unsaved change.
  function gridDiffersFromSaved() {
    const saved = livePrediction && livePrediction.payload && livePrediction.payload.grid;
    if (!Array.isArray(saved)) return false;
    for (let i = 0; i < 25; i++) {
      if ((grid[i] ? grid[i].slug : null) !== (saved[i] ? saved[i].slug : null)) return true;
    }
    return false;
  }

  function renderBingo() {
    const scored = livePrediction && livePrediction.result;
    // Checking squares off is something you do *during* the show, so the lock starts it —
    // not the save. Saving used to end the editing phase outright, which meant a card
    // committed days early could not be touched again even though the show had not
    // started and the server would happily have taken an overwrite. Now a saved card
    // stays a draft until the downbeat: editable, re-savable, and restorable from the last
    // save. This is also why the lock sweep in render() leaves bingo cells alone — by the
    // time cells are tappable, tapping is the only thing they should do.
    const live = !!livePrediction && !scored && lockInfo().locked;
    const checked = live ? (livePrediction.liveChecked || Array(25).fill(false)) :
      scored ? livePrediction.result.checked : null;

    // The live and scored lines moved up onto the heading row — see render(). The
    // build-mode instructions are gone entirely: this crowd knows what a bingo card is.
    //
    // Shown only while a square is armed — it says what the highlight means and how to get
    // out of it, which is the one moment that is not self-evident.
    if (!live && !scored && swapFrom !== null && grid[swapFrom]) {
      mount.appendChild(el('div', 'hint',
        `Moving <b>${esc(grid[swapFrom].name)}</b> — tap another square to swap, or tap it again to cancel.`));
    }

    const banner = el('div', 'p-bingo-banner');
    banner.style.display = 'none';
    mount.appendChild(banner);

    const usedSlugs = () => new Set(grid.filter((c, i) => c && i !== FREE).map(c => c.slug));

    // controls + cell picker live ABOVE the grid
    const controls = el('div', 'p-row p-controls');
    if (!scored) mount.appendChild(controls);
    // A scored card has no controls row to hang the Actions menu off, and that is precisely
    // when somebody wants to read how the scoring worked and where it put them — so both
    // get a row of their own rather than becoming unreachable on the one screen that most
    // invites the question.
    else {
      const row = mount.appendChild(el('div', 'p-row'));
      row.appendChild(boardButton());
      row.appendChild(scoringHelpButton());
    }
    if (boardOpen) mount.appendChild(boardPanel('bingo'));
    if (helpOpen) mount.appendChild(scoringHelp('bingo'));
    // A mode that silently changes what a tap does has to say so. Without this the card
    // looks identical to build mode while × and drag-to-reorder have both quietly stopped
    // working, which reads as the page being broken rather than as a mode being on.
    if (lockMode) {
      mount.appendChild(el('div', 'p-lockhint',
        '🔒 <b>Lock mode</b> — tap squares to lock or unlock them. Locked squares survive '
        + 'Ask Diego?, Randomize and Our Prediction. Press <b>Lock it in</b> when done.'));
    }
    const pickerHost = el('div', 'p-picker');
    mount.appendChild(pickerHost);

    // Lock mode belongs to building a card. A live or scored card has nothing to protect
    // from Randomize, so arriving in either state ends it rather than leaving a mode
    // running that no longer has a way out — its exit button is the builder's.
    if (live || scored) lockMode = false;

    // Reordering is a build-mode affordance. In live mode a tap checks a square off, and
    // a scored card is history — neither should move anything. Lock mode joins them: while
    // it is on, a tap means "lock this", and drag-to-reorder competing for the same gesture
    // is how a lock press becomes an accidental swap.
    const editable = !live && !scored && !lockMode;
    if (!editable) swapFrom = null;

    // Songs trade places, and their locks travel with them: a lock reads as belonging to
    // the song you locked, not to the slot it happened to be sitting in.
    function swapCells(a, b) {
      if (a === b || a === FREE || b === FREE) return;
      [grid[a], grid[b]] = [grid[b], grid[a]];
      [locks[a], locks[b]] = [locks[b], locks[a]];
      swapFrom = null;
      render();
    }

    const idxAt = (x, y) => {
      const c = document.elementFromPoint(x, y);
      const cell = c && c.closest('.p-cell');
      if (!cell || cell.dataset.idx === undefined) return null;
      const t = Number(cell.dataset.idx);
      return t === FREE ? null : t;
    };
    const clearTargets = () => {
      for (const c of document.querySelectorAll('.p-cell.p-swaptarget')) c.classList.remove('p-swaptarget');
    };

    function attachSwap(cell, i) {
      cell.dataset.idx = i;
      if (grid[i]) cell.classList.add('p-swappable');
      if (swapFrom === i) cell.classList.add('p-swapfrom');

      let start = null, dragging = false;
      cell.addEventListener('pointerdown', ev => {
        // The lock and × buttons own their own taps.
        if (ev.target.closest('button')) return;
        // An empty square is only interesting once something is armed to move into it.
        if (!grid[i] && swapFrom === null) { start = { tapOnly: true }; return; }
        start = { x: ev.clientX, y: ev.clientY };
        if (!COARSE_POINTER) { try { cell.setPointerCapture(ev.pointerId); } catch { /* stale id */ } }
      });

      if (!COARSE_POINTER) {
        cell.addEventListener('pointermove', ev => {
          if (!start || start.tapOnly) return;
          if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
            dragging = true;
            cell.classList.add('p-dragging');
          }
          if (!dragging) return;
          clearTargets();
          const t = idxAt(ev.clientX, ev.clientY);
          if (t !== null && t !== i) {
            const target = table.querySelector(`.p-cell[data-idx="${t}"]`);
            if (target) target.classList.add('p-swaptarget');
          }
        });
      }

      cell.addEventListener('pointerup', ev => {
        if (!start) return;
        const wasDrag = dragging;
        start = null; dragging = false;
        cell.classList.remove('p-dragging');
        clearTargets();

        if (wasDrag) {
          const t = idxAt(ev.clientX, ev.clientY);
          if (t !== null && t !== i) swapCells(i, t);
          return;
        }
        // A tap. Arm, disarm, swap, or — on an empty square with nothing armed — pick.
        if (swapFrom === null) {
          if (!grid[i]) return openCellPicker(i);
          swapFrom = i;
          render();
        } else if (swapFrom === i) {
          swapFrom = null;
          render();
        } else {
          swapCells(swapFrom, i);
        }
      });

      cell.addEventListener('pointercancel', () => {
        start = null; dragging = false;
        cell.classList.remove('p-dragging');
        clearTargets();
      });
    }

    const table = el('div', 'p-grid');
    table.appendChild(el('div', 'p-corner', ''));
    for (const c of PHISH) table.appendChild(el('div', 'p-head', c));

    for (let r = 0; r < 5; r++) {
      // p-rowhead marks the left-edge labels apart from the top row's: on a phone they are
      // hidden and their column's width goes to the squares — the top P·H·I·S·H already
      // names the game, and the rows repeat it five times at the cost of ~4px of song title
      // per square. Desktop keeps both axes; the grid is roomy there and the row labels
      // help the eye track a line.
      table.appendChild(el('div', 'p-head p-rowhead', PHISH[r]));
      for (let c = 0; c < 5; c++) {
        const i = r * 5 + c;
        let cell;
        if (i === FREE) {
          // Donut only, no caption. The label used to read FREE, which sat in a grid of
          // song titles directly above a real song called Free — so it scanned as someone
          // having predicted that song rather than as the given square.
          cell = el('div', 'p-cell free checked', '🍩');
          cell.title = 'Donut square — always counts toward a line';
          cell.setAttribute('aria-label', 'Donut square, always counts toward a line');
        } else if (grid[i]) {
          const isChecked = checked ? checked[i] : false;
          // The tier rides as a class on the cell itself, not just the badge inside it —
          // see .p-cell.bust-* in the CSS. On a phone that class becomes a coloured border
          // instead of the text pill, which is how the same information survives a cell
          // too small to hold "MEGA BUSTOUT" without wrapping over half the square.
          const tier = bustTier(grid[i].slug);
          cell = el('div', 'p-cell filled' + (isChecked ? ' checked' : '') + (tier ? ` bust-${tier.cls}` : ''),
            `<span class="p-cellname">${esc(grid[i].name)}</span>${bustChip(grid[i].slug)}`);
          if (live) {
            cell.title = 'tap to check off';
            cell.addEventListener('click', async () => {
              checked[i] = !checked[i];
              const j = await api('/api/live-check', 'POST', { showdate: livePrediction.showdate, type: 'bingo', checked });
              livePrediction.liveChecked = checked;
              render();
              if (j.bingo && !bingoDeclared) { bingoDeclared = true; declareBingo(); }
            });
          } else if (!scored) {
            if (locks[i]) cell.classList.add('locked');
            if (lockMode) {
              // The whole square is the target, and it is the ONLY thing a tap can do here.
              // The × is deliberately withheld: in a mode where every tap toggles a lock, a
              // delete button one thumb-width away turns a mis-tap into a lost song.
              cell.classList.add('p-lockpick');
              cell.title = locks[i] ? 'locked — tap to unlock' : 'tap to lock this square';
              // No padlock is drawn here. On a 5×5 grid, 24 of them fought the song titles
              // for the same few pixels; the red FILL carries it instead (a wash, not a
              // border — the bustout tiers own the border channel on phones), and carries
              // it across the whole card at a glance rather than one cell at a time.
              // aria-pressed is what keeps the state readable without the glyph.
              cell.setAttribute('aria-pressed', String(!!locks[i]));
              cell.addEventListener('click', () => { locks[i] = !locks[i]; render(); });
            } else if (locks[i]) {
              // No toggle here any more — Lock mode owns locking. What stays is the state,
              // and only on the squares that have it: a locked square has to keep reading as
              // locked while you build, or its missing × looks like a rendering fault rather
              // than a consequence. An unlocked square shows nothing at all, which is the
              // point — 24 padlocks were 24 controls nobody was aiming at.
              const mark = el('span', 'p-lock', '🔒');
              mark.title = 'locked — Randomize will keep this square. Use Lock mode to unlock it.';
              cell.appendChild(mark);
            } else {
              const x = el('button', 'p-x', '×');
              x.addEventListener('click', ev => { ev.stopPropagation(); grid[i] = null; render(); });
              cell.appendChild(x);
            }
          }
        } else {
          cell = el('div', 'p-cell empty', '<span class="p-cellname">＋</span>');
          // While editing, the swap handler owns taps on empty cells too — an armed square
          // moves into one instead of opening the picker. Two listeners would race.
          //
          // Lock mode makes `editable` false, which would otherwise hand these cells the
          // picker — so it is excluded explicitly. There is nothing to lock on an empty
          // square, and opening a song search from a mode about locks is a non sequitur.
          if (!scored && !editable && !lockMode) cell.addEventListener('click', () => openCellPicker(i));
        }
        if (editable && i !== FREE) attachSwap(cell, i);
        table.appendChild(cell);
      }
    }
    mount.appendChild(table);

    function openCellPicker(i) {
      pickerHost.innerHTML = `<div class="setlabel">Pick a song for ${PHISH[Math.floor(i / 5)]}-row, ${PHISH[i % 5]}-column</div>`;
      const ta = typeahead('search the catalog…', usedSlugs, s => { grid[i] = s; render(); });
      pickerHost.appendChild(ta);
      ta.querySelector('input').focus();
    }

    if (!scored) {
      const randomize = () => {
        const keep = new Set(grid.filter((c, i) => c && locks[i] && i !== FREE).map(c => c.slug));
        // weight by play count so cards stay plausible; +1 so rarities are possible
        const pool = songs.filter(s => !keep.has(s.slug));
        const totalW = pool.reduce((t, s) => t + s.plays + 1, 0);
        const used = new Set(keep);
        function draw() {
          for (let tries = 0; tries < 50; tries++) {
            let r = Math.random() * totalW;
            for (const s of pool) { r -= s.plays + 1; if (r <= 0) { if (!used.has(s.slug)) { used.add(s.slug); return s; } break; } }
          }
          const s = pool.find(x => !used.has(x.slug)); // fallback: first unused
          used.add(s.slug);
          return s;
        }
        for (let i = 0; i < 25; i++) {
          if (i === FREE || locks[i]) continue;
          grid[i] = draw();
        }
        render();
      };

      const fillFromModel = () => {
        const keep = new Set(grid.filter((c, i) => c && locks[i] && i !== FREE).map(c => c.slug));
        const seq = [];
        const pushUnique = s => {
          if (s && s.slug && !keep.has(s.slug) && !seq.some(x => x.slug === s.slug)) seq.push({ slug: s.slug, name: s.name });
        };
        const P = lensSetlist();
        for (const list of [P.set1, P.set2, P.encore]) list.forEach(pushUnique);
        for (const c of lensRanking()) pushUnique(c); // top up beyond the 17 predicted songs
        let k = 0;
        for (let i = 0; i < 25; i++) {
          if (i === FREE || locks[i]) continue;
          grid[i] = seq[k++] || null;
        }
        // Locked squares survive the fill, so a card with locks is already part yours —
        // the snapshot records what the fill actually produced, and the tag stands until
        // the board moves away from that.
        appliedFill = { mode: 'bingo', label: fillLabel(), snap: gridSnap(grid) };
        render();
        if (!lensIsDefault()) flash(`Filled from ${lensArm().label}.`);
      };

      const clearCard = () => {
        for (let i = 0; i < 25; i++) {
          if (i === FREE || locks[i]) continue;
          grid[i] = null;
        }
        render();
      };

      // Row order, left to right: Save, Ask Diego?, then Actions pinned to the far right —
      // matching the setlist builder exactly, Reload last save included, which now lives
      // inside Actions on both.
      const filledNow = grid.filter((c, i) => c && i !== FREE).length;

      // A part-filled card saves. There is no minimum: nothing on the server enforces one,
      // and scoreBingoPrediction already guards empty cells (`!!cell`) and still divides by
      // 24, so an unfinished card simply scores fewer hits out of the same denominator.
      // bingoLine treats the donut as always-counting, so a line can still complete through
      // the middle. Blocking the save only ever stopped somebody committing a card they had
      // half-built and meant to come back to — and until the show locks they can.
      if (filledNow > 0) {
        // Same label whether or not a card is already saved: re-saving is the same act, and
        // now that a save no longer ends the editing phase it is one people will do more
        // than once. Matches the setlist builder's button exactly.
        const save = el('button', 'p-btn', user ? 'Bag it, Tag it'
          : probablyHasAccount() ? 'Sign in to save' : 'Sign up to save');
        save.addEventListener('click', () => {
          requireAuth('Save your card:', async () => {
            try {
              await api('/api/predictions', 'POST', { showdate, type: 'bingo', payload: { grid } });
              await loadExisting();
              mode = 'bingo';
              flash(filledNow < 24
                ? `${filledNow}/24 in. Finish it before showtime.`
                : 'Card’s in. Tap ’em as they come.');
              window.KalphishiRig?.peak();
            } catch (e) { flash(e.message, true); }
          });
        });
        controls.appendChild(save);
      }

      // Ask Diego? randomizes the card, and stays on the row afterwards so it can be
      // pressed repeatedly — a first roll is rarely the one you want, and hiding it meant
      // reopening Actions to roll again. It deliberately does NOT use the model:
      // Our Prediction is one press away in the menu and is a different offer,
      // "show me the answer" rather than "give me a card".
      //
      // Because it routes through randomize, locked squares survive a re-roll — which is
      // what makes repeated pressing useful rather than destructive: lock the ones you
      // like, roll the rest.
      //
      // While lock mode is on this slot is the way out of it instead. Ask Diego? is the
      // one control lock mode has to displace: re-rolling is what locks exist to survive,
      // so offering the roll mid-lock invites pressing it before the locks are set. Taking
      // its place also means the exit is where the thumb already is, rather than back
      // inside the menu the mode was opened from.
      // Same secondary-once-Save-exists treatment either way. Lock it in is the way out of
      // a mode, not a second thing to do to the card, and a row carrying two primary
      // buttons at once is the exact thing that styling rule exists to prevent. The hint
      // above the grid names the button in bold, so the exit is not hard to find for it.
      const pick = el('button', 'p-btn' + (filledNow ? ' p-btn-alt' : ''),
        lockMode ? '🔒 Lock it in' : '✨ Ask Diego?');
      pick.title = lockMode
        ? 'Done locking — back to building the card'
        : 'Fill the unlocked squares at random — press again for a different card';
      pick.addEventListener('click', lockMode
        ? () => { lockMode = false; render(); }
        : () => { window.KalphishiRig?.strobe(); randomize(); });
      controls.appendChild(pick);

      // The way out of a mis-click. Clear and Randomize both overwrite the board in one
      // press, and until the show locks the saved card is the only copy that is not in
      // this tab — without this, one stray press means rebuilding it by hand.
      //
      // Only offered once the board actually differs from the save. Offering it against an
      // unchanged card is offering to do nothing, and an entry that is always there stops
      // being read as "you have unsaved changes" — which is the whole signal it carries.
      const reloadItem = livePrediction && gridDiffersFromSaved()
        ? [['↩ Reload last save', () => {
          // slice() so later edits mutate the copy, not the stored prediction — reloading
          // twice has to give the same card both times.
          grid = livePrediction.payload.grid.slice();
          locks = Array(25).fill(false);
          swapFrom = null;
          render();
          flash('Reloaded your last saved card.');
        }]]
        : [];

      controls.appendChild(actionsMenu([
        // First, matching the setlist builder — see the note there.
        [ourPredictionLabel(), fillFromModel],
        ['🎲 Randomize', randomize],
        // Directly under the two that overwrite the card, because it is the thing that
        // decides what they are allowed to touch. Bingo only — the setlist has no locks.
        [lockMode ? '✕ Leave lock mode' : '🔒 Lock mode',
          () => { lockMode = !lockMode; render(); }],
        // Above Clear, matching the setlist builder — see the note there.
        ...reloadItem,
        ['🧹 Clear', clearCard],
        boardMenuItem(),
        [helpOpen ? '✕ Hide scoring rules' : '❓ How scoring works',
          () => { helpOpen = !helpOpen; render(); }, { keepLive: true }],
      ]));
    }

    function declareBingo() {
      banner.innerHTML = '🍩🍩🍩 <b>BINGO!</b> Five in a line — you win the donut. 🍩🍩🍩';
      banner.style.display = '';
      banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.KalphishiRig?.peak();
    }
    // re-show banner if line already complete on render
    if (live && checked && bingoLineClient(checked)) { banner.innerHTML = '🍩🍩🍩 <b>BINGO!</b> Five in a line — you win the donut. 🍩🍩🍩'; banner.style.display = ''; }
  }

  function bingoLineClient(checked) {
    const lines = [];
    for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
    for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
    lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
    return lines.some(line => line.every(i => i === FREE || checked[i]));
  }

  // ---------- profile ----------
  function renderProfile() {
    const p = user.profile || {};
    const box = el('div');
    mount.appendChild(box);
    box.appendChild(el('div', 'setlabel', 'My profile'));
    // Hometown and favourite song are gone. What identifies somebody here is their name,
    // their avatar and their record; the other two were a form to fill in before playing.
    //
    // The stored values are deliberately left alone rather than cleared: PUT /api/profile
    // merges (`if (!(f in b)) continue`), so anything already saved simply stops being sent
    // and stops being shown. Nothing is destroyed, and restoring the fields is this edit
    // in reverse. They are dropped from the public card too — a field nobody can edit has
    // no business still being published.
    const fields = [
      ['displayName', 'display name', p.displayName || ''],
      ['avatar', 'avatar (an emoji or two)', p.avatar || ''],
    ];
    const inputs = {};
    for (const [key, label, val] of fields) {
      const lab = el('label', 'p-field', `${label}<br>`);
      const inp = el('input', 'ta-input');
      inp.value = val;
      // 4 was too tight to type a compound emoji at all — a rainbow flag is six UTF-16
      // units — so the server would accept one the field could not produce. The server
      // does the real validation now (sanitizeAvatar), so this is only a sanity bound.
      if (key === 'avatar') inp.maxLength = 24;
      inputs[key] = inp;
      lab.appendChild(inp);
      box.appendChild(lab);
    }
    const bioLab = el('label', 'p-field', 'bio<br>');
    const bio = el('textarea', 'ta-input p-bio');
    bio.value = p.bio || '';
    bioLab.appendChild(bio);
    box.appendChild(bioLab);
    const save = el('button', 'p-btn', 'Save profile');
    save.addEventListener('click', async () => {
      try {
        const body = { bio: bio.value };
        for (const k of Object.keys(inputs)) body[k] = inputs[k].value;
        const j = await api('/api/profile', 'PUT', body);
        user = j.user;
        flash('Profile saved.');
        render();
      } catch (e) { flash(e.message, true); }
    });
    box.appendChild(save);

    const s = user.stats || {};
    box.appendChild(el('div', 'setlabel', 'Track record'));
    box.appendChild(el('div', 'hint',
      `Member since ${(user.created || '').slice(0, 10)} · ${s.predictions ?? 0} predictions · ${s.scored ?? 0} scored · ` +
      (statSummary(s) || 'nothing graded yet')));

    // Moved here from a view of its own in the account menu. It is account maintenance, the
    // account is what this page is, and as a top-level menu row it outranked the social loop
    // people actually come back for. Last on the page because it is the rarest thing here.
    box.appendChild(el('div', 'setlabel', 'Change password'));
    const cur = el('input', 'ta-input');
    cur.type = 'password'; cur.placeholder = 'current password'; cur.autocomplete = 'current-password';
    const nw = el('input', 'ta-input');
    // 6 mirrors MIN_PASSWORD_LENGTH in src/auth.mjs, which is the only place it is enforced.
    nw.type = 'password'; nw.placeholder = 'new password (6+ chars for now)'; nw.autocomplete = 'new-password';
    const pwMsg = el('div', 'hint');
    const pwSave = el('button', 'p-btn', 'Change password');
    pwSave.addEventListener('click', async () => {
      pwMsg.textContent = '';
      try {
        await api('/api/password', 'PUT', { currentPassword: cur.value, newPassword: nw.value });
        // Said plainly because it is a consequence, not a confirmation: every other session
        // is gone, and somebody who changed their password on a hunch should know that.
        pwMsg.textContent = 'Password changed. Other devices were signed out.';
        cur.value = nw.value = '';
      } catch (e) { pwMsg.textContent = e.message; }
    });
    box.appendChild(cur);
    box.appendChild(nw);
    box.appendChild(pwSave);
    box.appendChild(pwMsg);

    // ---- leaving. Below the password because it is rarer still, and folded behind a
    // press because an irreversible control does not belong sitting open in a form
    // people came here to edit their avatar in. The one place in the app allowed to
    // explain itself at length: everywhere else brevity costs nothing, here it would
    // cost somebody their history.
    box.appendChild(el('div', 'setlabel', 'Leaving'));
    const delHost = el('div');
    const delOpen = el('button', 'p-btn p-btn-alt', 'Delete my account');
    delOpen.addEventListener('click', async () => {
      delOpen.remove();
      const panel = el('div', 'p-danger');
      panel.appendChild(el('div', null,
        '<b>This deletes your account, your cards, your scores and your history.</b> '
        + 'It cannot be undone.'));
      // Owned crews die with the account, for everyone in them. Named before the button,
      // not after — the people affected are not the person pressing it.
      try {
        const groups = (await api('/api/groups')).groups.filter(g => g.isOwner);
        const shared = groups.filter(g => g.memberCount > 1);
        if (shared.length) {
          panel.appendChild(el('div', 'p-danger-note',
            `⚠ It also deletes ${shared.map(g => `<b>${esc(g.name)}</b>`).join(', ')} for `
            + `everyone in ${shared.length === 1 ? 'it' : 'them'}. `
            + 'Hand the crew to someone else first if you want it to survive.'));
        }
      } catch { /* the warning is a courtesy; its absence must not block leaving */ }
      const pw = el('input', 'ta-input');
      pw.type = 'password'; pw.placeholder = 'your password'; pw.autocomplete = 'current-password';
      const msg = el('div', 'hint');
      const go = el('button', 'p-btn p-danger-btn', 'Delete my account permanently');
      go.addEventListener('click', async () => {
        go.disabled = true;
        msg.textContent = '';
        try {
          await api('/api/me', 'DELETE', { password: pw.value });
          // Everything local goes with it — the stored user is what makes the sign-in
          // form open on "Sign in" instead of "Create account", and a deleted account
          // leaving that behind would greet its own owner as a returning player.
          try { localStorage.removeItem('kalphish-user'); } catch { /* private mode */ }
          user = null; authPrompt = null; attendedDates = new Set();
          savedSetlist = null; livePrediction = null; savedWombat = null;
          mode = 'setlist';
          notifyMode();
          render();
          flash('Account deleted. Thanks for playing.');
        } catch (e) { go.disabled = false; msg.textContent = e.message; }
      });
      const cancel = el('button', 'p-mode', 'Never mind');
      cancel.addEventListener('click', () => render());
      panel.appendChild(pw);
      panel.appendChild(go);
      panel.appendChild(cancel);
      panel.appendChild(msg);
      delHost.appendChild(panel);
    });
    delHost.appendChild(delOpen);
    box.appendChild(delHost);
  }

  async function showPublicProfile(container, userId) {
    container.innerHTML = '<div class="hint">Loading profile…</div>';
    try {
      const j = await api(`/api/profile/${userId}`);
      const u = j.user, s = u.stats, p = u.profile || {};
      container.innerHTML = '';
      const card = el('div', 'p-profilecard');
      card.appendChild(el('div', null,
        `<span class="p-avatar">${esc(avatarOf(u))}</span> <b>${esc(displayName(u))}</b> <span class="hint">@${esc(u.handle)} · member since ${(u.created || '').slice(0, 10)}</span>`));
      if (p.bio) card.appendChild(el('div', null, esc(p.bio)));
      card.appendChild(el('div', 'hint',
        `${s.predictions} predictions · ${s.scored} scored · ` +
        (statSummary(s) || 'unrated')));
      if (j.recent.length) {
        card.appendChild(el('div', 'setlabel', 'Recent results'));
        for (const r of j.recent) {
          card.appendChild(el('div', 'p-histrow', `${r.showdate} · ${r.type} · score <b>${r.score}</b>${r.bingo ? ' — BINGO 🍩' : ''}`));
        }
      }
      const close = el('button', 'p-mode', 'Close');
      close.addEventListener('click', () => { container.innerHTML = ''; });
      card.appendChild(close);
      container.appendChild(card);
    } catch (e) {
      container.innerHTML = `<div class="hint">${esc(e.message)}</div>`;
    }
  }

  // The scoring-rules toggle, pushed to the right-hand end of whichever control row it is
  // dropped into. Carries p-keep-live so the lock sweep leaves it alone: once a show has
  // started is exactly when someone wants to check how they are being scored.
  // The standings for one game, built where the rules panel is built and dismissed the same
  // way. renderLeaderboard fills it in asynchronously, so the box exists in the flow from
  // the first frame and the panel does not jump into place once the fetch lands.
  function boardPanel(game) {
    const wrap = el('div', 'p-board');
    renderLeaderboard(game, wrap);
    return wrap;
  }

  // The Actions entry both games share. Same wording either side, because the panel it
  // opens names the game itself.
  const boardMenuItem = () => [
    boardOpen ? '✕ Hide standings' : '🏆 Standings',
    () => { boardOpen = !boardOpen; render(); },
    { keepLive: true },
  ];

  // The same toggle as a button, for the scored-card row that has no Actions menu. Carries
  // p-keep-live for the reason the rules button does: a finished show is when this is read.
  function boardButton() {
    const b = el('button', 'p-mode p-keep-live' + (boardOpen ? ' active' : ''),
      boardOpen ? '✕ Standings' : '🏆 Standings');
    // stopPropagation for the reason spelled out on the document listener: without it this
    // click bubbles up and closes the panel it just opened.
    b.addEventListener('click', ev => { ev.stopPropagation(); boardOpen = !boardOpen; render(); });
    return b;
  }

  function scoringHelpButton() {
    const b = el('button', 'p-mode p-keep-live p-pushright' + (helpOpen ? ' active' : ''),
      helpOpen ? '✕ Scoring' : '❓ How scoring works');
    // stopPropagation for the reason spelled out on the document listener: without it this
    // click bubbles up and closes the panel it just opened.
    b.addEventListener('click', ev => { ev.stopPropagation(); helpOpen = !helpOpen; render(); });
    return b;
  }

  // A graded prediction, drawn as the setlist it was: same three columns, same order,
  // each pick coloured by how it did and carrying the points it earned. Reading a result
  // against the thing you actually built beats reading a tally of totals.
  function scoredSetlist(b) {
    const box = el('div', 'p-scored');
    const grid = el('div', 'p-scoredgrid');
    const sign = n => (n > 0 ? `+${n}` : String(n));
    const cols = [['set1', 'Set 1'], ['set2', 'Set 2'], ['encore', 'Encore']]
      .filter(([k]) => (b.rows[k] || []).length);

    for (const [key, label] of cols) {
      const col = el('div', 'p-scoredcol');
      col.appendChild(el('div', 'setlabel', label));
      for (const row of b.rows[key]) {
        const line = el('div', `p-pick p-${row.status}`);
        // A miss is struck through and followed by whatever actually held that slot, so
        // the row says both what was wrong and what the answer was.
        const missed = row.status === 'miss' && row.actual
          ? `<span class="p-actual">actually ${esc(row.actual)}</span>` : '';
        const bonus = row.bonuses && row.bonuses.length
          ? `<span class="p-bonus">${esc(row.bonuses.join(', '))}</span>` : '';
        line.innerHTML =
          `<span class="p-pickname">${esc(row.name)}${bonus}${missed}</span>`
          + `<span class="p-pickpts">${row.points ? sign(row.points) : '0'}</span>`;
        col.appendChild(line);
      }
      col.appendChild(el('div', 'p-picktotal',
        `<span>${esc(label)} total</span><span>${sign(b.setTotals[key] ?? 0)}</span>`));
      grid.appendChild(col);
    }
    box.appendChild(grid);

    // Summed from the same setTotals the columns print, so the grand total cannot drift
    // from the parts above it.
    const grand = cols.reduce((s, [k]) => s + (b.setTotals[k] ?? 0), 0);
    box.appendChild(el('div', 'p-grandtotal',
      `<span>Show total</span><span>${sign(grand)}</span>`));

    const legend = el('div', 'p-scoredfoot');
    legend.innerHTML =
      '<span class="p-key"><i class="p-placed"></i>right song, right slot</span>'
      + '<span class="p-key"><i class="p-called"></i>right song, wrong slot</span>'
      + '<span class="p-key"><i class="p-miss"></i>not played</span>';
    box.appendChild(legend);

    if (b.unpredicted && b.unpredicted.length) {
      box.appendChild(el('div', 'p-songmeta',
        `Played but not on your card: ${b.unpredicted.map(esc).join(', ')}`));
    }
    return box;
  }

  // ---------- history ----------
  async function renderHistory() {
    const wrap = el('div');
    mount.appendChild(wrap);
    const preds = await api(`/api/predictions?user=${user.handle}`);
    preds.sort((a, b) => b.showdate.localeCompare(a.showdate));
    const st = user.stats || {};
    if (st.showsAttended) {
      // Only show the split once both sides exist — one number against nothing isn't a
      // comparison, and reading it as one would be misleading.
      const split = (st.pointsAtShows != null && st.pointsRemote != null)
        ? ` · <b>${st.pointsAtShows}</b> pts at shows vs <b>${st.pointsRemote}</b> remote`
        : '';
      wrap.appendChild(el('div', 'p-attsummary',
        `🎟 <b>${st.showsAttended}</b> show${st.showsAttended === 1 ? '' : 's'} attended${split}`));
    }
    // "No predictions yet" is true and useless — it describes the state to someone who is
    // already looking at it. What a first-timer needs is which show is open and that it
    // closes, since a prediction made after the downbeat is refused server-side.
    if (!preds.length) {
      wrap.appendChild(el('div', 'hint',
        `No predictions yet — ${esc(fmtDate(showdate))} is open now, and both games close at the downbeat.`));
    }
    for (const p of preds) {
      const r = p.result;
      // Defensive: a result row missing its expected fields used to throw mid-loop and
      // silently blank the whole history, not just its own row.
      const hits = Array.isArray(r?.hits) ? r.hits : [];
      const stressors = r?.stressors && typeof r.stressors === 'object' ? r.stressors : {};
      // Predictions graded before the points system have no breakdown — they fall back to
      // the old one-line summary rather than rendering an empty tally.
      const b = r?.breakdown;
      const parts = [];
      if (b) {
        // Read defensively: a stored result predates any later change to the breakdown
        // shape, and a missing field here used to render the literal word "undefined"
        // into somebody's track record.
        const counted = b.callsCounted ?? b.calls ?? 0;
        parts.push(`${counted} call${counted === 1 ? '' : 's'}${b.callsCapped ? ` (capped from ${b.calls})` : ''} +${b.callPoints ?? 0}`);
        if (b.placementPoints) parts.push(`${b.placements.length} placed +${b.placementPoints}`);
        if (b.encorePoints) parts.push(`${b.encoreHits.length} in the encore +${b.encorePoints}`);
        if (b.stressorPoints) parts.push(`${Object.entries(stressors).filter(([, v]) => v).map(([k]) => k).join(', ')} +${b.stressorPoints}`);
        if (b.penaltyPoints) parts.push(`${b.penaltyPoints} deducted past the cap`);
      }
      const line = r
        ? (p.type === 'setlist'
          ? (b
            ? `score <b>${r.score ?? '—'}</b> — ${parts.join(' · ')}<div class="p-songmeta">called: ${hits.map(esc).join(', ') || 'none'}</div>`
            : `score <b>${r.score ?? '—'}</b> — ${hits.length} hits (${hits.map(esc).join(', ') || 'none'}); stressors: ${Object.entries(stressors).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`)
          : `score <b>${r.score ?? '—'}</b> — ${r.hitCount ?? 0}/24 squares${r.bingo ? ' — <b>BINGO 🍩</b>' : ''}`)
        : 'not scored yet';
      const wasThere = attendedDates.has(p.showdate)
        ? '<span class="p-there" title="You marked that you were at this show">🎟 there</span>' : '';
      wrap.appendChild(el('div', 'p-histrow', `<b>${esc(fmtDate(p.showdate))}</b>${wasThere} · ${p.type} · ${line}`));
      // Redraw the setlist the way it was built, scored pick by pick. Only for results
      // carrying rows — anything graded before this shipped keeps the summary line alone.
      if (p.type === 'setlist' && b?.rows) wrap.appendChild(scoredSetlist(b));
    }
  }

  // ---------- leaderboard ----------
  //
  // Scoped to the game you are in and opened from that game's Actions menu — the same shape
  // as the scoring rules, for the same reasons. It was briefly a fourth tab, which cost a
  // permanent slot in the one row a phone can least afford, for something read occasionally.
  // Before that it was buried at the foot of My History, which is the burial this undid.
  //
  // Per game rather than one combined board because setlist points and bingo scores are
  // separate scales that are never merged (see the ORDER BY in worker.mjs). One board had to
  // pick a scale to rank by and then print the other one beside it, which reads as a single
  // ranking with a stray number attached. Two boards, each ranked by the game it belongs to.
  //
  // Signed out is a first-class state here, not a bounce: the everyone scope is open by
  // design (see the route in worker.mjs), and a visitor who can see the standings before
  // registering is being shown the reason to.
  //
  // GAME is 'setlist' or 'bingo' — the mode the panel was opened from, not a user choice.
  // FIXEDSCOPE pins the board to one scope and drops the picker — the crew page's boards
  // are the crew's by definition, and a picker there would be a way to leave the room
  // while standing in it. Pinning goes through leaderboardScope rather than around it, so
  // opening the in-game standings later lands on the crew you were just looking at.
  async function renderLeaderboard(game, wrap, fixedScope) {
    if (fixedScope) leaderboardScope = fixedScope;
    // The friend count comes along because an empty Friends board has two completely
    // different causes — nobody to compare against, or nobody graded yet — and only one of
    // them is something the reader can act on.
    const [groups, friends] = user
      ? await Promise.all([
        api('/api/groups').then(j => j.groups).catch(() => []),
        api('/api/friends').then(j => j.friends).catch(() => []),
      ])
      : [[], []];
    // A scope that needs a session cannot be offered without one, and the stored scope may
    // be left over from before a sign-out — falling back keeps the view from opening on a
    // 401 it cannot explain.
    if (!user) leaderboardScope = 'everyone';

    // Everything that differs between the two boards, in one place. Both scales are
    // averages of that game's graded predictions, so neither can be compared to the other
    // and neither is printed on the other's board.
    const G = game === 'bingo'
      ? {
        name: 'Phish Bingo',
        played: u => (u.bingoScored || 0) > 0,
        rank: (a, b) => (b.bingoScore ?? -1) - (a.bingoScore ?? -1) || (b.bingos || 0) - (a.bingos || 0),
        line: u => `${u.bingoScore} avg over ${u.bingoScored}`
          + (u.bingos ? ` · ${u.bingos} BINGO${u.bingos > 1 ? 's' : ''} 🍩` : ''),
      }
      : {
        name: 'Setlist Bets',
        played: u => (u.setlistScored || 0) > 0,
        rank: (a, b) => (b.setlistPoints ?? -1) - (a.setlistPoints ?? -1)
          || (b.setlistScored || 0) - (a.setlistScored || 0),
        line: u => `${u.setlistPoints} pts over ${u.setlistScored}`,
      };

    const profilePanel = el('div');
    // Names the game, because this panel is now reachable from two places that look alike
    // and the numbers below mean different things in each.
    wrap.appendChild(el('div', 'setlabel', `${G.name} standings — click a name for their profile`));
    const scopeRow = el('div', 'p-modes');
    const boardHost = el('div');
    const scopes = user
      ? [['everyone', 'Everyone'], ['friends', 'Friends'], ...groups.map(g => [`group:${g.id}`, g.name])]
      : [['everyone', 'Everyone']];
    wrap.appendChild(scopeRow);
    wrap.appendChild(boardHost);

    async function drawBoard() {
      scopeRow.innerHTML = '';
      if (!fixedScope) {
        for (const [key, label] of scopes) {
          const b = el('button', 'p-mode' + (leaderboardScope === key ? ' active' : ''), esc(label));
          b.addEventListener('click', () => { leaderboardScope = key; drawBoard(); });
          scopeRow.appendChild(b);
        }
      }
      boardHost.innerHTML = '';
      let board;
      try {
        board = await api(`/api/leaderboard?scope=${encodeURIComponent(leaderboardScope)}`);
      } catch (e) {
        // A group can vanish (deleted, or you were removed) while the selector still
        // lists it — fall back rather than leaving the panel empty and unexplained.
        boardHost.appendChild(el('div', 'hint', e.message));
        return;
      }
      // The API ranks by setlist points because that is the main game, so the bingo board
      // has to re-rank client-side rather than print a setlist ordering under a bingo
      // heading. Filtered as well as sorted: somebody with only setlist scores is not last
      // at bingo, they are absent from it.
      const played = board.filter(G.played).sort(G.rank);

      if (!played.length) {
        // Day one is the moment somebody decides whether this is worth a month of their
        // attention, and it used to read "scores appear once a show is graded" — a wait
        // instruction — to a person whose actual problem is that they have no friends here
        // yet. These are four different causes and only some have anything to act on.
        const grp = leaderboardScope.startsWith('group:')
          ? groups.find(g => `group:${g.id}` === leaderboardScope) : null;
        let msg;
        if (leaderboardScope === 'friends' && !friends.length) {
          msg = 'Nobody here yet. Share an invite link from ☰ and this turns into '
            + 'you against them.';
        } else if (grp && grp.memberCount <= 1) {
          msg = `${grp.name} is just you so far — share a link for it from the Friends menu `
            + 'and whoever opens it joins the group.';
        } else if (board.length) {
          // People are here and graded, just not at this game. Saying "nobody has a scored
          // prediction" here would be flatly untrue and readable as a bug.
          msg = `No ${G.name} scores here yet. The other game’s points are their own thing.`;
        } else if (leaderboardScope === 'everyone') {
          msg = `No ${G.name} scores yet — the first show settles that.`;
        } else {
          msg = `No ${G.name} scores here yet — they post after the encore.`;
        }
        boardHost.appendChild(el('div', 'hint', msg));
        return;
      }
      // Attendance across this scope, for the show most of them predicted.
      const attended = played.filter(u => u.showsAttended > 0).length;
      if (leaderboardScope !== 'everyone' && attended) {
        boardHost.appendChild(el('div', 'hint',
          `🎟 ${attended} of ${played.length} here have marked shows they attended.`));
      }
      played.forEach((u, i) => {
        const att = u.showsAttended ? ` · 🎟 ${u.showsAttended}` : '';
        const me = user && u.handle === user.handle ? ' p-boardrow-me' : '';
        const row = el('div', 'p-histrow p-boardrow' + me,
          `#${i + 1} <span class="p-avatar">${esc(avatarOf(u))}</span> <b>${esc(displayName(u))}</b> — `
          + esc(G.line(u)) + att);
        row.addEventListener('click', () => showPublicProfile(profilePanel, u.handle));
        boardHost.appendChild(row);
      });
    }
    await drawBoard();
    wrap.appendChild(profilePanel);
  }

  // ---------- wombat ----------
  //
  // The rules live in WOMBAT.md; the one-line version: rank up to 10 songs, the highest
  // rank across the crew owns a song, exact ties nullify the tied players and the song
  // cascades to the next unique claim, your top 5 survivors are your card, 1 point each
  // when played. Resolution is a property of (show, crew) — computed here at read time,
  // never stored — which is why this function is deliberately self-contained and pure:
  // test/wombat.test.mjs extracts it from this file by source and runs fixtures against
  // it directly, so it must not reach for anything in the enclosing closure.
  function resolveWombat(entries) {
    // entries: [{ handle, slugs: [slug, ...] }] in each player's rank order.
    const claims = new Map(); // slug -> [{handle, rank}]
    for (const e of entries) {
      (e.slugs || []).forEach((slug, rank) => {
        if (!claims.has(slug)) claims.set(slug, []);
        claims.get(slug).push({ handle: e.handle, rank });
      });
    }
    const owners = {};      // slug -> handle
    const outbid = {};      // slug -> [handles who claimed it and lost]
    const nullified = {};   // slug -> [handles who tied each other out]
    const dead = [];        // every level tied out
    for (const [slug, cs] of claims) {
      const byRank = new Map();
      for (const c of cs) { if (!byRank.has(c.rank)) byRank.set(c.rank, []); byRank.get(c.rank).push(c.handle); }
      const levels = [...byRank.keys()].sort((a, b) => a - b);
      const ties = [];
      let owner = null;
      for (const lv of levels) {
        const atLevel = byRank.get(lv);
        if (atLevel.length === 1) { owner = atLevel[0]; break; }
        ties.push(...atLevel);
      }
      if (owner) {
        owners[slug] = owner;
        const losers = cs.map(c => c.handle).filter(h => h !== owner);
        if (losers.length) outbid[slug] = losers;
        if (ties.length) nullified[slug] = ties;
      } else {
        dead.push(slug);
        nullified[slug] = ties;
      }
    }
    // Card: your owned songs in YOUR rank order, top 5. Inherited songs arrive at your
    // own rank, which is what keeps low-balling a consolation rather than a jackpot.
    const cards = {};
    for (const e of entries) {
      cards[e.handle] = (e.slugs || []).filter(slug => owners[slug] === e.handle).slice(0, 5);
    }
    return { owners, outbid, nullified, dead, cards };
  }

  // ---------- superlatives (SOCIAL-PLAN.md, Phase 4) ----------
  //
  // Auto-awarded titles from a scored show. Derived, never stored: every input is already
  // on screen at reveal time, so this needed no migration, no route and no cron work — it
  // is arithmetic over what the recap is showing anyway.
  //
  // Pure and self-contained for the same reason resolveWombat is: test/superlatives.test.mjs
  // extracts it from this file by source and runs fixtures against it, so it must not
  // reach into the enclosing closure.
  //
  // Every award can be SHARED. Inventing a tiebreak to force a single winner would mean
  // handing one of two identical performances a title and the other nothing, which is a
  // worse outcome than two people both being Bustout Prophet. Handles are sorted so the
  // same show always produces the same order.
  //
  // All five are positive. A wooden spoon was considered and cut: night one at Dick's is
  // the first time most of the crew will see any of this, and the newest player is the
  // likeliest to score zero.
  function computeSuperlatives(players, ctx) {
    // players: [{ handle, calls: [slug], hits: [slug], encorePlaced: [slug] }]
    // ctx: { gapOf: {slug: gap}, callCount: {slug: n}, crewSize: n, nameOf: {slug: name} }
    const { gapOf = {}, callCount = {}, crewSize = 0, nameOf = {} } = ctx || {};
    const named = slug => nameOf[slug] || slug;
    const out = [];
    const award = (key, emoji, title, handles, detail) => {
      if (handles.length) out.push({ key, emoji, title, handles: [...handles].sort(), detail });
    };

    // 🔮 Bustout Prophet — called the most overdue song that actually played. The 31-show
    // floor is the app's own definition of a bustout (bustTier), not a new one: a title
    // for calling something that was due next week would be a title for nothing.
    let bestGap = 0;
    let bestSlug = null;
    for (const p of players) {
      for (const slug of p.hits) {
        const gap = gapOf[slug] || 0;
        if (gap >= 31 && gap > bestGap) { bestGap = gap; bestSlug = slug; }
      }
    }
    if (bestSlug) {
      award('bustout', '🔮', 'Bustout Prophet',
        players.filter(p => p.hits.includes(bestSlug)).map(p => p.handle),
        `${named(bestSlug)} — ${bestGap} shows`);
    }

    // 🐺 Lone Wolf — hit something nobody else in the crew called. Every qualifying player
    // gets it; they each did the same rare thing on a different song.
    const wolves = new Map();
    for (const p of players) {
      for (const slug of p.hits) {
        if (callCount[slug] === 1 && p.calls.includes(slug)) {
          if (!wolves.has(p.handle)) wolves.set(p.handle, slug);
        }
      }
    }
    if (wolves.size) {
      const only = [...new Set([...wolves.values()])];
      award('lonewolf', '🐺', 'Lone Wolf', [...wolves.keys()],
        only.length === 1 ? named(only[0]) : `${only.length} calls nobody else made`);
    }

    // 🎯 Sharpshooter — best hit rate. The five-call floor is what stops a single lucky
    // pick from outranking a full card: one-for-one is 100% and means nothing.
    const eligible = players.filter(p => p.calls.length >= 5 && p.hits.length > 0);
    if (eligible.length) {
      const rate = p => p.hits.length / p.calls.length;
      const best = Math.max(...eligible.map(rate));
      award('sharp', '🎯', 'Sharpshooter',
        eligible.filter(p => rate(p) === best).map(p => p.handle),
        `${Math.round(best * 100)}% of their calls played`);
    }

    // 🎪 Encore Whisperer — put a song in the encore and the band put it there too.
    const whisperers = players.filter(p => p.encorePlaced.length > 0);
    if (whisperers.length) {
      const most = Math.max(...whisperers.map(p => p.encorePlaced.length));
      const top = whisperers.filter(p => p.encorePlaced.length === most);
      award('encore', '🎪', 'Encore Whisperer', top.map(p => p.handle),
        most === 1 ? named(top[0].encorePlaced[0]) : `${most} encore songs, in the encore`);
    }

    // 📋 Chalk Artist — most calls that half the crew or more also made. Needs three
    // players to mean anything: in a duo "consensus" is just the two of you agreeing.
    if (crewSize >= 3) {
      const threshold = Math.ceil(crewSize / 2);
      const chalkOf = p => p.calls.filter(s => (callCount[s] || 0) >= threshold).length;
      const most = Math.max(...players.map(chalkOf), 0);
      if (most > 0) {
        award('chalk', '📋', 'Chalk Artist',
          players.filter(p => chalkOf(p) === most).map(p => p.handle),
          `${most} calls the crew agreed on`);
      }
    }
    return out;
  }

  function renderWombatBuilder() {
    const usedSlugs = () => new Set(wombatRanks.map(s => s.slug));

    const randomizeWombat = () => {
      wombatRanks = randomSongs(WOMBAT_LIST_SIZE, new Set());
      render();
    };
    const fillWombatFromModel = () => {
      wombatRanks = lensRanking().slice(0, WOMBAT_LIST_SIZE).map(s => ({ slug: s.slug, name: s.name }));
      appliedFill = { mode: 'wombat', label: fillLabel(), snap: wombatSnap(wombatRanks) };
      render();
      if (!lensIsDefault()) flash(`Filled from ${lensArm().label}.`);
    };

    // The whole pitch, one line, above the builder — this game is new to everyone and
    // its one non-obvious idea is that rank buys ownership across the crew.
    mount.appendChild(el('div', 'hint',
      'Ten songs, ranked. Beat your crew’s rank on a song and it’s yours alone — tie '
      + 'exactly and you both lose it. Your top five survivors ride. A point each if they '
      + 'play it.'));

    const controls = el('div', 'p-row p-controls');
    if (wombatRanks.length > 0) {
      const save = el('button', 'p-btn', user ? 'Bag it, Tag it'
        : probablyHasAccount() ? 'Sign in to save' : 'Sign up to save');
      save.addEventListener('click', () => requireAuth('Save your Wombat ranks:', async () => {
        try {
          await api('/api/predictions', 'POST', { showdate, type: 'wombat', payload: { ranks: wombatRanks } });
          savedWombat = { payload: { ranks: JSON.parse(JSON.stringify(wombatRanks)) } };
          flash('Saved.');
          window.KalphishiRig?.peak();
          render();
        } catch (e) { flash(e.message, true); }
      }));
      controls.appendChild(save);
    }
    const pick = el('button', 'p-btn' + (wombatRanks.length ? ' p-btn-alt' : ''), '✨ Ask Diego?');
    pick.title = 'Roll a random ranked 10 — press again for a different one';
    pick.addEventListener('click', () => { window.KalphishiRig?.strobe(); randomizeWombat(); });
    controls.appendChild(pick);

    const wombatDiffers = () => {
      const saved = savedWombat?.payload?.ranks;
      if (!saved) return false;
      if (saved.length !== wombatRanks.length) return true;
      return saved.some((s, i) => s.slug !== wombatRanks[i].slug);
    };
    const reloadItem = savedWombat && wombatDiffers()
      ? [['↩ Reload last save', () => {
        wombatRanks = JSON.parse(JSON.stringify(savedWombat.payload.ranks));
        render();
        flash('Reloaded your last saved ranks.');
      }]]
      : [];
    controls.appendChild(actionsMenu([
      [ourPredictionLabel(), fillWombatFromModel],
      ['🎲 Randomize', randomizeWombat],
      ...reloadItem,
      ['🧹 Clear the list', () => { wombatRanks = []; render(); }],
    ]));
    mount.appendChild(controls);

    // The ranked list. Same row anatomy as the setlist sets — handle, name, badges,
    // × — plus the rank number, which here IS the gameplay.
    const list = el('div', 'p-setlist wb-list');
    wombatRanks.forEach((s, i) => {
      const badges = bustChip(s.slug);
      const row = el('div', 'p-songrow',
        `<span class="wb-rank">${i + 1}</span>`
        + `<span class="p-songmain"><span>${esc(s.name)}</span></span>`
        + (badges.trim() ? `<span class="p-rowbadges">${badges}</span>` : ''));
      const handle = el('span', 'p-drag', '⋮⋮');
      handle.title = 'drag to reorder — rank decides who owns a song';
      row.prepend(handle);
      handle.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        try { handle.setPointerCapture(ev.pointerId); } catch { /* non-active id */ }
        dragState = { key: 'wombat', from: i };
        row.classList.add('dragging');
      });
      handle.addEventListener('pointermove', ev => {
        if (!dragState || dragState.key !== 'wombat') return;
        clearDropMarks(list);
        const t = dropTargetIn(list, ev.clientY);
        if (!t || t.idx === i) return;
        const target = list.querySelectorAll('.p-songrow')[t.idx];
        if (target) target.classList.add(t.after ? 'drop-below' : 'drop-above');
      });
      handle.addEventListener('pointerup', ev => {
        if (!dragState || dragState.key !== 'wombat') return;
        const t = dropTargetIn(list, ev.clientY);
        clearDropMarks(list);
        row.classList.remove('dragging');
        const from = dragState.from;
        dragState = null;
        const to = resolveDropIndex(from, t);
        if (to !== from) wombatRanks = moveItem(wombatRanks, from, to);
        render();
      });
      handle.addEventListener('pointercancel', () => {
        dragState = null;
        clearDropMarks(list);
        row.classList.remove('dragging');
      });
      const x = el('button', 'p-x', '×');
      x.addEventListener('click', () => { wombatRanks.splice(i, 1); render(); });
      row.appendChild(x);
      list.appendChild(row);
    });
    mount.appendChild(list);
    if (wombatRanks.length < WOMBAT_LIST_SIZE) {
      mount.appendChild(el('div', 'p-cap', `${wombatRanks.length} of ${WOMBAT_LIST_SIZE}`));
      mount.appendChild(typeahead('add a song…', usedSlugs, s => { wombatRanks.push(s); render(); }));
    } else {
      mount.appendChild(el('div', 'p-cap', `${WOMBAT_LIST_SIZE} of ${WOMBAT_LIST_SIZE} — the list is full`));
    }
    mount.appendChild(el('div', 'hint',
      'Your #1 beats their #2. See how it shook out on your crew’s page after showtime.'));
  }

  // ---------- the crew page ----------
  //
  // The room (SOCIAL-PLAN.md, Phase 2). Everything a group IS lives here — status strip,
  // both boards, roster — while the drawer keeps management. Reached through goToCrew from
  // the drawer's group rows; renders in the same card the games own, the way History and
  // Profile do, so it needs no new mount and the tab bar correctly shows no game selected.
  //
  // Assembled from parts that already exist: the members route with its dots (Phase 1),
  // the group-scoped leaderboard (pinned via renderLeaderboard's fixedScope), and the
  // sealed-pick facts Phase 0 made safe to show. The only new server surface behind this
  // page is the rename route.
  async function renderCrew() {
    const wrap = el('div');
    mount.appendChild(wrap);
    if (!crewId) { wrap.appendChild(el('div', 'hint', 'Pick a crew from ☰ → Friends.')); return; }
    let groups = [], members = [];
    try {
      [groups, members] = await Promise.all([
        api(`/api/groups?showdate=${encodeURIComponent(showdate)}`).then(j => j.groups),
        api(`/api/groups/${encodeURIComponent(crewId)}/members?showdate=${encodeURIComponent(showdate)}`).then(j => j.members),
      ]);
    } catch (e) {
      wrap.appendChild(el('div', 'hint', esc(e.message)));
      return;
    }
    const g = groups.find(x => x.id === crewId);
    if (!g) {
      // Deleted, or you were removed, while a link to it was still on screen somewhere.
      wrap.appendChild(el('div', 'hint', 'That crew’s not there anymore.'));
      return;
    }

    // ---- name row. The owner's tools fold behind the same ⋮ the games use; renaming
    // happens inline in this row rather than in a prompt() nothing else in the app uses.
    const nameRow = el('div', 'crew-head');
    if (crewRenaming && g.isOwner) {
      const input = el('input', 'ta-input');
      input.value = g.name;
      input.maxLength = 40;
      const save = el('button', 'p-btn', 'Save');
      const cancel = el('button', 'p-btn p-btn-alt', 'Cancel');
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        save.disabled = true;
        try {
          await api(`/api/groups/${encodeURIComponent(crewId)}`, 'PATCH', { name });
          crewRenaming = false;
          render();
        } catch (e) { save.disabled = false; flash(e.message, true); }
      });
      cancel.addEventListener('click', () => { crewRenaming = false; render(); });
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') save.click(); });
      nameRow.appendChild(input); nameRow.appendChild(save); nameRow.appendChild(cancel);
    } else {
      nameRow.appendChild(el('span', 'crew-name',
        `<b>${esc(g.name)}</b> <span class="menu-stats">${g.memberCount} member${g.memberCount === 1 ? '' : 's'}</span>`));
      if (g.isOwner) {
        nameRow.appendChild(actionsMenu([
          ['✏️ Rename crew', () => { crewRenaming = true; render(); }],
          // Invites, adding and removing live in the drawer they always lived in — the
          // room links to the toolbox rather than duplicating it.
          ['👥 Invites & members', () => window.KalphishiMenu?.openFriends?.()],
        ]));
      }
    }
    wrap.appendChild(nameRow);

    // ---- status strip: the emotional center pre-lock. Counts anyone with either game
    // saved; the bar and the copy both flip when the show locks.
    const inFor = members.filter(m => m.setlist || m.bingo || m.wombat).length;
    const day = new Date(showdate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    const L = lockInfo();
    const strip = el('div', 'crew-strip');
    const stripLine = L.locked
      ? `<b>${inFor} of ${members.length}</b> got in — envelopes are open`
      : `<b>${inFor} of ${members.length}</b> in for ${esc(day)}`
        + (L.known ? ` · locks in <b>${untilText(L.at - Date.now())}</b>` : '');
    strip.appendChild(el('div', 'crew-strip-txt', stripLine));
    const bar = el('div', 'crew-bar');
    const fill = el('i');
    fill.style.width = `${members.length ? Math.round((inFor / members.length) * 100) : 0}%`;
    bar.appendChild(fill);
    strip.appendChild(bar);
    // Live-night presence: who is at the show right now, ticking squares. Only while the
    // show is locked and ungraded — before the downbeat there is nothing to check off,
    // and once it is scored everybody has gone home.
    const liveLine = el('div', 'crew-live');
    strip.appendChild(liveLine);
    // Wombat has no board below like the other two — its score stays null by design
    // (WOMBAT.md), resolved fresh per crew at the reveal, never aggregated across shows.
    // So instead of a standings tab it can't support, this is the one thing worth saying
    // pre-lock: how many of us are even in. The full draft — who owns what, the steals,
    // what got cancelled out — still lands in the reveal below once the lock opens it.
    if (!L.locked) {
      const wombatIn = members.filter(m => m.wombat).length;
      if (wombatIn) {
        strip.appendChild(el('div', 'crew-strip-sub', `${wombatIn} of ${members.length} have a Wombat pick in`));
      }
    }
    wrap.appendChild(strip);

    // The line appears only when somebody actually is live, which means the fifteen-minute
    // window doubles as the "is this happening right now" test — no separate check for
    // whether the show has ended, and nothing to say when there is nothing happening.
    const paintPresence = list => {
      const live = list.filter(m => m.live);
      liveLine.style.display = live.length ? '' : 'none';
      liveLine.innerHTML = live.length
        ? `<span class="live-pulse"></span> <b>${live.length} of ${list.length}</b> checking squares right now`
        : '';
    };
    paintPresence(members);

    // Poll only on a show that is locked and RECENT. Without the 24h bound this would sit
    // polling on any locked show in history, forever, for a line that can never appear.
    const tonight = L.known && L.locked && (Date.now() - L.at) < 24 * 3600 * 1000;
    if (tonight) {
      const signature = list => list.filter(m => m.live).map(m => m.handle).sort().join(',');
      const before = signature(members);
      livePollTimer = setInterval(async () => {
        // A backgrounded tab is not watching anything. Skipping rather than tearing down
        // means it resumes on its own when the phone comes back out of a pocket.
        if (document.visibilityState === 'hidden') return;
        try {
          const fresh = (await api(
            `/api/groups/${encodeURIComponent(crewId)}/members?showdate=${encodeURIComponent(showdate)}`)).members;
          // Only redraw the page when WHO is live actually changed — the roster rows carry
          // pulses too, so a change needs a full render, and an unchanged crew should cost
          // nothing on screen.
          if (signature(fresh) !== before) render();
          else paintPresence(fresh);
        } catch { /* a dropped poll is just a dropped poll; the next one is 45s away */ }
      }, LIVE_POLL_MS);
    }

    // ---- reveal night (SOCIAL-PLAN.md, Phase 3). At the lock the page flips: everyone's
    // calls, compared. Reads the same predictions route everything else reads — Phase 0
    // opens crewmates' payloads at the lock, so there is deliberately NO new server
    // surface here; a sealed row simply has no payload and drops out of every count.
    // Consensus and overlap are computed here in the client over at most a few hundred
    // slugs, which is the whole reason the seal could stay the only server rule.
    // The reveal hands back the superlatives so the roster can wear them; nothing else
    // needs them, and recomputing per row would repeat the whole show's arithmetic once
    // per member.
    const supers = L.locked ? (await renderReveal(wrap, members)) || [] : [];
    const wonBy = new Map();
    for (const sup of supers) {
      for (const h of sup.handles) wonBy.set(h, [...(wonBy.get(h) || []), sup]);
    }

    // ---- the two boards. Never merged; the tab pair mirrors the game tabs above and the
    // board itself is the standings panel pinned to this crew.
    const tabs = el('div', 'p-modes crew-tabs');
    for (const [key, label] of [['setlist', 'Setlist pts'], ['bingo', 'Bingo']]) {
      const b = el('button', 'p-mode' + (crewBoardGame === key ? ' active' : ''), label);
      b.addEventListener('click', () => { crewBoardGame = key; render(); });
      tabs.appendChild(b);
    }
    wrap.appendChild(tabs);
    const boardHost = el('div');
    wrap.appendChild(boardHost);
    renderLeaderboard(crewBoardGame, boardHost, `group:${crewId}`);

    // ---- roster. Same facts as the drawer's Phase 1 list, in the room they describe:
    // dots for the open show, a sealed pill for anyone already in (their pick exists and
    // nobody can see it until the lock — that is the Phase 0 guarantee, worn as a badge),
    // and a tap opens the same public profile the boards open.
    wrap.appendChild(el('div', 'setlabel crew-roster-label', 'The crew'));
    const profilePanel = el('div');
    for (const mem of members) {
      const row = el('div', 'p-histrow crew-member',
        `<span class="p-avatar">${esc(mem.profile.avatar || '🎣')}</span> <b>${esc(mem.name)}</b> ` +
        `<span class="menu-stats">@${esc(mem.handle)}${mem.isOwner ? ' 👑' : ''}</span>`);
      const right = el('span', 'crew-member-right');
      // Present right now, ticking squares. Sits ahead of the titles because it is the
      // only thing on this row that is true THIS SECOND.
      if (mem.live) {
        const dot = el('span', 'live-pulse');
        dot.title = 'Checking squares right now';
        dot.setAttribute('aria-label', 'at the show now');
        right.appendChild(dot);
      }
      // Titles first — they are the only thing on this row that took doing.
      for (const sup of wonBy.get(mem.handle) || []) {
        const chip = el('span', 'sup-chip', `${sup.emoji} ${esc(sup.title)}`);
        chip.title = sup.detail;
        right.appendChild(chip);
      }
      if (!L.locked && (mem.setlist || mem.bingo || mem.wombat)) {
        const pill = el('span', 'm-chip-seal', 'sealed 🔒');
        pill.title = 'They’re in — their pick exists, and nobody sees it until the show locks.';
        right.appendChild(pill);
      }
      right.appendChild(el('span', 'grp-dots',
        `<span class="grp-dot${mem.setlist ? '' : ' off'}" title="setlist ${mem.setlist ? 'saved' : 'not saved'}"></span>` +
        `<span class="grp-dot${mem.bingo ? '' : ' off'}" title="bingo ${mem.bingo ? 'saved' : 'not saved'}"></span>` +
        `<span class="grp-dot${mem.wombat ? '' : ' off'}" title="wombat ${mem.wombat ? 'saved' : 'not saved'}"></span>`));
      row.appendChild(right);
      row.addEventListener('click', () => showPublicProfile(profilePanel, mem.handle));
      wrap.appendChild(row);
    }
    wrap.appendChild(el('div', 'hint', 'Who’s in for ' + esc(day) + '. Tap a name for their record.'));
    wrap.appendChild(profilePanel);
  }

  // ---------- reveal night ----------
  //
  // Three moments, all driven by the lock state the server computes: sealed chips before
  // (the roster's job), this comparison at the lock, and the scored recap once the cron
  // grades the show. A member's "calls" are the union of their setlist songs and bingo
  // squares — the two games never merge as SCORES, but a call is a call when the question
  // is "who believed in this song".
  async function renderReveal(wrap, members) {
    let preds = [];
    try { preds = await api(`/api/predictions?showdate=${encodeURIComponent(showdate)}`); }
    catch { return; } // the boards and roster below still render
    const memberByHandle = new Map(members.map(m => [m.handle, m]));
    // Crew rows with payloads only. The route returns every predictor for the date;
    // strangers are not in the crew, and a sealed row (no payload key) counts nobody.
    const open = preds.filter(p => memberByHandle.has(p.userHandle) && p.payload);
    if (!open.length) return;

    // handle -> Set of called slugs; slug -> display name; slug -> Set of hit statuses.
    const calls = new Map();
    const nameOf = new Map();
    const hitSlugs = new Set(); // from scored results — empty until the cron grades
    // Wombat rows stay OUT of the chalk and overlap counts — ownership is its own
    // section below, and counting a ranked list as "calls" would double-speak a song
    // the resolution says someone else owns. Their names and played-facts still feed in.
    const wombatEntries = [];
    // Per player, for the superlatives: what they called, what of it played, and which
    // encore songs they put in the encore and got right. Kept alongside the crew-wide
    // sets rather than derived from them later, because "did THIS person hit this song"
    // is not recoverable from a union once the loop has moved on.
    const perPlayer = new Map();
    const statsFor = h => {
      if (!perPlayer.has(h)) perPlayer.set(h, { handle: h, calls: new Set(), hits: new Set(), encorePlaced: new Set() });
      return perPlayer.get(h);
    };
    for (const p of open) {
      const mine = statsFor(p.userHandle);
      if (p.type === 'wombat') {
        const ranks = p.payload.ranks || [];
        for (const r of ranks) if (r && r.slug && !nameOf.has(r.slug)) nameOf.set(r.slug, r.name);
        wombatEntries.push({ handle: p.userHandle, slugs: ranks.map(r => r.slug), result: p.result });
        if (p.result?.played) {
          for (const [slug, hit] of Object.entries(p.result.played)) {
            if (hit) { hitSlugs.add(slug); mine.hits.add(slug); }
          }
        }
        continue;
      }
      const set = calls.get(p.userHandle) || new Set();
      const add = s => {
        if (s && s.slug) {
          set.add(s.slug); mine.calls.add(s.slug);
          if (!nameOf.has(s.slug)) nameOf.set(s.slug, s.name);
        }
      };
      if (p.type === 'setlist') for (const k of ['set1', 'set2', 'encore']) (p.payload[k] || []).forEach(add);
      else (p.payload.grid || []).filter(Boolean).forEach(add);
      calls.set(p.userHandle, set);
      if (p.result) {
        // rows live under `breakdown`, NOT on the result itself: scoreSetlistPrediction
        // keeps hits/stressors at the top level so predictions graded under the old
        // scheme still render, and puts everything newer inside breakdown. Reading
        // p.result.rows here was a silent no-op that shipped in Phase 3 — no setlist hit
        // ever reached hitSlugs, so the reveal's tick marks only ever came from bingo and
        // wombat. Found by pointing the superlatives at real scored data: Sharpshooter
        // reported 67% for a player who had hit five of six.
        if (p.type === 'setlist' && p.result.breakdown?.rows) {
          for (const k of ['set1', 'set2', 'encore']) {
            for (const r of p.result.breakdown.rows[k] || []) {
              if (r.status === 'miss') continue;
              hitSlugs.add(r.slug); mine.hits.add(r.slug);
              // 'placed' in the encore means the song was called AND landed in the
              // encore — the hardest slot in the game to get right.
              if (k === 'encore' && r.status === 'placed') mine.encorePlaced.add(r.slug);
            }
          }
        } else if (p.type === 'bingo' && p.result.checked && p.payload.grid) {
          p.result.checked.forEach((hit, i) => {
            if (hit && p.payload.grid[i]) { hitSlugs.add(p.payload.grid[i].slug); mine.hits.add(p.payload.grid[i].slug); }
          });
        }
      }
    }
    const callers = [...calls.keys()];
    const scored = open.filter(p => p.result);

    let supers = [];
    const card = el('div', 'crew-reveal');
    card.appendChild(el('div', 'setlabel', scored.length ? `The reveal — scored` : 'The reveal'));

    // ---- the chalk: what half or more of the crew called. Two callers minimum — a
    // "consensus" of one person agreeing with themselves is just their pick twice.
    const counts = new Map();
    for (const set of calls.values()) for (const slug of set) counts.set(slug, (counts.get(slug) || 0) + 1);
    if (callers.length >= 2) {
      const threshold = Math.max(2, Math.ceil(callers.length / 2));
      const chalk = [...counts].filter(([, n]) => n >= threshold)
        .sort((a, b) => b[1] - a[1] || nameOf.get(a[0]).localeCompare(nameOf.get(b[0])))
        .slice(0, 10);
      if (chalk.length) {
        card.appendChild(el('div', 'crew-reveal-h', 'The chalk'));
        for (const [slug, n] of chalk) {
          card.appendChild(el('div', 'crew-reveal-row',
            `<span>${hitSlugs.has(slug) ? '✅ ' : ''}${esc(nameOf.get(slug))}</span>`
            + `<span class="menu-stats">${n} of ${callers.length}</span>`));
        }
      }
    }

    // ---- sole calls: the bragging-rights rows. Post-scoring, a sole call that HIT leads
    // the list with the trophy — that is the whole reason anyone scrolls here after.
    const soles = [...counts].filter(([, n]) => n === 1)
      .map(([slug]) => ({ slug, who: callers.find(h => calls.get(h).has(slug)), hit: hitSlugs.has(slug) }))
      .sort((a, b) => (b.hit - a.hit) || nameOf.get(a.slug).localeCompare(nameOf.get(b.slug)))
      .slice(0, 12);
    if (soles.length && callers.length >= 2) {
      card.appendChild(el('div', 'crew-reveal-h', 'Sole calls'));
      for (const s of soles) {
        card.appendChild(el('div', 'crew-reveal-row',
          `<span>${s.hit ? '🏆 ' : ''}${esc(nameOf.get(s.slug))}</span>`
          + `<span class="menu-stats">only @${esc(s.who)}${s.hit ? ' — and it played' : ''}</span>`));
      }
    }

    // ---- your overlap, only when you are one of the callers.
    if (user && calls.has(user.handle)) {
      const mine = calls.get(user.handle);
      const rows = callers.filter(h => h !== user.handle)
        .map(h => ({ h, n: [...calls.get(h)].filter(s => mine.has(s)).length }))
        .sort((a, b) => b.n - a.n);
      if (rows.length) {
        card.appendChild(el('div', 'crew-reveal-h', 'Your overlap'));
        for (const r of rows) {
          card.appendChild(el('div', 'crew-reveal-row',
            `<span>@${esc(r.h)}</span><span class="menu-stats">${r.n} shared call${r.n === 1 ? '' : 's'}</span>`));
        }
      }
    }

    // ---- the recap, once the cron has graded. Per game because the scales never merge:
    // setlist points and bingo hits each name their own top scorer, and the averages are
    // labelled with the game they average.
    if (scored.length) {
      card.appendChild(el('div', 'crew-reveal-h', 'How it went'));
      const sl = scored.filter(p => p.type === 'setlist');
      const bg = scored.filter(p => p.type === 'bingo');
      if (sl.length) {
        const top = sl.reduce((a, b) => (b.result.score > a.result.score ? b : a));
        const avg = (sl.reduce((t, p) => t + p.result.score, 0) / sl.length).toFixed(1);
        card.appendChild(el('div', 'crew-reveal-row',
          `<span>🏆 Setlist: <b>@${esc(top.userHandle)}</b> — ${top.result.score} pts</span>`
          + `<span class="menu-stats">crew avg ${avg}</span>`));
      }
      if (bg.length) {
        const top = bg.reduce((a, b) => (b.result.hitCount > a.result.hitCount ? b : a));
        card.appendChild(el('div', 'crew-reveal-row',
          `<span>🏆 Bingo: <b>@${esc(top.userHandle)}</b> — ${top.result.hitCount}/24${top.result.bingo ? ' · BINGO 🍩' : ''}</span>`
          + `<span class="menu-stats">${bg.length} card${bg.length === 1 ? '' : 's'}</span>`));
      }
      card.appendChild(el('div', 'hint', 'Tap a name below for their card.'));
    }

    // ---- superlatives. Scored shows only: every one of them is a statement about what
    // actually played, and awarding "Sharpshooter" before the encore would be a guess
    // wearing a trophy.
    if (scored.length) {
      const gapOf = {};
      for (const slug of nameOf.keys()) { const g = meta[slug]?.gap; if (g != null) gapOf[slug] = g; }
      const callCount = {};
      for (const [slug, n] of counts) callCount[slug] = n;
      supers = computeSuperlatives(
        [...perPlayer.values()].map(v => ({
          handle: v.handle,
          calls: [...v.calls],
          hits: [...v.hits],
          encorePlaced: [...v.encorePlaced],
        })),
        { gapOf, callCount, crewSize: members.length, nameOf: Object.fromEntries(nameOf) });
      if (supers.length) {
        card.appendChild(el('div', 'crew-reveal-h', 'Superlatives'));
        for (const s of supers) {
          card.appendChild(el('div', 'crew-reveal-row',
            `<span><span class="sup-chip">${s.emoji} ${esc(s.title)}</span> `
            + `${s.handles.map(h => '<b>@' + esc(h) + '</b>').join(', ')}</span>`
            + `<span class="menu-stats">${esc(s.detail)}</span>`));
        }
      }
    }

    // ---- Wombat: the draft results (WOMBAT.md). Resolution is computed HERE, per
    // crew, from the sealed lists the lock just opened — never stored, because the same
    // global list resolves differently in every crew. Needs two players to be a game.
    if (wombatEntries.length >= 2) {
      const W = resolveWombat(wombatEntries);
      const playedByOwner = new Map(wombatEntries.map(e => [e.handle, e.result?.played || null]));
      const anyScored = wombatEntries.some(e => e.result?.played);
      card.appendChild(el('div', 'crew-reveal-h', 'Wombat — the draft'));
      for (const e of wombatEntries) {
        const mine = W.cards[e.handle] || [];
        const played = playedByOwner.get(e.handle);
        const pts = played ? mine.filter(slug => played[slug]).length : null;
        const songs = mine.length
          ? mine.map(slug => `${played && played[slug] ? '✅ ' : ''}${esc(nameOf.get(slug) || slug)}`).join(' · ')
          : '<i>everything contested away</i>';
        card.appendChild(el('div', 'crew-reveal-row',
          `<span><b>@${esc(e.handle)}</b> — ${songs}</span>`
          + `<span class="menu-stats">${pts != null ? `${pts} pt${pts === 1 ? '' : 's'}` : `${mine.length} song${mine.length === 1 ? '' : 's'}`}</span>`));
      }
      const steals = Object.entries(W.outbid).slice(0, 8);
      if (steals.length) {
        card.appendChild(el('div', 'crew-reveal-h', 'The steals'));
        for (const [slug, losers] of steals) {
          card.appendChild(el('div', 'crew-reveal-row',
            `<span>${esc(nameOf.get(slug) || slug)}</span>`
            + `<span class="menu-stats">@${esc(W.owners[slug])} over ${losers.map(h => '@' + esc(h)).join(', ')}</span>`));
        }
      }
      if (W.dead.length) {
        card.appendChild(el('div', 'crew-reveal-row',
          `<span>💀 Cancelled out</span>`
          + `<span class="menu-stats">${W.dead.map(slug => esc(nameOf.get(slug) || slug)).join(' · ')}</span>`));
      }
      if (!anyScored) card.appendChild(el('div', 'hint', 'Points post after the encore.'));
    }

    // ---- the share card. The group chat lives off-app by design (reach.md), so this
    // hands it something worth pasting.
    const share = el('button', 'p-btn crew-share', '📤 Share the card');
    share.addEventListener('click', () => shareRevealCard(members, { calls, counts, callers, nameOf, hitSlugs, scored, supers }));
    card.appendChild(share);
    wrap.appendChild(card);
    // Handed back so the roster below can chip each member with what they won — the
    // reveal renders first, and recomputing this per row would be the same arithmetic
    // done once per member instead of once per show.
    return supers;
  }

  // A pure-SVG summary rendered to PNG — no canvas library, no dependency, nothing
  // fetched. The chain is share-with-files → clipboard → download, tried in that order
  // because that is the order of "lands in the group chat with the fewest taps".
  // SVG→PNG goes through an <img> holding a data: URI drawn onto a canvas; every piece of
  // that is same-document, so no CORS taint. iOS Safari is the platform to re-verify if
  // this misbehaves — the plan flagged it, and the fallback chain is the mitigation.
  async function shareRevealCard(members, R) {
    const crewName = (document.querySelector('.crew-name b')?.textContent || 'The crew');
    const date = fmtDate(showdate);
    const lines = [];
    if (R.scored.length) {
      const sl = R.scored.filter(p => p.type === 'setlist');
      const bg = R.scored.filter(p => p.type === 'bingo');
      if (sl.length) {
        const top = sl.reduce((a, b) => (b.result.score > a.result.score ? b : a));
        lines.push(`Setlist: @${top.userHandle} · ${top.result.score} pts`);
      }
      if (bg.length) {
        const top = bg.reduce((a, b) => (b.result.hitCount > a.result.hitCount ? b : a));
        lines.push(`Bingo: @${top.userHandle} · ${top.result.hitCount}/24${top.result.bingo ? ' · BINGO' : ''}`);
      }
      const soleHit = [...R.counts].find(([slug, n]) => n === 1 && R.hitSlugs.has(slug));
      if (soleHit) {
        const who = R.callers.find(h => R.calls.get(h).has(soleHit[0]));
        lines.push(`Sole call that hit: ${R.nameOf.get(soleHit[0])} — only @${who}`);
      }
      // One superlative, not all five — the card is a boast for a group chat, and a
      // list of five awards is a table. Bustout Prophet leads because calling a song
      // nobody has heard in three years is the most interesting thing anyone did.
      const head = (R.supers || [])[0];
      if (head) lines.push(`${head.emoji} ${head.title}: @${head.handles.join(', @')} — ${head.detail}`);
    } else {
      const threshold = Math.max(2, Math.ceil(R.callers.length / 2));
      const chalk = [...R.counts].filter(([, n]) => n >= threshold).sort((a, b) => b[1] - a[1]).slice(0, 4);
      for (const [slug, n] of chalk) lines.push(`${R.nameOf.get(slug)} — ${n} of ${R.callers.length} called it`);
      if (!lines.length) lines.push(`${R.callers.length} sealed picks are open — come look`);
    }
    const escXml = s => String(s).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
    const W = 700, H = 130 + lines.length * 34;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#0d0d0d"/>
      <rect x="0" y="0" width="100%" height="6" fill="#a855f7"/>
      <text x="28" y="52" fill="#ffffff" font-family="system-ui,sans-serif" font-size="26" font-weight="600">${escXml(crewName)}</text>
      <text x="28" y="80" fill="#a8a69d" font-family="system-ui,sans-serif" font-size="15">${escXml(date)} · Bathtub Bets${R.scored.length ? ' · scored' : ' · the reveal'}</text>
      ${lines.map((l, i) => `<text x="28" y="${118 + i * 34}" fill="#d5d4c9" font-family="system-ui,sans-serif" font-size="18">${escXml(l)}</text>`).join('')}
    </svg>`;
    let canvas;
    try {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; });
      canvas = document.createElement('canvas');
      canvas.width = W * 2; canvas.height = H * 2; // 2x for retina chats
      canvas.getContext('2d').drawImage(img, 0, 0, W * 2, H * 2);
    } catch {
      flash('Could not build the share card here.', true);
      return;
    }
    // Delivery is a CHAIN, and every link fails independently into the next — the first
    // cut of this wrapped all three in one try, so a clipboard permission prompt the
    // browser declined didn't fall through to the download, it aborted the whole thing
    // and reported failure while holding a perfectly good PNG.
    const blob = await new Promise(ok => canvas.toBlob(ok, 'image/png'));
    if (blob) {
      const file = new File([blob], 'crew-reveal.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: crewName }); return; }
        catch (e) { if (e?.name === 'AbortError') return; /* sheet closed — a choice */ }
      }
      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          flash('Card copied — paste it in the chat.');
          return;
        } catch { /* permission denied — the download below still delivers */ }
      }
    }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'crew-reveal.png';
    a.click();
    flash('Card downloaded.');
  }

  function flash(msg, isErr) {
    const f = el('div', 'p-flash' + (isErr ? ' err' : ''), esc(msg));
    mount.appendChild(f);
    setTimeout(() => f.remove(), 2500);
  }

  // ---------- password reset links ----------
  // A /?reset=TOKEN link is opened by someone who by definition cannot sign in, so this
  // runs entirely outside the session. Unlike an invite the token is NOT stashed in
  // sessionStorage: there is no round trip to survive, and a credential-grade secret should
  // not outlive the tab it arrived in. It is stripped from the URL immediately so a refresh
  // or a screenshot of the address bar does not carry it further.
  let resetToken = (() => {
    const t = new URLSearchParams(location.search).get('reset');
    if (!t) return null;
    const clean = new URL(location.href);
    clean.searchParams.delete('reset');
    history.replaceState({}, '', clean);
    return t;
  })();

  function renderPasswordReset() {
    const box = el('div', 'p-login card');
    box.appendChild(el('div', 'setlabel', 'Set a new password'));
    box.appendChild(el('div', 'hint',
      'This link works once. Choose a password and then sign in with it.'));

    const pass = el('input', 'ta-input');
    pass.type = 'password'; pass.placeholder = 'new password';
    pass.autocomplete = 'new-password';
    const again = el('input', 'ta-input');
    again.type = 'password'; again.placeholder = 'new password again';
    again.autocomplete = 'new-password';
    const err = el('div', 'p-flash err');
    const btn = el('button', 'p-btn', 'Set password');

    async function go() {
      err.textContent = '';
      // Checked here as well as on the server: mistyping it twice is the common failure,
      // and spending the one use of the link to discover that would be a poor trade.
      if (pass.value !== again.value) { err.textContent = 'those two do not match'; return; }
      btn.disabled = true;
      try {
        await api('/api/password/reset', 'POST', { token: resetToken, newPassword: pass.value });
        // Burn it locally too, so a re-render cannot present a form for a spent token.
        resetToken = null;
        // The sign-in box only renders when nobody is signed in — and somebody can be, if
        // they opened a link minted for a different account. Without the flash that case
        // shows the form vanishing and nothing else, which reads as a failure rather than
        // as the success it is. The flash renders either way.
        authPrompt = user ? null : { tab: 'login', message: 'Password set — sign in with it now.', onAuthed: null };
        render();
        flash('Password set — sign in with the new password.');
      } catch (e) {
        btn.disabled = false;
        err.textContent = e.message;
      }
    }
    btn.addEventListener('click', go);
    for (const i of [pass, again]) i.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });

    const row = el('div', 'p-row');
    row.appendChild(pass); row.appendChild(again); row.appendChild(btn);
    box.appendChild(row);
    box.appendChild(err);
    mount.appendChild(box);
    pass.focus();
  }

  // ---------- invite links ----------
  // A /?invite=CODE link can be opened by someone who isn't signed in — and most will be,
  // since the whole point is sharing with people who don't have accounts yet. The code is
  // stashed so it survives the sign-in/registration round trip, then redeemed once there
  // is a session. Stripped from the URL either way so a refresh (or a shared screenshot
  // of the address bar) doesn't re-run it.
  const INVITE_KEY = 'kalphishi-pending-invite';

  function takePendingInvite() {
    const fromUrl = new URLSearchParams(location.search).get('invite');
    if (fromUrl) {
      try { sessionStorage.setItem(INVITE_KEY, fromUrl); } catch { /* private mode */ }
      const clean = new URL(location.href);
      clean.searchParams.delete('invite');
      history.replaceState({}, '', clean);
    }
    try { return sessionStorage.getItem(INVITE_KEY); } catch { return fromUrl; }
  }

  function clearPendingInvite() {
    try { sessionStorage.removeItem(INVITE_KEY); } catch { /* private mode */ }
  }

  async function redeemPendingInvite() {
    const code = takePendingInvite();
    if (!code) return;
    if (!user) {
      // Name the door before asking anyone to walk through it. The preview needs no
      // session precisely because the reader has no account yet; a dead link says so
      // here rather than after they have typed an email and a password, and either way
      // the form still opens — somebody who arrived through a friend's link is worth
      // signing up whether or not the link itself survived.
      let message = 'Sign in or create an account to accept this invite.';
      try {
        const inv = await api(`/api/invites/${encodeURIComponent(code)}/preview`);
        const who = `${inv.inviter.avatar} ${inv.inviter.name}`;
        message = inv.group
          ? `${who} invited you to ${inv.group.name}.`
          : `${who} invited you.`;
      } catch (e) {
        message = e.message || message;
      }
      // Hold it and ask them to sign in; redeem runs again after auth succeeds.
      authPrompt = { tab: 'register', message, onAuthed: null };
      render();
      return;
    }
    clearPendingInvite();
    try {
      const j = await api(`/api/invites/${encodeURIComponent(code)}/redeem`, 'POST', {});
      // Land them IN the crew rather than telling them about it. A flash is 2.5 seconds
      // and a phone mid-signup is the worst possible moment to spend them — keyboards
      // dismissing, password managers interrupting. The crew page is permanent, says the
      // same thing with a roster instead of a sentence, and turns a re-opened link into
      // a deep link instead of a silent no-op. The flash stays, now short enough to be
      // the confirmation rather than the whole explanation.
      if (j.group) {
        // Navigate FIRST, then flash. goToCrew re-renders, and render() empties the mount
        // the flash was just appended to — announcing before navigating destroys the
        // announcement on the very next tick. Caught live: the toast never appeared, and
        // the only evidence was its absence.
        menuActions.goToCrew(j.group.id);
        flash(j.already ? `Already in ${j.group.name}.` : `You're in ${j.group.name}.`);
      } else {
        flash(j.already ? `Already friends with ${j.friend.name}.` : `You and ${j.friend.name} are friends now.`);
      }
    } catch (e) {
      flash(e.message, true);
    }
  }

  // bootstrap: resolve session, then load any existing predictions
  api('/api/me')
    .then(j => { user = j.user; return loadExisting(); })
    .catch(() => { localStorage.removeItem('kalphish-user'); render(); })
    .then(() => redeemPendingInvite());

  // The page drives which game is showing; the predictor still owns history and profile.
  return {
    setMode(m) {
      if (mode === m) return;
      mode = m;
      // A menu left open on Bingo must not reappear over Setlist Bets.
      actionsOpen = false;
      render();
    },
    // Called when the approach changes in the Nerd Zone, so the header chip and what Our
    // Prediction would offer are redrawn. Nothing about a saved prediction moves.
    refresh() { render(); },
    getMode: () => mode,
  };
}
