import {
  slugifyName, FREE, bingoLine, scoreSetlistPrediction, scoreBingoPrediction,
} from '../lib/scoring.mjs';
import { fetchActualSetlist } from '../lib/phishnet-core.mjs';
import {
  MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, newSession, currentUser,
  sessionCookie, clearedSessionCookie, getCookie, sha256hex, timingSafeEqualStr, SESSION_COOKIE,
} from './auth.mjs';
import { rowToPrediction, userStats, publicUser, getUser } from './db.mjs';
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

async function api(request, env, ctx, { p, m, q, url }) {
  if (p === '/api/register' && m === 'POST') {
    const { name, password, displayName } = await body(request);
    if (!name || !name.trim()) return err(400, 'name required');
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return err(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const id = slugifyName(name);
    if (!id) return err(400, 'invalid name');

    const existing = await getUser(env, id);
    if (existing && existing.passhash) return err(409, 'that name is taken');

    const passhash = await hashPassword(password);
    const { token, stmt: sessionStmt } = await newSession(env, id);

    if (existing) {
      // legacy name-only account: setting a password claims it, and its predictions
      const profile = { ...JSON.parse(existing.profile || '{}'), displayName: displayName || existing.name };
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET passhash = ?1, profile = ?2 WHERE id = ?3')
          .bind(passhash, JSON.stringify(profile), id),
        sessionStmt,
      ]);
    } else {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, name, created, passhash, profile) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(id, name.trim(), new Date().toISOString(), passhash,
            JSON.stringify({ displayName: displayName || name.trim() })),
        sessionStmt,
      ]);
    }
    const user = await getUser(env, id);
    return json({ user: await publicUser(env, user) }, 200, { 'set-cookie': sessionCookie(token) });
  }

  if (p === '/api/login' && m === 'POST') {
    const { name, password } = await body(request);
    const user = await getUser(env, slugifyName(name || ''));
    if (user && !user.passhash) {
      return err(409, 'claimable', { message: 'This name has no password yet — use "Create account" with it to claim it and its predictions.' });
    }
    if (!user || !await verifyPassword(password || '', user.passhash)) {
      return err(401, 'wrong name or password');
    }
    const { token, stmt } = await newSession(env, user.id);
    await stmt.run();
    return json({ user: await publicUser(env, user) }, 200, { 'set-cookie': sessionCookie(token) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256hex(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie() });
  }

  if (p === '/api/me' && m === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    return json({ user: await publicUser(env, user) });
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
    return json({ user: await publicUser(env, { ...user, profile: JSON.stringify(profile) }) });
  }

  if (p.startsWith('/api/profile/') && m === 'GET') {
    const u = await getUser(env, p.split('/').pop());
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
    const user = q.get('user'), showdate = q.get('showdate');
    if (!user && !showdate) return err(400, 'user or showdate filter required');
    const where = [], binds = [];
    if (user) { binds.push(user); where.push(`user_id = ?${binds.length}`); }
    if (showdate) { binds.push(showdate); where.push(`showdate = ?${binds.length}`); }
    const { results } = await env.DB.prepare(
      `SELECT * FROM predictions WHERE ${where.join(' AND ')}`
    ).bind(...binds).all();
    return json(results.map(rowToPrediction));
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
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { predictionId, checked } = await body(request);
    const row = await env.DB.prepare('SELECT user_id, type FROM predictions WHERE id = ?1').bind(predictionId).first();
    if (!row) return err(404, 'not found');
    if (row.user_id !== user.id) return err(403, 'not your prediction');
    await env.DB.prepare('UPDATE predictions SET live_checked = ?1 WHERE id = ?2')
      .bind(JSON.stringify(checked), predictionId).run();
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
    return json(await userStats(env, p.split('/').pop()));
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
      `SELECT u.id, u.name, u.created, u.profile,
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
      return { id: r.id, name: r.name, created: r.created, profile: JSON.parse(r.profile || '{}'), stats, ...stats };
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
