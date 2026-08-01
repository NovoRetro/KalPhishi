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

const EMPTY_STATS = { predictions: 0, scored: 0, accuracy: null, bingos: 0 };

export async function userStats(env, userId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*)        AS predictions,
            COUNT(result)   AS scored,
            ROUND(AVG(score), 1) AS accuracy,
            SUM(CASE WHEN type = 'bingo' AND bingo = 1 THEN 1 ELSE 0 END) AS bingos
       FROM predictions WHERE user_id = ?1`
  ).bind(userId).first();
  return row ? { ...row, bingos: row.bingos || 0 } : { ...EMPTY_STATS };
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
