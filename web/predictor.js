// Kalphishi user predictor: setlist builder + PHISH bingo + history.
// Called from index.html: initPredictor(containerEl, analysis)
function initPredictor(mount, A, opts = {}) {
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Date formatting is owned by index.html so both files render dates identically.
  // Resolved at call time (initPredictor runs after that script) and degrades to the raw
  // ISO string rather than throwing if it is somehow absent.
  const fmtDate = iso => (window.fmtDate ? window.fmtDate(iso) : String(iso ?? ''));
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
  // working state
  let build = { set1: [], set2: [], encore: [] };
  let grid = Array(25).fill(null);
  let locks = Array(25).fill(false); // build-mode only: locked squares survive Randomize
  let livePrediction = null; // saved bingo prediction being played live
  let bingoDeclared = false;
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
  // tabs are Phish Bingo and Set List Bets. The predictor still owns history and profile,
  // which the account menu reaches directly, so it reports back when it moves to one of
  // those and the page can surface the card whichever tab was selected.
  const notifyMode = () => { if (typeof opts.onModeChange === 'function') opts.onModeChange(mode); };

  const menuActions = {
    goTo(m) { mode = m; render(); notifyMode(); mount.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    async signOut() {
      await api('/api/logout', 'POST', {});
      user = null; authPrompt = null; attendedDates = new Set();
      render();
    },
    openLogin(tab) { authPrompt = { tab, message: null, onAuthed: null }; render(); },
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

  function requireAuth(message, onAuthed) {
    if (user) return onAuthed();
    authPrompt = { tab: 'login', message, onAuthed };
    render();
  }

  function render() {
    mount.innerHTML = '';
    if (window.KalphishiMenu) window.KalphishiMenu.update(user, menuActions);
    // The heading names the game being played. The tab already says which one, but the
    // card is scrolled to on its own from the account menu, where the tab bar is out of view.
    const HEADINGS = {
      bingo: 'PHISH Bingo <span class="hint">— five in a line, called before the show</span>',
      setlist: 'Set List Bets <span class="hint">— build your own call for the next show</span>',
      history: 'My history <span class="hint">— every prediction you have made</span>',
      profile: 'Profile',
    };
    mount.appendChild(el('h2', null, HEADINGS[mode] || HEADINGS.setlist));
    if (!user && authPrompt) renderAuthPanel();
    else if (window.KalphishiAuthModal) window.KalphishiAuthModal.hide();
    if (user && user.needsEmail) return renderLinkEmail();
    // Signing out of history or profile drops back to a game, and the page has to hear
    // about it or its tab bar would still be showing neither game selected.
    if (!user && (mode === 'history' || mode === 'profile')) { mode = 'setlist'; notifyMode(); }
    renderTopBar();
    const builderStart = mount.childElementCount;
    if (mode === 'setlist') renderSetlistBuilder();
    else if (mode === 'bingo') renderBingo();
    else if (mode === 'profile') renderProfile();
    else renderHistory();

    // Once the show starts, everything that edits or re-saves a prediction goes dead.
    // Scoped to the builder rather than the whole panel so the top bar keeps working —
    // people still switch shows and mark attendance after the fact. Bingo cells are divs
    // and so survive this deliberately: tapping squares as songs are played is the point
    // of live mode, and it writes to live_checked, never to the prediction itself.
    if ((mode === 'setlist' || mode === 'bingo') && lockInfo().locked) {
      const SEL = 'button, input, select, textarea';
      for (let i = builderStart; i < mount.childElementCount; i++) {
        const node = mount.children[i];
        // The node ITSELF has to be considered, not just its descendants — the Save button
        // is appended straight onto the panel, so a querySelectorAll from it finds nothing
        // and it stayed live while everything around it went dead.
        const controls = [...node.querySelectorAll(SEL)];
        if (node.matches(SEL)) controls.push(node);
        for (const c of controls) {
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
      box.appendChild(el('div', 'hint', tab === 'login'
        ? 'Sign in to save predictions and build your track record.'
        : 'Register with your email and a password (6+ characters for now).'));
      const email = el('input', 'ta-input');
      email.placeholder = legacy ? 'name' : 'email address';
      email.type = legacy ? 'text' : 'email';
      email.autocomplete = legacy ? 'username' : 'email';
      const pass = el('input', 'ta-input'); pass.placeholder = 'password'; pass.type = 'password';
      pass.autocomplete = tab === 'login' ? 'current-password' : 'new-password';
      const disp = el('input', 'ta-input'); disp.placeholder = 'display name';
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

  function scoringHelp() {
    const box = el('div', 'p-help');
    const row = (what, pts) => `<tr><td>${what}</td><td class="num"><b>${pts}</b></td></tr>`;
    // "10 / 10 / 5" is shorthand that only means anything if you already know the rule, so
    // the caps are spelled out. Written from the constants, and the two sets collapse into
    // one phrase only while they actually match.
    const setCap = (SOFT_CAP.set1 === SOFT_CAP.set2
      ? `the first ${SOFT_CAP.set1} songs of a set`
      : `the first ${SOFT_CAP.set1} songs of Set 1 and ${SOFT_CAP.set2} of Set 2`)
      + ` (${SOFT_CAP.encore} in the encore)`;
    box.innerHTML = `
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
      </div>

      <div class="setlabel">PHISH Bingo</div>
      <table><tbody>
        ${row('Squares you call right', 'up to 80, shared across the 24')}
        ${row('Five in a line — row, column or diagonal', '+20')}
      </tbody></table>
      <div class="p-help-note">The donut in the middle is yours for free and always counts toward a line.</div>

      <div class="p-help-note">
        Setlist points and bingo scores are separate scores and are never added together or
        averaged — a setlist result is a point total, a bingo result is out of 100.
        Both lock when the show starts.
      </div>`;
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

  function renderTopBar() {
    const bar = el('div', 'p-topbar');
    if (user) {
      const s = user.stats || {};
      const summary = statSummary(s);
      const statText = ` · ${s.predictions ?? 0} predictions, ${s.scored ?? 0} scored${summary ? ' · ' + summary : ''}`;
      bar.appendChild(el('span', null, `<span class="p-avatar">${esc(avatarOf(user))}</span> <b>${esc(displayName(user))}</b><span class="hint">${esc(statText)}</span>`));
    } else {
      bar.appendChild(el('span', 'hint', 'Build freely — you’ll be asked to sign in when you save.'));
    }

    // Just the two builders — history, profile, and sign-out live in the header menu.
    // Switching game used to happen here. It now happens in the page's own tab bar —
    // Phish Bingo and Set List Bets are the first two things a visitor sees — so a second
    // pair of buttons doing the same job would just be two controls fighting over one
    // piece of state.
    const modes = el('div', 'p-modes');
    // Kept beside the tabs rather than in the builder, so it covers both games and —
    // since the lock sweep only disables the builder — stays readable after a show
    // starts, which is exactly when someone wants to know how they were scored.
    const help = el('button', 'p-mode' + (helpOpen ? ' active' : ''), helpOpen ? '✕ Scoring' : '❓ How scoring works');
    help.addEventListener('click', () => { helpOpen = !helpOpen; render(); });
    modes.appendChild(help);
    bar.appendChild(modes);
    if (helpOpen) bar.appendChild(scoringHelp());

    const showRow = el('div', 'hint', `Predicting: `);
    const dateInput = el('input', 'ta-input p-date');
    dateInput.value = showdate;
    dateInput.addEventListener('change', () => { showdate = dateInput.value.trim(); loadExisting(); });
    showRow.appendChild(dateInput);
    showRow.appendChild(el('span', null, ` (next show: ${esc(fmtDate(A.nextShow.date))} — ${esc(A.nextShow.venue)})`));
    bar.appendChild(showRow);

    const L = lockInfo();
    if (L.known) {
      const clock = L.local ? `${L.local} local time` : 'the published show time';
      bar.appendChild(L.locked
        ? el('div', 'p-lock p-locked',
          `🔒 <b>Locked.</b> Doors are shut — this show started at ${esc(clock)} and predictions can no longer be changed.`)
        : el('div', 'p-lock',
          `🔓 Locks in <b>${untilText(L.at - Date.now())}</b>, at ${esc(clock)}${L.source === 'fallback' ? ' <span class="hint">(estimated — no time published yet)</span>' : ''}.`));
    }

    // Attendance toggle for whichever show is currently selected. Self-reported and
    // freely re-togglable, including for past dates — people forget until afterwards.
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
    mount.appendChild(bar);
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
    // Saved predictions win, but never clobber an unsaved local draft with emptiness —
    // signing in mid-draft (e.g. via the menu) must not wipe the work in progress.
    const draftSongs = build.set1.length + build.set2.length + build.encore.length;
    if (sl) build = JSON.parse(JSON.stringify(sl.payload));
    else if (!draftSongs) build = { set1: [], set2: [], encore: [] };
    const draftCells = grid.filter((c, i) => c && i !== FREE).length;
    if (bg) grid = bg.payload.grid.slice();
    else if (!draftCells) grid = Array(25).fill(null);
    locks = Array(25).fill(false);
    livePrediction = bg || null;
    bingoDeclared = false;
    render();
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

    const controls = el('div', 'p-row');
    const rand = el('button', 'p-btn p-btn-alt', '🎲 Randomize');
    rand.title = 'Replace the draft with a random setlist (weighted toward frequently played songs) — up to 10 per set, up to 4 in the encore';
    rand.addEventListener('click', () => {
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
    });
    controls.appendChild(rand);
    const safe = el('button', 'p-btn p-btn-alt', '🛟 Play It Safe');
    safe.title = "Replace the draft with the model's predicted setlist for this show";
    safe.addEventListener('click', () => {
      build = {
        set1: A.prediction.set1.map(s => ({ slug: s.slug, name: s.name })),
        set2: A.prediction.set2.map(s => ({ slug: s.slug, name: s.name })),
        encore: A.prediction.encore.map(s => ({ slug: s.slug, name: s.name })),
      };
      render();
    });
    controls.appendChild(safe);
    mount.appendChild(controls);

    const wrap = el('div', 'p-sets');
    for (const [key, label] of [['set1', 'Set 1'], ['set2', 'Set 2'], ['encore', 'Encore']]) {
      const col = el('div', 'p-setcol');
      col.appendChild(el('div', 'setlabel', label));
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
        const row = el('div', 'p-songrow',
          `<span class="p-songmain"><span>${esc(s.name)} ${bustChip(s.slug)}${stressor ? `<span class="p-stress">${stressor}</span>` : ''}</span>${metaLine}</span>`);
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
      // Running count against the soft cap. The cap is not enforced — Phish plays 15-song
      // sets — but past it a wrong guess costs a point, so it has to be visible before
      // someone saves rather than as a surprise when the show is graded.
      const cap = SOFT_CAP[key];
      const n = build[key].length;
      const over = n - cap;
      const counter = el('div', over > 0 ? 'p-cap p-cap-over' : 'p-cap', over > 0
        ? `${n} of ${cap} — ${over} past the cap, each costs 1 point if wrong`
        : `${n} of ${cap}`);
      if (over > 0) counter.title = `Songs beyond ${cap} only score if you call them right. Each wrong one deducts a point. Remove them and no deduction applies.`;
      col.appendChild(counter);
      col.appendChild(typeahead(`add to ${label}…`, usedSlugs, s => { build[key].push(s); render(); }));
      wrap.appendChild(col);
    }
    mount.appendChild(wrap);
    // The full rules moved behind the "How scoring works" button — as a paragraph under
    // the builder they were the kind of thing people scroll past. What stays is the one
    // fact you need while dragging songs around.
    mount.appendChild(el('div', 'hint',
      'Openers and closers are whatever sits first and last in each list — drag ⋮⋮ to reorder.'));
    const save = el('button', 'p-btn', user ? 'Save setlist prediction' : 'Sign in to save prediction');
    save.addEventListener('click', () => requireAuth('Sign in or create an account to save your setlist.', async () => {
      try {
        await api('/api/predictions', 'POST', { showdate, type: 'setlist', payload: build });
        flash('Saved.');
      } catch (e) { flash(e.message, true); }
    }));
    mount.appendChild(save);
  }

  // ---------- bingo ----------
  function renderBingo() {
    const scored = livePrediction && livePrediction.result;
    const live = livePrediction && !scored;
    const checked = live ? (livePrediction.liveChecked || Array(25).fill(false)) :
      scored ? livePrediction.result.checked : null;

    if (live) mount.appendChild(el('div', 'hint', 'Card saved — live mode: tap squares as songs are played. Five in a line (row, column, or diagonal) declares BINGO. Change the card by editing squares below and re-saving.'));
    else if (scored) mount.appendChild(el('div', 'hint', `Scored: ${livePrediction.result.hitCount}/24 squares hit${livePrediction.result.bingo ? ' — BINGO!' : ''}`));
    else mount.appendChild(el('div', 'hint', 'Fill the grid from the catalog (each song once), donut in the middle is free. Save, then check squares off live during the show.'));

    const banner = el('div', 'p-bingo-banner');
    banner.style.display = 'none';
    mount.appendChild(banner);

    const usedSlugs = () => new Set(grid.filter((c, i) => c && i !== FREE).map(c => c.slug));

    // controls + cell picker live ABOVE the grid
    const controls = el('div', 'p-row');
    if (!scored) mount.appendChild(controls);
    const pickerHost = el('div', 'p-picker');
    mount.appendChild(pickerHost);

    const table = el('div', 'p-grid');
    table.appendChild(el('div', 'p-corner', ''));
    for (const c of PHISH) table.appendChild(el('div', 'p-head', c));

    for (let r = 0; r < 5; r++) {
      table.appendChild(el('div', 'p-head', PHISH[r]));
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
          cell = el('div', 'p-cell filled' + (isChecked ? ' checked' : ''),
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
            const lock = el('button', 'p-lock', locks[i] ? '🔒' : '🔓');
            lock.title = locks[i] ? 'locked — Randomize will keep this square' : 'unlocked — Randomize may replace this square';
            lock.addEventListener('click', ev => { ev.stopPropagation(); locks[i] = !locks[i]; render(); });
            cell.appendChild(lock);
            if (!locks[i]) {
              const x = el('button', 'p-x', '×');
              x.addEventListener('click', ev => { ev.stopPropagation(); grid[i] = null; render(); });
              cell.appendChild(x);
            }
          }
        } else {
          cell = el('div', 'p-cell empty', '<span class="p-cellname">＋</span>');
          if (!scored) cell.addEventListener('click', () => openCellPicker(i));
        }
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
      const rand = el('button', 'p-btn p-btn-alt', '🎲 Randomize');
      rand.title = 'Fill every unlocked square with a random song (weighted toward frequently played ones)';
      rand.addEventListener('click', () => {
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
      });
      controls.appendChild(rand);

      const safe = el('button', 'p-btn p-btn-alt', '🛟 Play It Safe');
      safe.title = "Fill unlocked squares from the model's predicted setlist for this show, topped up with its highest-ranked candidates";
      safe.addEventListener('click', () => {
        const keep = new Set(grid.filter((c, i) => c && locks[i] && i !== FREE).map(c => c.slug));
        const seq = [];
        const pushUnique = s => {
          if (s && s.slug && !keep.has(s.slug) && !seq.some(x => x.slug === s.slug)) seq.push({ slug: s.slug, name: s.name });
        };
        for (const list of [A.prediction.set1, A.prediction.set2, A.prediction.encore]) list.forEach(pushUnique);
        for (const c of A.candidates) pushUnique(c); // top up beyond the 17 predicted songs
        let k = 0;
        for (let i = 0; i < 25; i++) {
          if (i === FREE || locks[i]) continue;
          grid[i] = seq[k++] || null;
        }
        render();
      });
      controls.appendChild(safe);

      const clear = el('button', 'p-btn p-btn-alt', '🧹 Clear');
      clear.title = 'Empty every unlocked square (the donut and locked squares are left alone)';
      clear.addEventListener('click', () => {
        for (let i = 0; i < 25; i++) {
          if (i === FREE || locks[i]) continue;
          grid[i] = null;
        }
        render();
      });
      controls.appendChild(clear);

      const btnRow = el('div', 'p-row');
      const save = el('button', 'p-btn', livePrediction ? 'Re-save card' : (user ? 'Save bingo card' : 'Sign in to save card'));
      save.addEventListener('click', () => {
        const filled = grid.filter((c, i) => c && i !== FREE).length;
        if (filled < 24) return flash(`Fill all squares first (${filled}/24).`, true);
        requireAuth('Sign in or create an account to save your bingo card.', async () => {
          try {
            await api('/api/predictions', 'POST', { showdate, type: 'bingo', payload: { grid } });
            await loadExisting();
            mode = 'bingo';
            flash('Card saved — live mode on.');
          } catch (e) { flash(e.message, true); }
        });
      });
      btnRow.appendChild(save);
      mount.appendChild(btnRow);
    }

    function declareBingo() {
      banner.innerHTML = '🍩🍩🍩 <b>BINGO!</b> Five in a line — you win the donut. 🍩🍩🍩';
      banner.style.display = '';
      banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    const fields = [
      ['displayName', 'display name', p.displayName || ''],
      ['avatar', 'avatar (an emoji or two)', p.avatar || ''],
      ['hometown', 'hometown', p.hometown || ''],
      ['favoriteSong', 'favorite song', p.favoriteSong || ''],
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
      if (p.hometown || p.favoriteSong) card.appendChild(el('div', 'hint', [p.hometown && `from ${p.hometown}`, p.favoriteSong && `favorite song: ${p.favoriteSong}`].filter(Boolean).map(esc).join(' · ')));
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
    const [preds, groups] = await Promise.all([
      api(`/api/predictions?user=${user.handle}`),
      api('/api/groups').then(j => j.groups).catch(() => []),
    ]);
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
    if (!preds.length) wrap.appendChild(el('div', 'hint', 'No predictions yet.'));
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
    const profilePanel = el('div');

    // Leaderboard with a scope selector: Everyone / Friends / each group you're in.
    wrap.appendChild(el('div', 'setlabel', 'Leaderboard — click a name for their profile'));
    const scopeRow = el('div', 'p-modes');
    const boardHost = el('div');
    const scopes = [
      ['everyone', 'Everyone'],
      ['friends', 'Friends'],
      ...groups.map(g => [`group:${g.id}`, g.name]),
    ];
    wrap.appendChild(scopeRow);
    wrap.appendChild(boardHost);

    async function drawBoard() {
      scopeRow.innerHTML = '';
      for (const [key, label] of scopes) {
        const b = el('button', 'p-mode' + (leaderboardScope === key ? ' active' : ''), esc(label));
        b.addEventListener('click', () => { leaderboardScope = key; drawBoard(); });
        scopeRow.appendChild(b);
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
      if (!board.length) {
        boardHost.appendChild(el('div', 'hint', leaderboardScope === 'everyone'
          ? 'Nobody has a scored prediction yet.'
          : 'Nobody here has a scored prediction yet — scores appear once a show is graded.'));
        return;
      }
      // Attendance across this scope, for the show most of them predicted.
      const attended = board.filter(u => u.showsAttended > 0).length;
      if (leaderboardScope !== 'everyone' && attended) {
        boardHost.appendChild(el('div', 'hint',
          `🎟 ${attended} of ${board.length} here have marked shows they attended.`));
      }
      board.forEach((u, i) => {
        const att = u.showsAttended ? ` · 🎟 ${u.showsAttended}` : '';
        const row = el('div', 'p-histrow p-boardrow',
          `#${i + 1} <span class="p-avatar">${esc(avatarOf(u))}</span> <b>${esc(displayName(u))}</b> — `
          + (statSummary(u) || `${u.scored} scored, none on the current scale`) + att);
        row.addEventListener('click', () => showPublicProfile(profilePanel, u.handle));
        boardHost.appendChild(row);
      });
    }
    await drawBoard();
    wrap.appendChild(profilePanel);
  }

  function flash(msg, isErr) {
    const f = el('div', 'p-flash' + (isErr ? ' err' : ''), esc(msg));
    mount.appendChild(f);
    setTimeout(() => f.remove(), 2500);
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
      // Hold it and ask them to sign in; redeem runs again after auth succeeds.
      authPrompt = {
        tab: 'register',
        message: 'Sign in or create an account to accept this invite.',
        onAuthed: null,
      };
      render();
      return;
    }
    clearPendingInvite();
    try {
      const j = await api(`/api/invites/${encodeURIComponent(code)}/redeem`, 'POST', {});
      flash(j.already ? `You're already friends with ${j.friend.name}.` : `You and ${j.friend.name} are now friends.`);
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
      render();
    },
    getMode: () => mode,
  };
}
