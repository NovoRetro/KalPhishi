// D1 query helpers. Every row that leaves here is mapped back into the camelCase
// JSON shapes the frontend expects.
//
// users.id is internal: it never appears in any response or accepted query param.
// The public identifier is handle; email is shown only to its own account.

const parse = (s, fallback = null) => (s == null ? fallback : JSON.parse(s));

// Accounts created before email login could have an email address AS their name.
// Public shapes must never echo those; show the display name or handle instead.
import { isValidEmail } from '../lib/identity.mjs';
export function publicName(u) {
  if (!isValidEmail(u.name)) return u.name;
  const profile = typeof u.profile === 'string' ? parse(u.profile, {}) : (u.profile || {});
  return (profile && profile.displayName) || u.handle || 'phan';
}

// Public shape of a prediction row. Strips id (embeds the owner's internal id) and
// user_id; callers that know the owner attach userHandle themselves when needed.
export function rowToPrediction(r) {
  return {
    showdate: r.showdate,
    type: r.type,
    payload: parse(r.payload),
    created: r.created,
    updated: r.updated ?? undefined,
    result: parse(r.result),
    liveChecked: parse(r.live_checked),
    scoredAt: r.scored_at ?? undefined,
  };
}

const EMPTY_STATS = {
  predictions: 0, scored: 0, accuracy: null, bingos: 0,
  showsAttended: 0, accuracyAtShows: null, accuracyRemote: null,
};

export async function userStats(env, userId) {
  // Accuracy split by whether the user was physically at the show. The LEFT JOIN is on
  // (user_id, showdate) so a prediction counts as "at the show" only when that same user
  // marked that same date — AVG ignores NULLs, so each side averages only its own rows.
  // Either side stays null until there's a scored prediction of that kind, which the UI
  // uses to avoid showing a split built on one data point.
  const row = await env.DB.prepare(
    `SELECT COUNT(*)        AS predictions,
            COUNT(p.result) AS scored,
            ROUND(AVG(p.score), 1) AS accuracy,
            SUM(CASE WHEN p.type = 'bingo' AND p.bingo = 1 THEN 1 ELSE 0 END) AS bingos,
            ROUND(AVG(CASE WHEN a.user_id IS NOT NULL THEN p.score END), 1) AS accuracyAtShows,
            ROUND(AVG(CASE WHEN a.user_id IS     NULL THEN p.score END), 1) AS accuracyRemote
       FROM predictions p
       LEFT JOIN attendance a
         ON a.user_id = p.user_id AND a.showdate = p.showdate
      WHERE p.user_id = ?1`
  ).bind(userId).first();

  // Counted separately: a user can attend shows they never predicted, so this must not
  // be derived from the predictions join above.
  const att = await env.DB.prepare(
    'SELECT COUNT(*) AS showsAttended FROM attendance WHERE user_id = ?1'
  ).bind(userId).first();

  if (!row) return { ...EMPTY_STATS };
  return {
    ...row,
    bingos: row.bingos || 0,
    showsAttended: att?.showsAttended || 0,
  };
}

export async function attendedShows(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT showdate FROM attendance WHERE user_id = ?1 ORDER BY showdate DESC'
  ).bind(userId).all();
  return results.map(r => r.showdate);
}

// What anyone may see about a user. No id, no email — including an email hiding in name.
export async function publicUser(env, u) {
  return {
    handle: u.handle,
    name: publicName(u),
    created: u.created,
    profile: parse(u.profile, {}) || {},
    stats: await userStats(env, u.id),
  };
}

// What a user sees about themselves: the public shape plus their login email and
// whether the account still needs one linked (pre-email accounts).
export async function ownUser(env, u) {
  return {
    ...(await publicUser(env, u)),
    email: u.email ?? null,
    needsEmail: !u.email,
  };
}

const USER_COLS = 'id, name, created, passhash, profile, email, handle';

export const getUser = (env, id) =>
  env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1`).bind(id).first();

export const getUserByEmail = (env, email) =>
  env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE LOWER(email) = LOWER(?1)`).bind(email).first();

export const getUserByHandle = (env, handle) =>
  env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE LOWER(handle) = LOWER(?1)`).bind(handle).first();

// True while any account predates email login; the legacy name+password path stays
// alive until this is false, then its code gets deleted (roadmap, Phase 1).
export async function anyUserLacksEmail(env) {
  const row = await env.DB.prepare('SELECT 1 AS x FROM users WHERE email IS NULL LIMIT 1').first();
  return !!row;
}
