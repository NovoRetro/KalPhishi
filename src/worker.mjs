import {
  slugifyName, FREE, bingoLine, scoreSetlistPrediction, scoreBingoPrediction,
} from '../lib/scoring.mjs';
import {
  normalizeEmail, isValidEmail, handleCandidates, slugifyHandle, isValidHandle,
  sanitizeLine, sanitizeBlock, sanitizeAvatar, NAME_MAX, BIO_MAX,
} from '../lib/identity.mjs';
import { fetchActualSetlist } from '../lib/phishnet-core.mjs';
import {
  MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, newSession, currentUser,
  sessionCookie, clearedSessionCookie, getCookie, sha256hex, timingSafeEqualStr, SESSION_COOKIE,
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
    const { results } = await env.DB.prepare(
      `SELECT g.id, g.name, g.owner_id, g.created,
              (SELECT COUNT(*) FROM friend_group_members WHERE group_id = g.id) AS memberCount
         FROM friend_groups g
         JOIN friend_group_members mem ON mem.group_id = g.id AND mem.user_id = ?1
        ORDER BY g.created DESC`
    ).bind(user.id).all();
    return json({
      groups: results.map(r => ({
        id: r.id, name: r.name, memberCount: r.memberCount,
        created: r.created, isOwner: r.owner_id === user.id,
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
      `SELECT u.handle, u.name, u.profile, (g.owner_id = u.id) AS isOwner
         FROM friend_group_members mem
         JOIN users u ON u.id = mem.user_id
         JOIN friend_groups g ON g.id = mem.group_id
        WHERE mem.group_id = ?1
        ORDER BY isOwner DESC, mem.created ASC`
    ).bind(gid).all();
    return json({
      members: results.map(r => ({
        handle: r.handle, name: publicName(r),
        profile: JSON.parse(r.profile || '{}'), isOwner: !!r.isOwner,
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
    const { results } = await env.DB.prepare(
      'SELECT code, created, expires, max_uses, uses FROM invites WHERE owner_id = ?1 ORDER BY created DESC'
    ).bind(user.id).all();
    return json({
      invites: results.map(r => ({
        code: r.code, created: r.created, expires: r.expires,
        maxUses: r.max_uses, uses: r.uses,
        // Computed server-side so the UI doesn't re-derive expiry rules and drift.
        spent: r.max_uses != null && r.uses >= r.max_uses,
        expired: r.expires != null && r.expires < Date.now(),
      })),
    });
  }

  if (p === '/api/invites' && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const { maxUses, expiresInDays } = await body(request).catch(() => ({}));
    // 16 bytes of randomness, hex — a bearer token, so unguessable matters more than short.
    const code = [...crypto.getRandomValues(new Uint8Array(16))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const expires = Number.isFinite(expiresInDays) && expiresInDays > 0
      ? Date.now() + expiresInDays * 86_400_000 : null;
    const max = Number.isInteger(maxUses) && maxUses > 0 ? maxUses : null;
    await env.DB.prepare(
      'INSERT INTO invites (code, owner_id, created, expires, max_uses, uses) VALUES (?1, ?2, ?3, ?4, ?5, 0)'
    ).bind(code, user.id, new Date().toISOString(), expires, max).run();
    return json({ code, url: `${url.origin}/?invite=${code}` });
  }

  if (p.startsWith('/api/invites/') && p.endsWith('/redeem') && m === 'POST') {
    const user = await currentUser(request, env);
    if (!user) return err(401, 'not signed in');
    const code = decodeURIComponent(p.split('/').slice(-2)[0]);
    const inv = await env.DB.prepare(
      'SELECT code, owner_id, expires, max_uses, uses FROM invites WHERE code = ?1'
    ).bind(code).first();
    if (!inv) return err(404, 'that invite link is not valid');
    if (inv.owner_id === user.id) return err(400, "that's your own invite link");
    if (inv.expires != null && inv.expires < Date.now()) return err(410, 'that invite link has expired');
    if (inv.max_uses != null && inv.uses >= inv.max_uses) return err(410, 'that invite link has been used up');

    const owner = await getUser(env, inv.owner_id);
    if (!owner) return err(404, 'that invite link is not valid');

    // Already friends is a no-op success, not an error: re-opening a link you already
    // redeemed should be reassuring, not a failure. Doesn't burn a use.
    if (await areFriends(env, user.id, owner.id)) {
      return json({ ok: true, already: true, friend: { handle: owner.handle, name: publicName(owner) } });
    }

    const now = new Date().toISOString();
    // One batch: a friendship can never be half-formed, and a redeem can never succeed
    // without also being counted against max_uses.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO friendships (user_id, friend_id, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
        .bind(user.id, owner.id, now),
      env.DB.prepare('INSERT INTO friendships (user_id, friend_id, created) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
        .bind(owner.id, user.id, now),
      env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?1').bind(code),
    ]);
    return json({ ok: true, friend: { handle: owner.handle, name: publicName(owner) } });
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
    ctx.waitUntil(env.DB.prepare('DELETE FROM sessions WHERE expires < ?1').bind(Date.now()).run());
  },
};
