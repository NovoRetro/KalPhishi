// Kalphishi user predictor: setlist builder + PHISH bingo + history.
// Called from index.html: initPredictor(containerEl, analysis)
function initPredictor(mount, A) {
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const FREE = 12;
  const PHISH = ['P', 'H', 'I', 'S', 'H'];

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

  let meta = {};
  fetch('/data/songs.json').then(r => r.json()).then(d => {
    songs = d.filter(s => s.artist === 'Phish' || true).map(s => ({ slug: s.slug, name: s.song, plays: s.times_played }));
    songs.sort((a, b) => b.plays - a.plays);
  });
  fetch('/data/songmeta.json').then(r => r.json()).then(d => { meta = d; });

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
  function render() {
    mount.innerHTML = '';
    mount.appendChild(el('h2', null, 'Predictor <span class="hint">— build your own call for the next show</span>'));
    if (!user) return renderLogin();
    if (user.needsEmail) return renderLinkEmail();
    renderTopBar();
    if (mode === 'setlist') renderSetlistBuilder();
    else if (mode === 'bingo') renderBingo();
    else if (mode === 'profile') renderProfile();
    else renderHistory();
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

  function renderLogin(startTab) {
    let tab = startTab || 'login';
    let legacy = false; // sign in with a pre-email account name
    const box = el('div', 'p-login');
    mount.appendChild(box);
    function draw() {
      box.innerHTML = '';
      const tabs = el('div', 'p-modes');
      for (const [key, label] of [['login', 'Sign in'], ['register', 'Create account']]) {
        const b = el('button', 'p-mode' + (tab === key ? ' active' : ''), label);
        b.addEventListener('click', () => { tab = key; draw(); });
        tabs.appendChild(b);
      }
      box.appendChild(tabs);
      box.appendChild(el('div', 'hint', tab === 'login'
        ? 'Sign in to predict and build your track record.'
        : 'Register with your email and a password (12+ characters). Predicted before under just a name with no password? Put that name in the claim field to keep your history.'));
      const email = el('input', 'ta-input');
      email.placeholder = legacy ? 'name' : 'email address';
      email.type = legacy ? 'text' : 'email';
      email.autocomplete = legacy ? 'username' : 'email';
      const pass = el('input', 'ta-input'); pass.placeholder = 'password'; pass.type = 'password';
      pass.autocomplete = tab === 'login' ? 'current-password' : 'new-password';
      const disp = el('input', 'ta-input'); disp.placeholder = 'display name';
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
          loadExisting();
        } catch (e) {
          err.textContent = e.message === 'claimable'
            ? 'This name has no password yet — switch to "Create account" and put it in the claim field to keep its predictions.'
            : e.message;
        }
      }
      btn.addEventListener('click', go);
      for (const inp of [email, pass, disp, claim]) inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
      const row = el('div', 'p-row');
      row.appendChild(email); row.appendChild(pass);
      if (tab === 'register') { row.appendChild(disp); row.appendChild(claim); }
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
  }

  const displayName = u => (u.profile && u.profile.displayName) || u.name;
  const avatarOf = u => (u.profile && u.profile.avatar) || '🎣';

  function renderTopBar() {
    const bar = el('div', 'p-topbar');
    const s = user.stats || {};
    const statText = ` · ${s.predictions ?? 0} predictions, ${s.scored ?? 0} scored` +
      (s.accuracy != null ? `, accuracy ${s.accuracy}` : '') + (s.bingos ? `, ${s.bingos} BINGO${s.bingos > 1 ? 's' : ''}` : '');
    bar.appendChild(el('span', null, `<span class="p-avatar">${esc(avatarOf(user))}</span> <b>${esc(displayName(user))}</b><span class="hint">${esc(statText)}</span>`));

    const modes = el('div', 'p-modes');
    for (const [key, label] of [['setlist', 'Setlist'], ['bingo', 'PHISH Bingo'], ['history', 'My History'], ['profile', 'Profile']]) {
      const b = el('button', 'p-mode' + (mode === key ? ' active' : ''), label);
      b.addEventListener('click', () => { mode = key; render(); });
      modes.appendChild(b);
    }
    const out = el('button', 'p-mode', 'Sign out');
    out.addEventListener('click', async () => {
      await api('/api/logout', 'POST', {});
      user = null;
      render();
    });
    modes.appendChild(out);
    bar.appendChild(modes);

    const showRow = el('div', 'hint', `Predicting: `);
    const dateInput = el('input', 'ta-input p-date');
    dateInput.value = showdate;
    dateInput.addEventListener('change', () => { showdate = dateInput.value.trim(); loadExisting(); });
    showRow.appendChild(dateInput);
    showRow.appendChild(el('span', null, ` (next show: ${A.nextShow.date} — ${esc(A.nextShow.venue)})`));
    bar.appendChild(showRow);
    mount.appendChild(bar);
  }

  async function loadExisting() {
    const preds = await api(`/api/predictions?user=${user.handle}&showdate=${showdate}`);
    const sl = preds.find(p => p.type === 'setlist');
    const bg = preds.find(p => p.type === 'bingo');
    build = sl ? JSON.parse(JSON.stringify(sl.payload)) : { set1: [], set2: [], encore: [] };
    grid = bg ? bg.payload.grid.slice() : Array(25).fill(null);
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
      col.appendChild(typeahead(`add to ${label}…`, usedSlugs, s => { build[key].push(s); render(); }));
      wrap.appendChild(col);
    }
    mount.appendChild(wrap);
    mount.appendChild(el('div', 'hint', 'Stressors: show opener, Set 2 opener, both set closers, and encore calls earn bonus points (6 each; song hits are worth 70). Openers and closers are whatever sits first and last in each list — drag ⋮⋮ to reorder.'));
    const save = el('button', 'p-btn', 'Save setlist prediction');
    save.addEventListener('click', async () => {
      try {
        await api('/api/predictions', 'POST', { showdate, type: 'setlist', payload: build });
        flash('Saved.');
      } catch (e) { flash(e.message, true); }
    });
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
          cell = el('div', 'p-cell free checked', '🍩<br><span class="p-cellname">FREE</span>');
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

      const btnRow = el('div', 'p-row');
      const save = el('button', 'p-btn', livePrediction ? 'Re-save card' : 'Save bingo card');
      save.addEventListener('click', async () => {
        const filled = grid.filter((c, i) => c && i !== FREE).length;
        if (filled < 24) return flash(`Fill all squares first (${filled}/24).`, true);
        try {
          await api('/api/predictions', 'POST', { showdate, type: 'bingo', payload: { grid } });
          await loadExisting();
          mode = 'bingo';
          flash('Card saved — live mode on.');
        } catch (e) { flash(e.message, true); }
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
      if (key === 'avatar') inp.maxLength = 4;
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
      (s.accuracy != null ? `accuracy rating ${s.accuracy}` : 'no accuracy rating yet') +
      (s.bingos ? ` · ${s.bingos} BINGO${s.bingos > 1 ? 's' : ''} 🍩` : '')));
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
        (s.accuracy != null ? `accuracy ${s.accuracy}` : 'unrated') +
        (s.bingos ? ` · ${s.bingos} 🍩` : '')));
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

  // ---------- history ----------
  async function renderHistory() {
    const wrap = el('div');
    mount.appendChild(wrap);
    const [preds, board] = await Promise.all([
      api(`/api/predictions?user=${user.handle}`),
      api('/api/leaderboard'),
    ]);
    preds.sort((a, b) => b.showdate.localeCompare(a.showdate));
    if (!preds.length) wrap.appendChild(el('div', 'hint', 'No predictions yet.'));
    for (const p of preds) {
      const r = p.result;
      const line = r
        ? (p.type === 'setlist'
          ? `score <b>${r.score}</b> — ${r.hits.length} hits (${r.hits.map(esc).join(', ') || 'none'}); stressors: ${Object.entries(r.stressors).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`
          : `score <b>${r.score}</b> — ${r.hitCount}/24 squares${r.bingo ? ' — <b>BINGO 🍩</b>' : ''}`)
        : 'not scored yet';
      wrap.appendChild(el('div', 'p-histrow', `<b>${p.showdate}</b> · ${p.type} · ${line}`));
    }
    const profilePanel = el('div');
    if (board.length) {
      wrap.appendChild(el('div', 'setlabel', 'Leaderboard — click a name for their profile'));
      board.forEach((u, i) => {
        const row = el('div', 'p-histrow p-boardrow',
          `#${i + 1} <span class="p-avatar">${esc(avatarOf(u))}</span> <b>${esc(displayName(u))}</b> — accuracy ${u.accuracy} over ${u.scored} scored${u.bingos ? `, ${u.bingos} 🍩` : ''}`);
        row.addEventListener('click', () => showPublicProfile(profilePanel, u.handle));
        wrap.appendChild(row);
      });
    }
    wrap.appendChild(profilePanel);
  }

  function flash(msg, isErr) {
    const f = el('div', 'p-flash' + (isErr ? ' err' : ''), esc(msg));
    mount.appendChild(f);
    setTimeout(() => f.remove(), 2500);
  }

  // bootstrap: resolve session, then load any existing predictions
  api('/api/me')
    .then(j => { user = j.user; return loadExisting(); })
    .catch(() => { localStorage.removeItem('kalphish-user'); render(); });
}
