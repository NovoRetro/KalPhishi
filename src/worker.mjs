import {
  slugifyName, FREE, bingoLine, scoreSetlistPrediction, scoreBingoPrediction,
  scoreWombatPrediction,
} from '../lib/scoring.mjs';
import {
  normalizeEmail, isValidEmail, handleCandidates, slugifyHandle, isValidHandle,
  sanitizeLine, sanitizeBlock, sanitizeAvatar, NAME_MAX, BIO_MAX,
} from '../lib/identity.mjs';
import { fetchActualSetlist } from '../lib/phishnet-core.mjs';
import {
  MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, newSession, newToken, currentUser,
  sessionCookie, clearedSessionCookie, getCookie, sha256hex, timingSafeEqualStr, SESSION_COOKIE,
  RESET_TTL_MS,
} from './auth.mjs';
import {
  rowToPrediction, userStats, publicUser, ownUser, publicName,
  getUser, getUserByEmail, getUserByHandle, anyUserLacksEmail, attendedShows,
  friendsOf, areFriends, STAT_SQL, NOT_BANNED, isBanned,
} from './db.mjs';
import { venueSlice } from './phishnet.mjs';
import { lockStateFor } from '../lib/showtime.mjs';
import { SHOWTIMES } from './showtimes.generated.mjs';

const lockState = showdate => lockStateFor(SHOWTIMES, showdate);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status, error, extra = {}) => json({ error, ...extra }, status);

const PROFILE_FIELDS = ['displayName', 'avatar', 'hometown', 'favoriteSong', 'bio'];
// Booleans that ride in the same JSON blob. Kept apart from PROFILE_FIELDS because the text
// sanitisers do not apply to them, and in `profile` rather than a column because it needs no
// migration and nothing queries on it — see the first-run wizard in predictor.js.
const PROFILE_FLAGS = ['wizardSeen'];

// Defaults for a new invite link. Enough for a household or a small crew without thinking
// about it; a cohort organizer raises them deliberately. The schema has always honoured
// NULL as "no limit" — these decide what you get when you don't say.
const DEFAULT_INVITE_USES = 10;
const DEFAULT_INVITE_DAYS = 30;

// An omitted limit takes the default; an explicit 0 means no limit. Distinguishing the two
// is the whole point — defaulting a missing field to unlimited is how every link ends up
// unlimited, which is where this started.
const pickLimit = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
};

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
    // Wombat is graded as facts (which ranked songs played), score NULL — points are a
    // property of (show, crew) and are computed at read; see scoreWombatPrediction.
    const result = r.type === 'setlist' ? scoreSetlistPrediction(payload, actual)
      : r.type === 'bingo' ? scoreBingoPrediction(payload, actual)
      : scoreWombatPrediction(payload, actual);
    return env.DB.prepare(
      'UPDATE predictions SET result = ?1, score = ?2, bingo = ?3, scored_at = ?4 WHERE id = ?5'
    ).bind(JSON.stringify(result), result.score ?? null, result.bingo ? 1 : 0, now, r.id);
  });
  await env.DB.batch(stmts);
  return results.length;
}

// First free handle for a display name. The candidate sequence is pure
// (lib/identity.mjs); only the availability check touches the database.
// Shared by scoring and moderation. Constant-time compare, and a missing ADMIN_TOKEN
// denies rather than opening the routes up.
const isAdmin = (request, env) =>
  !!env.ADMIN_TOKEN && timingSafeEqualStr(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN);

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
      const claimed = sanitizeLine(displayName) || sanitizeLine(existing.name);
      const profile = { ...JSON.parse(existing.profile || '{}'), displayName: claimed };
      const handle = existing.handle || await assignHandle(env, claimed);
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
    // Sanitised before the handle is derived from it, so the slug cannot be built out of
    // invisible or lookalike characters. This path previously bound the raw string: it had
    // no length cap at all, where the profile update has always truncated at 80.
    const cleanName = sanitizeLine(displayName);
    const handle = await assignHandle(env, cleanName);
    const { token, stmt: sessionStmt } = await newSession(env, id);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (id, name, created, passhash, profile, email, handle) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
      ).bind(id, cleanName || email, new Date().toISOString(), passhash,
        JSON.stringify({ displayName: cleanName || handle }), email, handle),
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
    // Checked after the password so a wrong guess cannot be used to discover which
    // accounts are banned. Deliberately its own message: the credentials were correct,
    // and "wrong password" would send someone into a reset loop that cannot help them.
    if (isBanned(user)) return err(403, 'this account has been suspended');
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

  if (p === '/api/password' && m === 'PUT') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { currentPassword, newPassword } = await body(request);
    if (!await verifyPassword(currentPassword || '', user.passhash)) {
      return err(403, 'current password is wrong');
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      return err(400, `new password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    // Re-hash and revoke every OTHER session: changing the password is the "kick out
    // whoever else has this account open" lever. The caller's session stays alive.
    const token = getCookie(request, SESSION_COOKIE);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET passhash = ?1 WHERE id = ?2')
        .bind(await hashPassword(newPassword), user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2')
        .bind(user.id, await sha256hex(token)),
    ]);
    return json({ ok: true });
  }

  // Redeem a reset link. Unauthenticated by necessity — the whole point is that the caller
  // cannot sign in — so the token is the entire proof, and everything below exists to keep
  // it from being worth more than one use.
  if (p === '/api/password/reset' && m === 'POST') {
    const { token, newPassword } = await body(request);
    if (!token) return err(400, 'that reset link is not valid');

    const row = await env.DB.prepare(
      'SELECT token_hash, user_id, expires, used_at FROM password_resets WHERE token_hash = ?1'
    ).bind(await sha256hex(String(token))).first();

    // One message for missing, spent and expired alike. Telling the difference would say
    // whether a token ever existed, which is the only thing guessing could learn.
    const dead = !row || row.used_at || row.expires < Date.now();
    if (dead) return err(410, 'that reset link has expired or already been used');

    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      return err(400, `new password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const target = await getUser(env, row.user_id);
    if (!target) return err(410, 'that reset link has expired or already been used');
    // Re-checked here and not only at issue time: a ban can land in between.
    if (target.banned_at) return err(403, 'that account is not available');

    await env.DB.batch([
      env.DB.prepare('UPDATE users SET passhash = ?1 WHERE id = ?2')
        .bind(await hashPassword(newPassword), target.id),
      // Spent, not deleted. The row is what makes a second attempt fail closed, and it
      // records that a reset happened at all.
      env.DB.prepare('UPDATE password_resets SET used_at = ?1 WHERE token_hash = ?2')
        .bind(new Date().toISOString(), row.token_hash),
      // Every session, including any the previous holder still had open. /api/password
      // spares the caller's own session because it knows who the caller is; here nobody is
      // signed in, and a forgotten password is exactly the case where somebody else may
      // have had the account open.
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(target.id),
    ]);

    // No session is issued. They sign in with the new password, which proves it took and
    // means a leaked link cannot become a live session on its own.
    return json({ ok: true, email: target.email || null });
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
    // Truncating was never enough on its own — it bounded the length of a name that could
    // still render blank, reversed, or as a lookalike of somebody else's.
    for (const f of PROFILE_FIELDS) {
      if (!(f in b)) continue;
      if (f === 'avatar') profile[f] = sanitizeAvatar(b[f]);
      else if (f === 'bio') profile[f] = sanitizeBlock(b[f], BIO_MAX);
      else profile[f] = sanitizeLine(b[f], NAME_MAX);
    }
    // Flags are stored beside the text but never sanitized as text. Running sanitizeLine
    // over a boolean would persist the string "true", which is truthy on the way back out
    // and would look like it worked right up until something compared it to `true`.
    for (const f of PROFILE_FLAGS) {
      if (f in b) profile[f] = !!b[f];
    }
    await env.DB.prepare('UPDATE users SET profile = ?1 WHERE id = ?2').bind(JSON.stringify(profile), user.id).run();
    return json({ user: await ownUser(env, { ...user, profile: JSON.stringify(profile) }) });
  }

  if (p.startsWith('/api/profile/') && m === 'GET') {
    const u = await getUserByHandle(env, p.split('/').pop());
    // Same 404 as a handle that never existed — a distinct "banned" response would just
    // confirm the account to anyone probing for it.
    if (!u || isBanned(u)) return err(404, 'no such user');
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
        WHERE ${where.join(' AND ')} AND u.${NOT_BANNED}`
    ).bind(...binds).all();

    // Sealed until the downbeat (SOCIAL-PLAN.md, Phase 0). This route used to hand full
    // payloads to anyone before the lock — nothing in the UI read them, but the API was
    // an open window onto every unlocked pick, and the moment picks are shareable that
    // window is the game's integrity model. The rules, per row:
    //   - your own predictions are always fully visible;
    //   - anyone else's, while the show is still open, is the FACT of a prediction and
    //     nothing more — the sealed shape carries no payload key at all, not a nulled one;
    //   - once the show locks, payloads open to the predictor's friends and to anyone
    //     sharing a group with them, which is what reveal night reads. Strangers stay
    //     sealed — public accuracy lives on the leaderboards, in aggregate.
    // The lock comes from the same lockState the save route enforces, never a hand-rolled
    // date compare. A show missing from SHOWTIMES reads as NOT locked and therefore stays
    // sealed to others — when the clock is unknowable this fails toward secrecy.
    const me = await currentUser(request, env);
    // One query for the whole visibility circle rather than a friendship check per row:
    // the history query returns hundreds of rows for one predictor, and the showdate
    // query returns one row each for many predictors — both collapse to a Set lookup.
    let circle = new Set();
    if (me && results.some(r => r.user_id !== me.id)) {
      const { results: vis } = await env.DB.prepare(
        `SELECT friend_id AS uid FROM friendships WHERE user_id = ?1
         UNION
         SELECT m2.user_id AS uid FROM friend_group_members m1
           JOIN friend_group_members m2 ON m2.group_id = m1.group_id
          WHERE m1.user_id = ?1`
      ).bind(me.id).all();
      circle = new Set(vis.map(v => v.uid));
    }
    return json(results.map(r => {
      const own = !!me && r.user_id === me.id;
      if (own) return { ...rowToPrediction(r), userHandle: r.user_handle };
      const open = !lockState(r.showdate).locked;
      if (open || !circle.has(r.user_id)) {
        return { userHandle: r.user_handle, showdate: r.showdate, type: r.type, sealed: true };
      }
      return { ...rowToPrediction(r), userHandle: r.user_handle };
    }));
  }

  if (p === '/api/predictions' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { showdate, type, payload } = await body(request);
    if (!showdate || !['setlist', 'bingo', 'wombat'].includes(type) || !payload) {
      return err(400, 'showdate, type (setlist|bingo|wombat), payload required');
    }
    if (type === 'bingo') {
      const slugs = payload.grid.filter((c, i) => i !== FREE && c).map(c => c.slug);
      if (new Set(slugs).size !== slugs.length) return err(400, 'duplicate songs in grid');
    }
    if (type === 'wombat') {
      // An ordered list of at most ten distinct songs. Order IS the payload — rank is
      // array position — so the server checks shape and uniqueness and nothing else;
      // resolution against the rest of a crew happens at read time, never here.
      const ranks = payload.ranks;
      if (!Array.isArray(ranks) || !ranks.length || ranks.length > 10) {
        return err(400, 'wombat payload is ranks: 1-10 songs in order');
      }
      const slugs = ranks.map(r => r && r.slug).filter(Boolean);
      if (slugs.length !== ranks.length) return err(400, 'every rank needs a song');
      if (new Set(slugs).size !== slugs.length) return err(400, 'duplicate songs in ranks');
    }
    // Predictions lock at the published downbeat. This belongs here, not in the builder:
    // a disabled button stops nobody from POSTing, and a prediction edited after the first
    // song has been played is not a prediction.
    const lock = lockState(showdate);
    if (lock.locked) return err(423, 'locked — the show has started', { lockAt: lock.lockAt });
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

  if (p === '/api/friends' && m === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    return json({ friends: await friendsOf(env, user.id) });
  }

  if (p.startsWith('/api/friends/') && m === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const other = await getUserByHandle(env, decodeURIComponent(p.split('/').pop()));
    if (!other) return err(404, 'no such user');
    // Both directions, or the two of them would disagree about being friends. Group
    // membership goes too — groups are friends-only, so leaving them behind would strand
    // someone in a group they could no longer be re-added to. Each direction only touches
    // groups the *other* person owns... but expressed as: drop each from the other's
    // owned groups, so neither keeps the other in a group after the friendship ends.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(user.id, other.id),
      env.DB.prepare('DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(other.id, user.id),
      env.DB.prepare(
        `DELETE FROM friend_group_members
          WHERE user_id = ?2
            AND group_id IN (SELECT id FROM friend_groups WHERE owner_id = ?1)`
      ).bind(user.id, other.id),
      env.DB.prepare(
        `DELETE FROM friend_group_members
          WHERE user_id = ?1
            AND group_id IN (SELECT id FROM friend_groups WHERE owner_id = ?2)`
      ).bind(user.id, other.id),
    ]);
    return json({ ok: true });
  }

  if (p === '/api/groups' && m === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    // Groups you're in, whether you made them or were added — owner-ness is a flag on
    // the row rather than a separate list, so the UI can show both in one place.
    // With ?showdate=, each group also carries inCount: how many members have saved ANY
    // prediction for that show. A count of participation, never of content — it reveals
    // less than the sealed shape on /api/predictions already does, and it is what lets
    // the drawer say "7 members · 4 in for Fri" without a request per group.
    const showdate = q.get('showdate');
    const inSel = showdate
      ? `, (SELECT COUNT(DISTINCT pr.user_id) FROM predictions pr
             JOIN friend_group_members pm ON pm.user_id = pr.user_id AND pm.group_id = g.id
            WHERE pr.showdate = ?2) AS inCount`
      : '';
    const binds = showdate ? [user.id, showdate] : [user.id];
    const { results } = await env.DB.prepare(
      `SELECT g.id, g.name, g.owner_id, g.created,
              (SELECT COUNT(*) FROM friend_group_members WHERE group_id = g.id) AS memberCount${inSel}
         FROM friend_groups g
         JOIN friend_group_members mem ON mem.group_id = g.id AND mem.user_id = ?1
        ORDER BY g.created DESC`
    ).bind(...binds).all();
    return json({
      groups: results.map(r => ({
        id: r.id, name: r.name, memberCount: r.memberCount,
        created: r.created, isOwner: r.owner_id === user.id,
        ...(showdate ? { inCount: r.inCount } : {}),
      })),
    });
  }

  if (p === '/api/groups' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { name } = await body(request);
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean) return err(400, 'group name required');
    const id = [...crypto.getRandomValues(new Uint8Array(8))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const now = new Date().toISOString();
    // Owner joins as a member in the same batch, so a group is never memberless.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO friend_groups (id, owner_id, name, created) VALUES (?1, ?2, ?3, ?4)')
        .bind(id, user.id, clean, now),
      env.DB.prepare('INSERT INTO friend_group_members (group_id, user_id, created) VALUES (?1, ?2, ?3)')
        .bind(id, user.id, now),
    ]);
    return json({ group: { id, name: clean, memberCount: 1, created: now, isOwner: true } });
  }

  // Rename. Owner-only, like every other write to the group itself; the same 40-char cap
  // as create, because a rename that could exceed what create allows would be a second,
  // looser validator for the same column. Scoped UPDATE for the same reason the DELETE
  // is: renaming someone else's group is a silent no-op rather than a confirmation that
  // the id exists. Wanted by the Crew page's owner tools (SOCIAL-PLAN.md, Phase 2).
  if (p.startsWith('/api/groups/') && !p.includes('/members') && m === 'PATCH') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const gid = decodeURIComponent(p.split('/').pop());
    const { name } = await body(request);
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean) return err(400, 'group name required');
    await env.DB.prepare('UPDATE friend_groups SET name = ?1 WHERE id = ?2 AND owner_id = ?3')
      .bind(clean, gid, user.id).run();
    return json({ ok: true, name: clean });
  }

  if (p.startsWith('/api/groups/') && p.endsWith('/members') && m === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const gid = decodeURIComponent(p.split('/').slice(-2)[0]);
    // Membership is the read permission: you can only see a group you're part of.
    const mine = await env.DB.prepare(
      'SELECT 1 AS ok FROM friend_group_members WHERE group_id = ?1 AND user_id = ?2'
    ).bind(gid, user.id).first();
    if (!mine) return err(404, 'no such group');
    const { results } = await env.DB.prepare(
      `SELECT u.handle, u.name, u.profile, u.id AS uid, (g.owner_id = u.id) AS isOwner
         FROM friend_group_members mem
         JOIN users u ON u.id = mem.user_id
         JOIN friend_groups g ON g.id = mem.group_id
        WHERE mem.group_id = ?1
        ORDER BY isOwner DESC, mem.created ASC`
    ).bind(gid).all();
    // With ?showdate=, each member carries { setlist, bingo } booleans for that show —
    // the roster's "in for Friday" dots. Booleans derived here and only here: this route
    // must never grow a payload column, or the roster becomes a way around the sealed
    // shape on /api/predictions. SOCIAL-PLAN.md, Phase 1.
    const showdate = q.get('showdate');
    let inFor = new Map();
    if (showdate) {
      const { results: preds } = await env.DB.prepare(
        `SELECT pr.user_id, pr.type FROM predictions pr
           JOIN friend_group_members pm ON pm.user_id = pr.user_id
          WHERE pm.group_id = ?1 AND pr.showdate = ?2`
      ).bind(gid, showdate).all();
      for (const pr of preds) {
        const cur = inFor.get(pr.user_id) || { setlist: false, bingo: false, wombat: false };
        if (pr.type === 'setlist') cur.setlist = true;
        if (pr.type === 'bingo') cur.bingo = true;
        if (pr.type === 'wombat') cur.wombat = true;
        inFor.set(pr.user_id, cur);
      }
    }
    return json({
      members: results.map(r => ({
        handle: r.handle, name: publicName(r),
        profile: JSON.parse(r.profile || '{}'), isOwner: !!r.isOwner,
        ...(showdate ? (inFor.get(r.uid) || { setlist: false, bingo: false, wombat: false }) : {}),
      })),
    });
  }

  if (p.startsWith('/api/groups/') && p.endsWith('/members') && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const gid = decodeURIComponent(p.split('/').slice(-2)[0]);
    const g = await env.DB.prepare('SELECT id, owner_id FROM friend_groups WHERE id = ?1').bind(gid).first();
    if (!g) return err(404, 'no such group');
    if (g.owner_id !== user.id) return err(403, 'only the group owner can add people');
    const { handle } = await body(request);
    const target = await getUserByHandle(env, String(handle ?? '').trim());
    if (!target) return err(404, 'no such user');
    // Friends-only: the invite link stays the single way to connect to someone.
    if (!(await areFriends(env, user.id, target.id))) {
      return err(400, 'you can only add your own friends to a group');
    }
    await env.DB.prepare(
      'INSERT INTO friend_group_members (group_id, user_id, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING'
    ).bind(gid, target.id, new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (p.startsWith('/api/groups/') && p.includes('/members/') && m === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const parts = p.split('/');
    const gid = decodeURIComponent(parts[parts.length - 3]);
    const handle = decodeURIComponent(parts[parts.length - 1]);
    const g = await env.DB.prepare('SELECT id, owner_id FROM friend_groups WHERE id = ?1').bind(gid).first();
    if (!g) return err(404, 'no such group');
    const target = await getUserByHandle(env, handle);
    if (!target) return err(404, 'no such user');
    // The owner can remove anyone; anyone else may only remove themselves (leave).
    const isSelf = target.id === user.id;
    if (g.owner_id !== user.id && !isSelf) return err(403, 'only the group owner can remove people');
    if (g.owner_id === target.id) {
      return err(400, 'the owner cannot leave their own group — delete it instead');
    }
    await env.DB.prepare('DELETE FROM friend_group_members WHERE group_id = ?1 AND user_id = ?2')
      .bind(gid, target.id).run();
    return json({ ok: true });
  }

  if (p.startsWith('/api/groups/') && m === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    // Scoped to owner_id: deleting someone else's group is a silent no-op, matching how
    // invite revocation avoids confirming what exists.
    await env.DB.prepare('DELETE FROM friend_groups WHERE id = ?1 AND owner_id = ?2')
      .bind(decodeURIComponent(p.split('/').pop()), user.id).run();
    return json({ ok: true });
  }

  if (p === '/api/invites' && m === 'GET') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    // The group is joined to its name here rather than fetched per row by the UI: a link
    // that says only "invite" gives the sharer no way to tell a plain one from one that
    // drops whoever opens it into a group.
    const { results } = await env.DB.prepare(
      `SELECT i.code, i.created, i.expires, i.max_uses, i.uses, i.group_id, g.name AS group_name
         FROM invites i
         LEFT JOIN friend_groups g ON g.id = i.group_id
        WHERE i.owner_id = ?1
        ORDER BY i.created DESC`
    ).bind(user.id).all();
    return json({
      invites: results.map(r => ({
        code: r.code, created: r.created, expires: r.expires,
        maxUses: r.max_uses, uses: r.uses,
        group: r.group_id && r.group_name ? { id: r.group_id, name: r.group_name } : null,
        // Computed server-side so the UI doesn't re-derive expiry rules and drift.
        spent: r.max_uses != null && r.uses >= r.max_uses,
        expired: r.expires != null && r.expires < Date.now(),
      })),
    });
  }

  if (p === '/api/invites' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { maxUses, expiresInDays, groupId } = await body(request).catch(() => ({}));

    // Only the group's owner can mint a link into it, because redeeming one is exactly the
    // add-a-member act, and that is owner-only everywhere else. Re-checked at redemption.
    let group = null;
    if (groupId) {
      group = await env.DB.prepare(
        'SELECT id, name FROM friend_groups WHERE id = ?1 AND owner_id = ?2'
      ).bind(String(groupId), user.id).first();
      if (!group) return err(404, 'no such group');
    }

    // 16 bytes of randomness, hex — a bearer token, so unguessable matters more than short.
    const code = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    // Bounded unless the creator says otherwise: an unlimited link is one forum post away
    // from putting strangers in a tester's friends list and on the leaderboard they meant
    // to compare against. 0 is the explicit opt-out, kept distinct from "field omitted" so
    // an old client sending {} still gets the safe shape.
    const days = pickLimit(expiresInDays, DEFAULT_INVITE_DAYS);
    const expires = days == null ? null : Date.now() + days * 86_400_000;
    const max = pickLimit(maxUses, DEFAULT_INVITE_USES);
    await env.DB.prepare(
      `INSERT INTO invites (code, owner_id, created, expires, max_uses, uses, group_id)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`
    ).bind(code, user.id, new Date().toISOString(), expires, max, group?.id ?? null).run();
    return json({
      code, url: `${url.origin}/?invite=${code}`,
      maxUses: max, expires, group: group ? { id: group.id, name: group.name } : null,
    });
  }

  if (p.startsWith('/api/invites/') && p.endsWith('/redeem') && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const code = decodeURIComponent(p.split('/').slice(-2)[0]);
    const inv = await env.DB.prepare(
      'SELECT code, owner_id, expires, max_uses, uses, group_id FROM invites WHERE code = ?1'
    ).bind(code).first();
    if (!inv) return err(404, 'that invite link is not valid');
    if (inv.owner_id === user.id) return err(400, "that's your own invite link");
    if (inv.expires != null && inv.expires < Date.now()) return err(410, 'that invite link has expired');
    if (inv.max_uses != null && inv.uses >= inv.max_uses) return err(410, 'that invite link has been used up');

    const owner = await getUser(env, inv.owner_id);
    if (!owner) return err(404, 'that invite link is not valid');

    // Re-resolved at redemption, and pinned to the invite's owner — the same re-check the
    // reset flow does for bans. A group deleted since the link was minted, or somehow no
    // longer the owner's, degrades this to a plain friend invite rather than failing: the
    // friendship is still the thing the redeemer was promised.
    const group = inv.group_id
      ? await env.DB.prepare('SELECT id, name FROM friend_groups WHERE id = ?1 AND owner_id = ?2')
        .bind(inv.group_id, inv.owner_id).first()
      : null;

    const alreadyFriends = await areFriends(env, user.id, owner.id);
    const alreadyMember = group
      ? !!(await env.DB.prepare('SELECT 1 AS ok FROM friend_group_members WHERE group_id = ?1 AND user_id = ?2')
        .bind(group.id, user.id).first())
      : true;

    // Nothing left to do is a no-op success, not an error: re-opening a link you already
    // redeemed should be reassuring, not a failure. Doesn't burn a use. Being friends is no
    // longer enough on its own — a group link handed to an existing friend still has the
    // join to perform, and returning early there is how someone ends up outside the group
    // they were invited to with the app insisting it worked.
    if (alreadyFriends && alreadyMember) {
      return json({
        ok: true, already: true,
        friend: { handle: owner.handle, name: publicName(owner) },
        group: group ? { id: group.id, name: group.name } : null,
      });
    }

    const now = new Date().toISOString();
    // One batch: a friendship can never be half-formed, the group join can never land
    // without the friendship that authorises it, and a redeem can never succeed without
    // also being counted against max_uses.
    const stmts = [];
    if (!alreadyFriends) {
      stmts.push(
        env.DB.prepare('INSERT INTO friendships (user_id, friend_id, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
          .bind(user.id, owner.id, now),
        env.DB.prepare('INSERT INTO friendships (user_id, friend_id, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
          .bind(owner.id, user.id, now),
      );
    }
    if (group && !alreadyMember) {
      stmts.push(
        env.DB.prepare('INSERT INTO friend_group_members (group_id, user_id, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
          .bind(group.id, user.id, now),
      );
    }
    stmts.push(env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?1').bind(code));
    await env.DB.batch(stmts);
    return json({
      ok: true,
      friend: { handle: owner.handle, name: publicName(owner) },
      group: group ? { id: group.id, name: group.name } : null,
      joinedGroup: !!(group && !alreadyMember),
    });
  }

  if (p.startsWith('/api/invites/') && m === 'DELETE') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    // Scoped to owner_id so a code can only be revoked by whoever created it.
    await env.DB.prepare('DELETE FROM invites WHERE code = ?1 AND owner_id = ?2')
      .bind(decodeURIComponent(p.split('/').pop()), user.id).run();
    return json({ ok: true });
  }

  if (p === '/api/attendance' && m === 'GET') {
    // Own attendance by default; ?user=<handle> exposes someone else's, which is fine —
    // "I was at this show" is public-facing, the same as a prediction.
    const handle = q.get('user');
    let userId;
    if (handle) {
      const target = await getUserByHandle(env, handle);
      if (!target) return err(404, 'no such user');
      userId = target.id;
    } else {
      const me = await currentUser(request, env);
      if (!me) return err(401, 'not signed in');
      userId = me.id;
    }
    return json({ showdates: await attendedShows(env, userId) });
  }

  if (p === '/api/attendance' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { showdate, attended } = await body(request);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(showdate || '')) return err(400, 'showdate must be YYYY-MM-DD');
    if (attended) {
      // Idempotent: re-marking an already-marked show must not error or move `created`.
      await env.DB.prepare(
        'INSERT INTO attendance (user_id, showdate, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING'
      ).bind(user.id, showdate, new Date().toISOString()).run();
    } else {
      await env.DB.prepare('DELETE FROM attendance WHERE user_id = ?1 AND showdate = ?2')
        .bind(user.id, showdate).run();
    }
    return json({ ok: true, showdate, attended: !!attended });
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

  // ---- moderation ----
  // Registration is open and unverified. lib/identity.mjs stops lookalike and
  // invisible-character names, but a plainly offensive well-formed one passes it, and the
  // only remedy used to be editing D1 by hand. Gated on the same ADMIN_TOKEN header as
  // scoring rather than on a user role: there is no admin account, and inventing one would
  // be a bigger surface than the problem.
  if (p === '/api/admin/users' && m === 'GET') {
    if (!isAdmin(request, env)) return err(403, 'forbidden');
    const { results } = await env.DB.prepare(
      // No email and no id. Moderation works from the handle, which is public anyway, so
      // this does not need to weaken the rule that an address only ever goes to its owner.
      `SELECT name, handle, created, profile, banned_at, banned_reason,
              (SELECT COUNT(*) FROM predictions p WHERE p.user_id = users.id) AS predictions
         FROM users ORDER BY created DESC`
    ).all();
    return json(results.map(r => ({
      handle: r.handle,
      name: publicName(r),
      created: r.created,
      predictions: r.predictions,
      banned: r.banned_at ? { at: r.banned_at, reason: r.banned_reason || null } : null,
    })));
  }

  if (p.startsWith('/api/admin/users/') && m === 'PATCH') {
    if (!isAdmin(request, env)) return err(403, 'forbidden');
    const target = await getUserByHandle(env, decodeURIComponent(p.split('/').pop()));
    if (!target) return err(404, 'no such user');
    const b = await body(request);
    const sets = [], binds = [];
    const set = (sql, v) => { binds.push(v); sets.push(`${sql} = ?${binds.length}`); };

    // Renaming goes through the same sanitiser as self-service editing. An operator
    // cleaning up an offensive name has no reason to be exempt from normalisation, and
    // being exempt is how a lookalike gets introduced by the person removing one.
    let profile = JSON.parse(target.profile || '{}');
    if ('displayName' in b) {
      const clean = sanitizeLine(b.displayName);
      if (!clean) return err(400, 'displayName must contain something renderable');
      profile = { ...profile, displayName: clean };
      set('name', clean);
      set('profile', JSON.stringify(profile));
    }

    // The handle is the public profile URL, so an offensive one needs replacing too —
    // renaming the display name alone would leave it in place.
    if ('handle' in b) {
      const h = slugifyHandle(b.handle);
      if (!isValidHandle(h)) return err(400, 'handle must be 2-24 chars of a-z, 0-9 and dashes, and not reserved');
      const clash = await env.DB.prepare(
        'SELECT 1 AS x FROM users WHERE LOWER(handle) = LOWER(?1) AND id <> ?2'
      ).bind(h, target.id).first();
      if (clash) return err(409, 'that handle is taken');
      set('handle', h);
    }

    if ('banned' in b) {
      set('banned_at', b.banned ? new Date().toISOString() : null);
      set('banned_reason', b.banned ? sanitizeLine(b.reason, 200) || null : null);
    }

    if (!sets.length) return err(400, 'nothing to change: send displayName, handle and/or banned');
    binds.push(target.id);
    const stmts = [env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds)];
    // Revoking sessions is belt and braces — currentUser already refuses a banned account
    // — but it means the row is gone rather than merely inert.
    if (b.banned === true) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(target.id));
    await env.DB.batch(stmts);

    const updated = await getUser(env, target.id);
    return json({
      handle: updated.handle,
      name: publicName(updated),
      banned: updated.banned_at ? { at: updated.banned_at, reason: updated.banned_reason || null } : null,
    });
  }

  // Mint a single-use password reset link. Admin-only and handed over out of band, because
  // nothing is ever sent to the address on file — see migrations/0007_password_resets.sql.
  //
  // Deliberately NOT self-service. A public "forgot password" route with no mail delivery
  // could only ever verify the requester by something already in the database, which is
  // the same thing an attacker would have. An operator vouching for the person is the
  // stronger check while it stays a closed beta.
  if (p.startsWith('/api/admin/users/') && p.endsWith('/reset') && m === 'POST') {
    if (!isAdmin(request, env)) return err(403, 'forbidden');
    const target = await getUserByHandle(env, decodeURIComponent(p.split('/').slice(-2)[0]));
    if (!target) return err(404, 'no such user');
    // A reset would otherwise hand a banned account its way back in, quietly undoing the
    // ban for anyone who asked an operator nicely enough.
    if (target.banned_at) return err(409, 'that account is banned — unban it first');

    const token = newToken();
    const expires = Date.now() + RESET_TTL_MS;
    await env.DB.batch([
      // Issuing supersedes: only the newest link for an account can ever be redeemed, so a
      // link handed over twice by mistake does not leave two live ways in.
      env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?1').bind(target.id),
      env.DB.prepare(
        'INSERT INTO password_resets (token_hash, user_id, created, expires) VALUES (?1, ?2, ?3, ?4)'
      ).bind(await sha256hex(token), target.id, new Date().toISOString(), expires),
    ]);

    // The secret exists in this response and nowhere else — the row holds only its hash,
    // so it cannot be recovered later. Re-issue rather than go looking for it.
    return json({
      handle: target.handle,
      url: `${new URL(request.url).origin}/?reset=${token}`,
      expires: new Date(expires).toISOString(),
      expiresInHours: RESET_TTL_MS / 3600_000,
    });
  }

  // ---- reach ----
  // Who has not predicted the next open show.
  //
  // The entire outbound channel for this beta is a person writing in the group chat: there
  // is no mail, no service worker and no push, deliberately (roadmap item 4). That message
  // is the only thing that reaches a tester who has not opened the app — but it can only be
  // aimed and checked if something answers "who is missing", and nothing did. This is that
  // something. It sends nothing itself, on purpose: the delivery stays human.
  //
  // Handle-only, exactly like the moderation listing above, and for the same reason — a
  // handle is what you need to @ somebody in a chat and is public anyway, so this widens
  // nothing. It must never grow an email column: addresses here have never been verified,
  // and mail is the dependency this project has avoided from the start.
  if (p === '/api/admin/reach' && m === 'GET') {
    if (!isAdmin(request, env)) return err(403, 'forbidden');

    // Default to the next show still open, since that is the only one anybody can act on.
    // Resolved through lockState rather than by comparing dates, so this can never disagree
    // with the lock the POST route actually enforces. An explicit ?showdate= is allowed and
    // may be a locked one — "who missed night one" is a fair question the morning after.
    const showdate = q.get('showdate')
      || Object.keys(SHOWTIMES).sort().find(d => !lockState(d).locked)
      || null;
    // No upcoming show at all: the honest answer is nobody is missing anything, not an error.
    if (!showdate) return json({ show: null, totals: null, missing: [] });
    const lock = lockState(showdate);

    const { results } = await env.DB.prepare(
      // LEFT JOIN rather than NOT IN, because the useful answer is per game: the two are
      // scored separately and plenty of people only ever play one, so somebody missing only
      // bingo is a different message from somebody missing both.
      //
      // Banned accounts are excluded like everywhere else — a list of people to go and
      // chase is the last place one should reappear.
      `SELECT u.name, u.handle, u.profile, u.created,
              MAX(CASE WHEN p.type = 'setlist' THEN 1 ELSE 0 END) AS has_setlist,
              MAX(CASE WHEN p.type = 'bingo'   THEN 1 ELSE 0 END) AS has_bingo,
              (SELECT COUNT(*) FROM predictions a WHERE a.user_id = u.id) AS lifetime
         FROM users u
         LEFT JOIN predictions p ON p.user_id = u.id AND p.showdate = ?1
        WHERE u.${NOT_BANNED}
        GROUP BY u.id
        ORDER BY lifetime DESC, u.created ASC`
    ).bind(showdate).all();

    const rows = results.map(r => ({
      handle: r.handle,
      name: publicName(r),
      created: r.created,
      // 0 means they have never predicted anything, which needs a different message from
      // "you always play and haven't yet" — hence the warmest-first ordering above: those
      // are the ones a single nudge converts.
      lifetime: r.lifetime,
      needs: [!r.has_setlist && 'setlist', !r.has_bingo && 'bingo'].filter(Boolean),
    }));

    return json({
      show: {
        showdate,
        known: lock.known,
        locked: lock.locked,
        lockAt: lock.lockAt,
        local: lock.local ?? null,
        timeZone: lock.timeZone ?? null,
      },
      // The point of the counts is to be re-read after a message goes out. Nothing else in
      // the app can currently say whether one worked.
      totals: {
        users: rows.length,
        setlist: rows.filter(r => !r.needs.includes('setlist')).length,
        bingo: rows.filter(r => !r.needs.includes('bingo')).length,
        both: rows.filter(r => !r.needs.length).length,
        neither: rows.filter(r => r.needs.length === 2).length,
        neverPlayed: rows.filter(r => !r.lifetime).length,
      },
      missing: rows.filter(r => r.needs.length),
    });
  }

  if (p.startsWith('/api/score/') && m === 'POST') {
    if (!isAdmin(request, env)) return err(403, 'forbidden');
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
    // scope: everyone (default) | friends | group:<id>. Friends and group scopes need a
    // session; everyone stays open so a signed-out visitor still sees a board.
    const scope = q.get('scope') || 'everyone';
    let restrictSql = '', binds = [];
    if (scope !== 'everyone') {
      const me = await currentUser(request, env);
      if (!me) return err(401, 'sign in to see a scoped leaderboard');
      if (scope === 'friends') {
        // Include yourself — a leaderboard you're absent from isn't much of a comparison.
        restrictSql = `AND (u.id = ?1 OR u.id IN (SELECT friend_id FROM friendships WHERE user_id = ?1))`;
        binds = [me.id];
      } else if (scope.startsWith('group:')) {
        const gid = scope.slice('group:'.length);
        const mine = await env.DB.prepare(
          'SELECT 1 AS ok FROM friend_group_members WHERE group_id = ?1 AND user_id = ?2'
        ).bind(gid, me.id).first();
        if (!mine) return err(404, 'no such group');
        restrictSql = `AND u.id IN (SELECT user_id FROM friend_group_members WHERE group_id = ?1)`;
        binds = [gid];
      } else {
        return err(400, 'unknown scope');
      }
    }

    const stmt = env.DB.prepare(
      `SELECT u.handle, u.name, u.created, u.profile,
              COUNT(p.id)          AS predictions,
              COUNT(p.result)      AS scored,
              SUM(CASE WHEN p.type = 'bingo' AND p.bingo = 1 THEN 1 ELSE 0 END) AS bingos,
              ROUND(AVG(CASE WHEN ${STAT_SQL.CURRENT_SETLIST} THEN p.score END), 1) AS setlistPoints,
              SUM(CASE WHEN ${STAT_SQL.CURRENT_SETLIST} THEN 1 ELSE 0 END)          AS setlistScored,
              ROUND(AVG(CASE WHEN ${STAT_SQL.SCORED_BINGO} THEN p.score END), 1)    AS bingoScore,
              SUM(CASE WHEN ${STAT_SQL.SCORED_BINGO} THEN 1 ELSE 0 END)             AS bingoScored,
              (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.id) AS showsAttended
         FROM users u JOIN predictions p ON p.user_id = u.id
        WHERE u.${NOT_BANNED} ${restrictSql}
        GROUP BY u.id
       HAVING scored > 0
        -- Setlist points lead: it is the main game, and the two scales cannot be combined
        -- into one ranking. SQLite sorts NULL below everything, so players with no
        -- points-era setlist yet fall to the bottom rather than to the top.
        ORDER BY setlistPoints DESC, bingos DESC, bingoScore DESC, scored DESC`
    );
    const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all();
    // stats appear both nested and spread at top level — the frontend reads the top-level copies
    return json(results.map(r => {
      const stats = {
        predictions: r.predictions, scored: r.scored,
        setlistPoints: r.setlistPoints, setlistScored: r.setlistScored || 0,
        bingoScore: r.bingoScore, bingoScored: r.bingoScored || 0,
        bingos: r.bingos || 0, showsAttended: r.showsAttended || 0,
      };
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
    // Expired sessions and expired reset links age out the same way. A spent reset row is
    // swept on expiry too — it has already done its job of failing a second attempt, and
    // by then the link is dead on time alone.
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?1').bind(Date.now()),
      env.DB.prepare('DELETE FROM password_resets WHERE expires < ?1').bind(Date.now()),
    ]));
  },
};
