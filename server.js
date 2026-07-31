const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const dataDir = path.join(root, 'data');
const dbFile = path.join(dataDir, 'db.json');
const PORT = 5177;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const KEY = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/PHISHNET_API_KEY=(\S+)/)[1];

// ---- tiny JSON store
function readDb() {
  const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : {};
  db.users = db.users || [];
  db.predictions = db.predictions || [];
  db.sessions = db.sessions || {};
  return db;
}
function writeDb(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 1));
}
const slugifyName = n => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---- auth: scrypt password hashing + cookie sessions (no dependencies)
const SESSION_COOKIE = 'kalphishi_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const target = Buffer.from(hash, 'hex');
  return test.length === target.length && crypto.timingSafeEqual(test, target);
}
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, expires: Date.now() + SESSION_TTL_MS };
  // opportunistic prune
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[t];
  return token;
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function currentUser(req, db) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const s = db.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  return db.users.find(u => u.id === s.userId) || null;
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
const PROFILE_FIELDS = ['displayName', 'avatar', 'hometown', 'favoriteSong', 'bio'];
function publicUser(db, u) {
  return { id: u.id, name: u.name, created: u.created, profile: u.profile || {}, stats: userStats(db, u.id) };
}

// ---- scoring
const SETLIST_WEIGHTS = { hits: 70, opener: 6, s1closer: 6, s2opener: 6, s2closer: 6, encore: 6 };

function scoreSetlistPrediction(payload, actual) {
  const actualSlugs = new Set(actual.map(a => a.slug));
  const all = [...payload.set1, ...payload.set2, ...payload.encore];
  const hits = all.filter(p => actualSlugs.has(p.slug));
  const bySet = set => actual.filter(a => a.set === set);
  const s1 = bySet('1'), s2 = bySet('2');
  const enc = actual.filter(a => a.set === 'e' || a.set === 'e2');
  const stressors = {
    opener: !!(payload.set1[0] && s1[0] && payload.set1[0].slug === s1[0].slug),
    s1closer: !!(payload.set1.length && s1.length && payload.set1[payload.set1.length - 1].slug === s1[s1.length - 1].slug),
    s2opener: !!(payload.set2[0] && s2[0] && payload.set2[0].slug === s2[0].slug),
    s2closer: !!(payload.set2.length && s2.length && payload.set2[payload.set2.length - 1].slug === s2[s2.length - 1].slug),
    encore: payload.encore.some(p => enc.some(a => a.slug === p.slug)),
  };
  let score = all.length ? (hits.length / all.length) * SETLIST_WEIGHTS.hits : 0;
  for (const [k, ok] of Object.entries(stressors)) if (ok) score += SETLIST_WEIGHTS[k];
  return {
    score: +score.toFixed(1),
    hits: hits.map(h => h.name),
    misses: all.filter(p => !actualSlugs.has(p.slug)).map(p => p.name),
    stressors,
  };
}

const LINES = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  return lines;
})();
const FREE = 12;

function bingoLine(checked) {
  return LINES.find(line => line.every(i => i === FREE || checked[i])) || null;
}

function scoreBingoPrediction(payload, actual) {
  const actualSlugs = new Set(actual.map(a => a.slug));
  const checked = payload.grid.map((cell, i) => i !== FREE && !!cell && actualSlugs.has(cell.slug));
  const hitCount = checked.filter(Boolean).length;
  const line = bingoLine(checked);
  const score = +(hitCount / 24 * 80 + (line ? 20 : 0)).toFixed(1);
  return { score, hitCount, checked, bingo: !!line, line };
}

async function fetchActualSetlist(showdate) {
  const res = await fetch(`https://api.phish.net/v5/setlists/showdate/${showdate}.json?apikey=${KEY}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error_message);
  const rows = json.data.filter(r => r.artistid === 1 && r.set !== 's');
  rows.sort((a, b) => a.position - b.position);
  return rows.map(r => ({ slug: r.slug, name: r.song, set: r.set }));
}

function userStats(db, userId) {
  const scored = db.predictions.filter(p => p.userId === userId && p.result);
  const total = db.predictions.filter(p => p.userId === userId).length;
  const avg = scored.length ? scored.reduce((s, p) => s + p.result.score, 0) / scored.length : null;
  return {
    predictions: total,
    scored: scored.length,
    accuracy: avg === null ? null : +avg.toFixed(1),
    bingos: scored.filter(p => p.type === 'bingo' && p.result.bingo).length,
  };
}

// ---- on-demand venue slice (fetches from phish.net, caches to data/)
async function phishnetGet(endpoint) {
  const res = await fetch(`https://api.phish.net/v5${endpoint}?apikey=${KEY}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error_message);
  return json.data;
}
async function cachedFetch(name, endpoint) {
  const f = path.join(dataDir, `${name}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const data = await phishnetGet(endpoint);
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}
const VENUE_SHOW_CAP = 5;
async function venueSlice(venueid, { limit, dates } = {}) {
  const shows = await cachedFetch(`shows-venue-${venueid}`, `/shows/venueid/${venueid}`);
  const today = new Date().toISOString().slice(0, 10);
  const phishShows = shows
    .filter(s => s.artistid === 1 && s.showdate < today)
    .sort((a, b) => b.showdate.localeCompare(a.showdate));
  const selected = dates && dates.length
    ? phishShows.filter(s => dates.includes(s.showdate))
    : phishShows.slice(0, limit || VENUE_SHOW_CAP);
  const out = [];
  for (const s of selected) {
    const cacheFile = path.join(dataDir, `setlist-${s.showdate}.json`);
    const wasCached = fs.existsSync(cacheFile);
    const rows = (await cachedFetch(`setlist-${s.showdate}`, `/setlists/showdate/${s.showdate}`))
      .filter(r => r.artistid === 1 && r.set !== 's')
      .sort((a, b) => a.position - b.position);
    if (!wasCached) await new Promise(r => setTimeout(r, 250)); // be polite to phish.net on cold fetches
    if (!rows.length) continue;
    const sets = {};
    for (const r of rows) {
      (sets[r.set] = sets[r.set] || []).push({ song: r.song, slug: r.slug, trans: r.trans_mark });
    }
    out.push({
      date: s.showdate,
      tour: rows[0].tourname,
      notes: (rows[0].setlistnotes || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      sets,
    });
  }
  return { total: phishShows.length, shown: out.length, dates: phishShows.map(s => s.showdate), shows: out };
}

// ---- song metadata (last played + venue + gap) for the predictor UI
let songMetaCache = null;
function songMeta() {
  if (songMetaCache) return songMetaCache;
  const lastSeen = new Map(); // slug -> {venue, city, state, showdate} from era setlists
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    const f = path.join(dataDir, `setlists-${y}.json`);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      if (r.artistid !== 1 || r.set === 's') continue;
      const prev = lastSeen.get(r.slug);
      if (!prev || r.showdate > prev.showdate) {
        lastSeen.set(r.slug, { venue: r.venue, city: r.city, state: r.state, showdate: r.showdate });
      }
    }
  }
  const songs = JSON.parse(fs.readFileSync(path.join(dataDir, 'songs.json'), 'utf8'));
  songMetaCache = {};
  for (const s of songs) {
    const seen = lastSeen.get(s.slug);
    let venue = seen ? `${seen.venue}, ${seen.city}${seen.state ? ' ' + seen.state : ''}` : null;
    if (!venue && s.last_permalink) {
      // fallback for pre-2022 last plays: prettify the permalink tail after the date
      const m = s.last_permalink.match(/setlists\/phish-[a-z]+-\d{2}-\d{4}-(.+?)(?:-usa)?$/);
      if (m) venue = m[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
    songMetaCache[s.slug] = { lastPlayed: s.last_played, gap: s.gap, venue };
  }
  return songMetaCache;
}

// ---- http
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const q = new URLSearchParams(req.url.split('?')[1] || '');

  try {
    if (urlPath === '/api/register' && req.method === 'POST') {
      const { name, password, displayName } = await readBody(req);
      if (!name || !name.trim()) return send(res, 400, { error: 'name required' });
      if (!password || password.length < 6) return send(res, 400, { error: 'password must be at least 6 characters' });
      const db = readDb();
      const id = slugifyName(name);
      if (!id) return send(res, 400, { error: 'invalid name' });
      let user = db.users.find(u => u.id === id);
      if (user && user.passhash) return send(res, 409, { error: 'that name is taken' });
      if (user) {
        // legacy name-only account: setting a password claims it (and its predictions)
        user.passhash = hashPassword(password);
        user.profile = { ...(user.profile || {}), displayName: displayName || user.name };
      } else {
        user = {
          id, name: name.trim(), created: new Date().toISOString(),
          passhash: hashPassword(password),
          profile: { displayName: displayName || name.trim() },
        };
        db.users.push(user);
      }
      const token = createSession(db, id);
      writeDb(db);
      setSessionCookie(res, token);
      return send(res, 200, { user: publicUser(db, user) });
    }

    if (urlPath === '/api/login' && req.method === 'POST') {
      const { name, password } = await readBody(req);
      const db = readDb();
      const user = db.users.find(u => u.id === slugifyName(name || ''));
      if (user && !user.passhash) return send(res, 409, { error: 'claimable', message: 'This name has no password yet — use "Create account" with it to claim it and its predictions.' });
      if (!user || !verifyPassword(password || '', user.passhash)) {
        return send(res, 401, { error: 'wrong name or password' });
      }
      const token = createSession(db, user.id);
      writeDb(db);
      setSessionCookie(res, token);
      return send(res, 200, { user: publicUser(db, user) });
    }

    if (urlPath === '/api/logout' && req.method === 'POST') {
      const db = readDb();
      const token = getCookie(req, SESSION_COOKIE);
      if (token && db.sessions[token]) { delete db.sessions[token]; writeDb(db); }
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }

    if (urlPath === '/api/me' && req.method === 'GET') {
      const db = readDb();
      const user = currentUser(req, db);
      if (!user) return send(res, 401, { error: 'not signed in' });
      return send(res, 200, { user: publicUser(db, user) });
    }

    if (urlPath === '/api/profile' && req.method === 'PUT') {
      const db = readDb();
      const user = currentUser(req, db);
      if (!user) return send(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      user.profile = user.profile || {};
      for (const f of PROFILE_FIELDS) {
        if (f in body) user.profile[f] = String(body[f] || '').slice(0, f === 'bio' ? 500 : 80);
      }
      writeDb(db);
      return send(res, 200, { user: publicUser(db, user) });
    }

    if (urlPath.startsWith('/api/profile/') && req.method === 'GET') {
      const db = readDb();
      const u = db.users.find(x => x.id === urlPath.split('/').pop());
      if (!u) return send(res, 404, { error: 'no such user' });
      const recent = db.predictions
        .filter(p => p.userId === u.id && p.result)
        .sort((a, b) => b.showdate.localeCompare(a.showdate))
        .slice(0, 5)
        .map(p => ({ showdate: p.showdate, type: p.type, score: p.result.score, bingo: p.type === 'bingo' ? p.result.bingo : undefined }));
      return send(res, 200, { user: publicUser(db, u), recent });
    }

    if (urlPath === '/api/predictions' && req.method === 'GET') {
      const db = readDb();
      let preds = db.predictions;
      if (q.get('user')) preds = preds.filter(p => p.userId === q.get('user'));
      if (q.get('showdate')) preds = preds.filter(p => p.showdate === q.get('showdate'));
      return send(res, 200, preds);
    }

    if (urlPath === '/api/predictions' && req.method === 'POST') {
      const db = readDb();
      const user = currentUser(req, db);
      if (!user) return send(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      const { showdate, type, payload } = body;
      const userId = user.id; // identity comes from the session, never the request body
      if (!showdate || !['setlist', 'bingo'].includes(type) || !payload) {
        return send(res, 400, { error: 'showdate, type (setlist|bingo), payload required' });
      }
      if (type === 'bingo') {
        const slugs = payload.grid.filter((c, i) => i !== FREE && c).map(c => c.slug);
        if (new Set(slugs).size !== slugs.length) return send(res, 400, { error: 'duplicate songs in grid' });
      }
      // one prediction per user+show+type: replace on resubmit (allowed until show is scored)
      const existing = db.predictions.find(p => p.userId === userId && p.showdate === showdate && p.type === type);
      if (existing && existing.result) return send(res, 409, { error: 'already scored — cannot edit' });
      if (existing) {
        existing.payload = payload;
        existing.updated = new Date().toISOString();
      } else {
        db.predictions.push({
          id: `${userId}-${showdate}-${type}`,
          userId, showdate, type, payload,
          created: new Date().toISOString(), result: null, liveChecked: null,
        });
      }
      writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (urlPath === '/api/live-check' && req.method === 'POST') {
      const db = readDb();
      const user = currentUser(req, db);
      if (!user) return send(res, 401, { error: 'not signed in' });
      const { predictionId, checked } = await readBody(req);
      const p = db.predictions.find(x => x.id === predictionId);
      if (!p) return send(res, 404, { error: 'not found' });
      if (p.userId !== user.id) return send(res, 403, { error: 'not your prediction' });
      p.liveChecked = checked;
      const line = p.type === 'bingo' ? bingoLine(checked) : null;
      writeDb(db);
      return send(res, 200, { ok: true, bingo: !!line, line });
    }

    if (urlPath.startsWith('/api/score/') && req.method === 'POST') {
      const showdate = urlPath.split('/').pop();
      const actual = await fetchActualSetlist(showdate);
      if (!actual.length) return send(res, 404, { error: `no setlist posted for ${showdate}` });
      const db = readDb();
      const targets = db.predictions.filter(p => p.showdate === showdate);
      for (const p of targets) {
        p.result = p.type === 'setlist'
          ? scoreSetlistPrediction(p.payload, actual)
          : scoreBingoPrediction(p.payload, actual);
        p.scoredAt = new Date().toISOString();
      }
      writeDb(db);
      return send(res, 200, { scored: targets.length, actualSongs: actual.length });
    }

    if (urlPath.startsWith('/api/stats/') && req.method === 'GET') {
      const db = readDb();
      return send(res, 200, userStats(db, urlPath.split('/').pop()));
    }

    if (urlPath === '/api/venue-slice' && req.method === 'GET') {
      const venueid = parseInt(q.get('venueid'), 10);
      if (!venueid) return send(res, 400, { error: 'venueid required' });
      const limit = q.get('limit') ? Math.max(1, parseInt(q.get('limit'), 10)) : undefined;
      const dates = q.get('dates') ? q.get('dates').split(',').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : undefined;
      return send(res, 200, await venueSlice(venueid, { limit, dates }));
    }

    if (urlPath === '/api/songmeta' && req.method === 'GET') {
      return send(res, 200, songMeta());
    }

    if (urlPath === '/api/leaderboard' && req.method === 'GET') {
      const db = readDb();
      const board = db.users.map(u => ({ ...publicUser(db, u), ...userStats(db, u.id) }))
        .filter(u => u.scored > 0)
        .sort((a, b) => b.accuracy - a.accuracy);
      return send(res, 200, board);
    }
  } catch (e) {
    return send(res, 500, { error: e.message });
  }

  // ---- static
  let filePath = urlPath === '/' ? '/web/index.html' : urlPath;
  const file = path.normalize(path.join(root, filePath));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

module.exports = { readDb, writeDb, scoreSetlistPrediction, scoreBingoPrediction, fetchActualSetlist, userStats };

if (require.main === module) {
  server.listen(PORT, () => console.log(`Kalphishi on http://localhost:${PORT}`));
}
