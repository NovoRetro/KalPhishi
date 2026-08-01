import {
  slugifyName, FREE, bingoLine, scoreSetlistPrediction, scoreBingoPrediction,
} from '../lib/scoring.mjs';
import { normalizeEmail, isValidEmail, handleCandidates } from '../lib/identity.mjs';
import { fetchActualSetlist } from '../lib/phishnet-core.mjs';
import {
  MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, newSession, currentUser,
  sessionCookie, clearedSessionCookie, getCookie, sha256hex, timingSafeEqualStr, SESSION_COOKIE,
} from './auth.mjs';
import {
  rowToPrediction, userStats, publicUser, ownUser, publicName,
  getUser, getUserByEmail, getUserByHandle, anyUserLacksEmail,
} from './db.mjs';
import { venueSlice } from './phishnet.mjs';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status, error, extra = {}) => json({ error, ...extra }, status);

const PROFILE_FIELDS = ['displayName', 'avatar', 'hometown', 'favoriteSong', 'bio'];

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function scoreShow(env, showdate, actual, force = false) {
  const { results } = await env.DB.prepare(
    `SELECT id, type, payload FROM predictions
      WHERE showdate = ?1 ${force ? '' : 'AND result IS NULL'}`
  ).bind(showdate).all();
  if (!results.length) return 0;

  const now = new Date().toISOString();
  const stmts = results.map(r => {
    const payload = JSON.parse(r.payload);
    const result = r.type === 'setlist'
      ? scoreSetlistPrediction(payload, actual)
      : scoreBingoPrediction(payload, actual);
    return env.DB.prepare(
      'UPDATE predictions SET result = ?1, score = ?2, bingo = ?3, scored_at = ?4 WHERE id = ?5'
    ).bind(JSON.stringify(result), result.score, result.bingo ? 1 : 0, now, r.id);
  });
  await env.DB.batch(stmts);
  return results.length;
}

// First free handle for a display name. The candidate sequence is pure
// (lib/identity.mjs); only the availability check touches the database.
async function assignHandle(env, displayName) {
  for (const cand of handleCandidates(displayName)) {
    const hit = await env.DB.prepare('SELECT 1 AS x FROM users WHERE LOWER(handle) = LOWER(?1)')
      .bind(cand).first();
    if (!hit) return cand;
  }
  throw new Error('could not assign a handle');
}

async function api(request, env, ctx, { p, m, q, url }) {
  if (p === '/api/register' && m === 'POST') {
    const { email: rawEmail, password, displayName, claimName } = await body(request);
    if (!isValidEmail(rawEmail)) return err(400, 'a valid email address is required');
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return err(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const email = normalizeEmail(rawEmail);
    if (await getUserByEmail(env, email)) return err(409, 'that email is already registered');

    const passhash = await hashPassword(password);

    // Claiming a pre-password legacy account: registering its name attaches a password
    // and an email to the existing row (and its predictions) in one step.
    if (claimName) {
      const existing = await getUser(env, slugifyName(claimName));
      if (!existing) return err(404, 'no account with that name');
      if (existing.passhash) return err(409, 'that account already has a password — sign in instead');
      const profile = { ...JSON.parse(existing.profile || '{}'), displayName: displayName || existing.name };
      const handle = existing.handle || await assignHandle(env, displayName || existing.name);
      const { token, stmt: sessionStmt } = await newSession(env, existing.id);
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET passhash = ?1, email = ?2, handle = ?3, profile = ?4 WHERE id = ?5')
          .bind(passhash, email, handle, JSON.stringify(profile), existing.id),
        sessionStmt,
      ]);
      return json({ user: await ownUser(env, await getUser(env, existing.id)) },
        200, { 'set-cookie': sessionCookie(token) });
    }

    // Internal id: random, never derived from anything a user typed.
    const id = 'u-' + crypto.randomUUID();
    const handle = await assignHandle(env, displayName || '');
    const { token, stmt: sessionStmt } = await newSession(env, id);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (id, name, created, passhash, profile, email, handle) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
      ).bind(id, (displayName || '').trim() || email, new Date().toISOString(), passhash,
        JSON.stringify({ displayName: (displayName || '').trim() || handle }), email, handle),
      sessionStmt,
    ]);
    return json({ user: await ownUser(env, await getUser(env, id)) },
      200, { 'set-cookie': sessionCookie(token) });
  }

  if (p === '/api/login' && m === 'POST') {
    const { email, name, password } = await body(request);

    let user = null;
    if (email) {
      user = await getUserByEmail(env, normalizeEmail(email));
    } else if (name && await anyUserLacksEmail(env)) {
      // Legacy path: name + password, alive only while pre-email accounts remain.
      // Delete this branch (and the frontend affordance) once every row has an email.
      user = await getUser(env, slugifyName(name));
      if (user && !user.passhash) {
        return err(409, 'claimable', { message: 'This name has no password yet — use "Create account" with it to claim it and its predictions.' });
      }
    }
    if (!user || !await verifyPassword(password || '', user.passhash)) {
      return err(401, 'wrong email or password');
    }
    const { token, stmt } = await newSession(env, user.id);
    await stmt.run();
    return json({ user: await ownUser(env, user) }, 200, { 'set-cookie': sessionCookie(token) });
  }

  if (p === '/api/link-email' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    if (user.email) return err(409, 'this account already has an email');
    const { email: rawEmail } = await body(request);
    if (!isValidEmail(rawEmail)) return err(400, 'a valid email address is required');
    const email = normalizeEmail(rawEmail);
    if (await getUserByEmail(env, email)) return err(409, 'that email is already registered');
    await env.DB.prepare('UPDATE users SET email = ?1 WHERE id = ?2').bind(email, user.id).run();
    return json({ user: await ownUser(env, { ...user, email }) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256hex(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie() });
  }

  if (p === '/api/me' && m === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    return json({ user: await ownUser(env, user) });
  }

  if (p === '/api/profile' && m === 'PUT') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const b = await body(request);
    const profile = JSON.parse(user.profile || '{}');
    for (const f of PROFILE_FIELDS) {
      if (f in b) profile[f] = String(b[f] || '').slice(0, f === 'bio' ? 500 : 80);
    }
    await env.DB.prepare('UPDATE users SET profile = ?1 WHERE id = ?2').bind(JSON.stringify(profile), user.id).run();
    return json({ user: await ownUser(env, { ...user, profile: JSON.stringify(profile) }) });
  }

  if (p.startsWith('/api/profile/') && m === 'GET') {
    const u = await getUserByHandle(env, p.split('/').pop());
    if (!u) return err(404, 'no such user');
    const { results } = await env.DB.prepare(
      `SELECT showdate, type, score, bingo FROM predictions
        WHERE user_id = ?1 AND result IS NOT NULL ORDER BY showdate DESC LIMIT 5`
    ).bind(u.id).all();
    const recent = results.map(r => ({
      showdate: r.showdate,
      type: r.type,
      score: r.score,
      bingo: r.type === 'bingo' ? !!r.bingo : undefined,
    }));
    return json({ user: await publicUser(env, u), recent });
  }

  if (p === '/api/predictions' && m === 'GET') {
    const handle = q.get('user'), showdate = q.get('showdate');
    if (!handle && !showdate) return err(400, 'user or showdate filter required');
    const where = [], binds = [];
    if (handle) {
      const u = await getUserByHandle(env, handle);
      if (!u) return json([]);
      binds.push(u.id); where.push(`p.user_id = ?${binds.length}`);
    }
    if (showdate) { binds.push(showdate); where.push(`p.showdate = ?${binds.length}`); }
    const { results } = await env.DB.prepare(
      `SELECT p.*, u.handle AS user_handle
         FROM predictions p JOIN users u ON u.id = p.user_id
        WHERE ${where.join(' AND ')}`
    ).bind(...binds).all();
    return json(results.map(r => ({ ...rowToPrediction(r), userHandle: r.user_handle })));
  }

  if (p === '/api/predictions' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { showdate, type, payload } = await body(request);
    if (!showdate || !['setlist', 'bingo'].includes(type) || !payload) {
      return err(400, 'showdate, type (setlist|bingo), payload required');
    }
    if (type === 'bingo') {
      const slugs = payload.grid.filter((c, i) => i !== FREE && c).map(c => c.slug);
      if (new Set(slugs).size !== slugs.length) return err(400, 'duplicate songs in grid');
    }
    // one prediction per user+show+type; the WHERE on the upsert branch enforces
    // "editable until scored" in a single statement
    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      `INSERT INTO predictions (id, user_id, showdate, type, payload, created)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(user_id, showdate, type) DO UPDATE
         SET payload = excluded.payload, updated = ?6
         WHERE predictions.result IS NULL`
    ).bind(`${user.id}-${showdate}-${type}`, user.id, showdate, type, JSON.stringify(payload), now).run();

    if (!res.meta.changes) return err(409, 'already scored — cannot edit');
    return json({ ok: true });
  }

  if (p === '/api/live-check' && m === 'POST') {
    // Keyed on (showdate, type) rather than a prediction id: it only ever applies to
    // the caller's own prediction, and prediction ids embed the internal user id.
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { showdate, type, checked } = await body(request);
    if (!showdate || !['setlist', 'bingo'].includes(type)) return err(400, 'showdate and type required');
    const row = await env.DB.prepare(
      'SELECT id, type FROM predictions WHERE user_id = ?1 AND showdate = ?2 AND type = ?3'
    ).bind(user.id, showdate, type).first();
    if (!row) return err(404, 'not found');
    await env.DB.prepare('UPDATE predictions SET live_checked = ?1 WHERE id = ?2')
      .bind(JSON.stringify(checked), row.id).run();
    const line = row.type === 'bingo' ? bingoLine(checked) : null;
    return json({ ok: true, bingo: !!line, line });
  }

  if (p.startsWith('/api/score/') && m === 'POST') {
    if (!env.ADMIN_TOKEN || !timingSafeEqualStr(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN)) {
      return err(403, 'forbidden');
    }
    const showdate = p.split('/').pop();
    const actual = await fetchActualSetlist(showdate, env.PHISHNET_API_KEY);
    if (!actual.length) return err(404, `no setlist posted for ${showdate}`);
    const scored = await scoreShow(env, showdate, actual, q.get('force') === '1');
    return json({ scored, actualSongs: actual.length });
  }

  if (p.startsWith('/api/stats/') && m === 'GET') {
    const u = await getUserByHandle(env, p.split('/').pop());
    if (!u) return err(404, 'no such user');
    return json(await userStats(env, u.id));
  }

  if (p === '/api/venue-slice' && m === 'GET') {
    const venueid = parseInt(q.get('venueid'), 10);
    if (!venueid) return err(400, 'venueid required');
    const limit = q.get('limit') ? Math.max(1, parseInt(q.get('limit'), 10)) : undefined;
    const dates = q.get('dates') ? q.get('dates').split(',').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : undefined;
    return json(await venueSlice(venueid, { limit, dates }, env, ctx));
  }

  if (p === '/api/leaderboard' && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT u.handle, u.name, u.created, u.profile,
              COUNT(p.id)          AS predictions,
              COUNT(p.result)      AS scored,
              ROUND(AVG(p.score), 1) AS accuracy,
              SUM(CASE WHEN p.type = 'bingo' AND p.bingo = 1 THEN 1 ELSE 0 END) AS bingos
         FROM users u JOIN predictions p ON p.user_id = u.id
        GROUP BY u.id
       HAVING scored > 0
        ORDER BY accuracy DESC`
    ).all();
    // stats appear both nested and spread at top level — the frontend reads the top-level copies
    return json(results.map(r => {
      const stats = { predictions: r.predictions, scored: r.scored, accuracy: r.accuracy, bingos: r.bingos || 0 };
      return { handle: r.handle, name: publicName(r), created: r.created, profile: JSON.parse(r.profile || '{}'), stats, ...stats };
    }));
  }

  return err(404, 'not found');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p.startsWith('/api/')) {
      try {
        return await api(request, env, ctx, { p, m: request.method, q: url.searchParams, url });
      } catch (e) {
        return err(500, e.message);
      }
    }
    // published assets (index.html, /web/*, /data/*) are served before this runs;
    // anything reaching here matched no published file
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT showdate FROM predictions
        WHERE result IS NULL AND showdate < ?1 ORDER BY showdate LIMIT 5`
    ).bind(today).all();

    for (const { showdate } of results) {
      let actual;
      try { actual = await fetchActualSetlist(showdate, env.PHISHNET_API_KEY); }
      catch { continue; } // setlist not posted / API hiccup — retry next run
      if (!actual.length) continue;
      const n = await scoreShow(env, showdate, actual);
      console.log(`scored ${n} prediction(s) for ${showdate}`);
    }
    ctx.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE expires < ?1').bind(Date.now()).run());
  },
};
