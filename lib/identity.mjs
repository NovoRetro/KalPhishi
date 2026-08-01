// Email and handle rules. Pure — shared by the Worker and the offline backfill script,
// and unit tested without a database.

// Addresses are stored and compared lowercased and trimmed, so "A@B.com " and "a@b.com"
// are the same account. Display casing is not preserved: an address is a credential here,
// not a name.
export const normalizeEmail = e => String(e ?? '').trim().toLowerCase();

// Deliberately permissive. Nothing is emailed (see the roadmap's Design Decision 2), so
// this only catches obvious typos and things that would break a URL or a UI — it is not
// trying to prove deliverability, which no regex can do anyway.
export function isValidEmail(email) {
  const e = normalizeEmail(email);
  if (e.length < 6 || e.length > 254) return false;
  if (/\s/.test(e)) return false;
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return false;
  const domain = e.slice(at + 1);
  if (domain.length < 3 || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (e.slice(0, at).length > 64) return false;
  return true;
}

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 24;

// Handles appear in public profile URLs, so they must never be derived from an email —
// that is the leak this whole change exists to close. Callers pass a display name.
export function slugifyHandle(name) {
  return String(name ?? '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HANDLE_MAX)
    .replace(/-+$/, '');
}

// Names that would collide with a route or read as official.
const RESERVED = new Set([
  'api', 'admin', 'root', 'system', 'kalphishi', 'phish', 'me', 'new', 'edit', 'delete',
  'login', 'logout', 'register', 'profile', 'settings', 'leaderboard', 'invite', 'friends',
]);

export const isReservedHandle = h => RESERVED.has(String(h ?? '').toLowerCase());

// Ordered candidates for a display name: the plain slug first, then numeric suffixes.
// The caller walks these against the database and takes the first that is free, so
// collision handling stays a pure sequence here and a single query loop there.
export function* handleCandidates(displayName, limit = 100) {
  let base = slugifyHandle(displayName);
  if (base.length < HANDLE_MIN) base = 'phan'; // nothing usable in the name
  if (!isReservedHandle(base)) yield base;
  for (let n = 2; n <= limit; n++) {
    const suffix = String(n);
    yield base.slice(0, HANDLE_MAX - suffix.length - 1).replace(/-+$/, '') + '-' + suffix;
  }
}

export function isValidHandle(h) {
  const s = String(h ?? '');
  if (s.length < HANDLE_MIN || s.length > HANDLE_MAX) return false;
  if (isReservedHandle(s)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}
