// Password hashing, sessions, and cookies — Web Crypto only, no Node APIs.

export const SESSION_COOKIE = 'kalphishi_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Long enough that an operator can mint a link, find the person and get it to them without
// racing a clock; short enough that one left in a chat log stops working the next day.
export const RESET_TTL_MS = 24 * 3600 * 1000;
// Temporarily lowered from 12 for easier user testing (2026-08-01) — raise it back
// before this matters for real; nothing else assumes a specific value.
export const MIN_PASSWORD_LENGTH = 6;

// Cloudflare caps PBKDF2 at 100k iterations, and the free plan allows 10ms CPU per
// request. Lowering this stays compatible with existing hashes: the iteration count
// used is stored inside each hash string.
export const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  // Everything unverifiable fails closed: legacy scrypt hashes ("salthex:hashhex"),
  // truncated fields, and non-numeric iteration counts. A corrupt row must reject the
  // login rather than throw its way into a 500.
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  try {
    const [, iterStr, saltB64, hashB64] = stored.split('$');
    const iterations = Number(iterStr);
    if (!Number.isInteger(iterations) || iterations < 1 || !saltB64 || !hashB64) return false;
    const want = unb64(hashB64);
    const bits = new Uint8Array(await derive(password, unb64(saltB64), iterations));
    if (bits.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
    return diff === 0;
  } catch {
    return false; // malformed base64 or an otherwise unusable parameter
  }
}

export async function sha256hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function getCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// 256 bits of CSPRNG, hex-encoded. One definition, so a session token and a reset token
// are the same strength by construction rather than by coincidence — and so neither can be
// quietly weakened without the other noticing.
export function newToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// Returns the statement to insert the session plus the raw token for the cookie.
export async function newSession(env, userId) {
  const token = newToken();
  const stmt = env.DB
    .prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?1, ?2, ?3)')
    .bind(await sha256hex(token), userId, Date.now() + SESSION_TTL_MS);
  return { token, stmt };
}

export async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  // A banned account resolves to no user, so an existing cookie stops working on the very
  // next request. Sessions are deleted when a ban is applied too, but this is the check
  // that cannot be forgotten: every authenticated route goes through here.
  return await env.DB.prepare(
    `SELECT u.id, u.name, u.created, u.passhash, u.profile, u.email, u.handle
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires > ?2 AND u.banned_at IS NULL`
  ).bind(await sha256hex(token), Date.now()).first();
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
