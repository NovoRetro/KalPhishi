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
  predictions: 0, scored: 0, bingos: 0, showsAttended: 0,
  setlistPoints: null, setlistScored: 0, bingoScore: null, bingoScored: 0,
  pointsAtShows: null, pointsRemote: null,
};

// Setlist and bingo scores no longer share a scale — setlist is absolute points (roughly
// 5-25), bingo is still out of 100 — so they can never be averaged into one figure again.
// Anything that did would rank whoever happened to play more bingo.
//
// Setlist predictions graded BEFORE the points system are excluded from the points
// average: their scores are on the old 0-100 scale and have no `breakdown` key, which is
// how they are told apart. They still count as scored and still render in history — only
// the aggregate skips them, so nobody's record is rewritten to make the maths tidy.
const CURRENT_SETLIST = `p.type = 'setlist' AND json_extract(p.result, '$.breakdown') IS NOT NULL`;
const SCORED_BINGO = `p.type = 'bingo' AND p.result IS NOT NULL`;

export async function userStats(env, userId) {
  // Points split by whether the user was physically at the show. The LEFT JOIN is on
  // (user_id, showdate) so a prediction counts as "at the show" only when that same user
  // marked that same date — AVG ignores NULLs, so each side averages only its own rows.
  // Either side stays null until there's a scored prediction of that kind, which the UI
  // uses to avoid showing a split built on one data point.
  const row = await env.DB.prepare(
    `SELECT COUNT(*)        AS predictions,
            COUNT(p.result) AS scored,
            SUM(CASE WHEN p.type = 'bingo' AND p.bingo = 1 THEN 1 ELSE 0 END) AS bingos,
            ROUND(AVG(CASE WHEN ${CURRENT_SETLIST} THEN p.score END), 1) AS setlistPoints,
            SUM(CASE WHEN ${CURRENT_SETLIST} THEN 1 ELSE 0 END)             AS setlistScored,
            ROUND(AVG(CASE WHEN ${SCORED_BINGO} THEN p.score END), 1)       AS bingoScore,
            SUM(CASE WHEN ${SCORED_BINGO} THEN 1 ELSE 0 END)                AS bingoScored,
            ROUND(AVG(CASE WHEN a.user_id IS NOT NULL AND ${CURRENT_SETLIST} THEN p.score END), 1) AS pointsAtShows,
            ROUND(AVG(CASE WHEN a.user_id IS     NULL AND ${CURRENT_SETLIST} THEN p.score END), 1) AS pointsRemote
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
    setlistScored: row.setlistScored || 0,
    bingoScored: row.bingoScored || 0,
    showsAttended: att?.showsAttended || 0,
  };
}

// The two scales, exported so the leaderboard query stays in step with userStats.
export const STAT_SQL = { CURRENT_SETLIST, SCORED_BINGO };

export async function attendedShows(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT showdate FROM attendance WHERE user_id = ?1 ORDER BY showdate DESC'
  ).bind(userId).all();
  return results.map(r => r.showdate);
}

// Friendships are stored in both directions, so one lookup on user_id is enough.
// Returns the public shape of each friend — never their id or email.
export async function friendsOf(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT u.name, u.handle, u.profile, f.created
       FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?1
      ORDER BY f.created DESC`
  ).bind(userId).all();
  return results.map(r => ({
    handle: r.handle,
    name: publicName(r),
    profile: parse(r.profile, {}) || {},
    since: r.created,
  }));
}

export async function areFriends(env, a, b) {
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM friendships WHERE user_id = ?1 AND friend_id = ?2'
  ).bind(a, b).first();
  return !!row;
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
