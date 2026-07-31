// D1 query helpers. Every row that leaves here is mapped back into the camelCase
// JSON shapes the frontend already expects.

const parse = (s, fallback = null) => (s == null ? fallback : JSON.parse(s));

export function rowToPrediction(r) {
  return {
    id: r.id,
    userId: r.user_id,
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

export async function publicUser(env, u) {
  return {
    id: u.id,
    name: u.name,
    created: u.created,
    profile: parse(u.profile, {}) || {},
    stats: await userStats(env, u.id),
  };
}

export const getUser = (env, id) =>
  env.DB.prepare('SELECT id, name, created, passhash, profile FROM users WHERE id = ?1').bind(id).first();
