// Email, display-text and handle rules. Pure — shared by the Worker and the offline
// backfill script, and unit tested without a database.

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

// ---- user-supplied display text ----
//
// Everything a user types that other people see passes through here before it is stored.
// Output is escaped everywhere, so this is not about injection — it is about text that
// renders as something other than what it is:
//
//   NFKC folds compatibility forms, so fullwidth "ａｄｍｉｎ" and mathematical-bold
//     letters collapse to plain ASCII instead of standing as separate lookalike names.
//   Invisible characters are dropped. Zero-width spaces and Hangul fillers produce a name
//     that renders blank, or two accounts that are indistinguishable on screen.
//   Bidi overrides are dropped. U+202E reverses everything after it, so a stored name can
//     display as an entirely different string.
//
// Length caps live here too. Registration had none at all: the profile update truncated
// to 80 characters, but the signup path bound whatever it was handed.

export const NAME_MAX = 80;
export const BIO_MAX = 500;
export const DEFAULT_AVATAR = '🎣';

// Code-point ranges rather than a regex literal: a character class of escapes is
// unreadable, easy to corrupt silently, and these ranges deserve names.
const INVISIBLE_RANGES = [
  [0x0000, 0x0008], // C0 controls, deliberately keeping tab (0x09) and newline (0x0A)
  [0x000B, 0x001F],
  [0x007F, 0x009F], // DEL and the C1 controls
  [0x00AD, 0x00AD], // soft hyphen
  [0x061C, 0x061C], // Arabic letter mark
  [0x115F, 0x1160], // Hangul fillers — render as nothing
  [0x17B4, 0x17B5], // Khmer inherent vowels — likewise
  [0x180E, 0x180E], // Mongolian vowel separator
  [0x200B, 0x200F], // zero-width space / non-joiner / joiner, LRM, RLM
  [0x202A, 0x202E], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206F], // bidi isolates and deprecated formatting
  [0x3164, 0x3164], // Hangul filler
  [0xFEFF, 0xFEFF], // zero-width no-break space
  [0xFFA0, 0xFFA0], // halfwidth Hangul filler
];

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
const strip = (s, ranges) => [...s].filter(c => !inRanges(c.codePointAt(0), ranges)).join('');

/** Single-line display text: names, hometown, favourite song. */
export function sanitizeLine(v, max = NAME_MAX) {
  return strip(String(v ?? '').normalize('NFKC'), INVISIBLE_RANGES)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Multi-line display text: the bio. Keeps paragraphs, collapses runs of blank lines. */
export function sanitizeBlock(v, max = BIO_MAX) {
  return strip(String(v ?? '').normalize('NFKC'), INVISIBLE_RANGES)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim();
}

// The avatar is meant to be an emoji or two, and cannot go through sanitizeLine: the
// zero-width joiner and variation selector are structural inside an emoji sequence, so
// stripping them turns a rainbow flag into two unrelated glyphs. Only true controls go.
const CONTROL_RANGES = [[0x0000, 0x001F], [0x007F, 0x009F]];
const ZWJ = String.fromCodePoint(0x200D);
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xFE0F);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_ONLY = new RegExp(
  '^(?:\\p{Extended_Pictographic}|\\p{Emoji_Component}|\\p{Emoji_Modifier}|'
  + VARIATION_SELECTOR_16 + '|' + ZWJ + ')+$', 'u');
const AVATAR_MAX_CODEPOINTS = 16; // a ZWJ family sequence is already seven

/**
 * Anything that is not an emoji falls back to the default rather than erroring — the
 * field is decorative, and the UI renders the stored result immediately.
 */
export function sanitizeAvatar(v, fallback = DEFAULT_AVATAR) {
  const s = strip(String(v ?? '').normalize('NFKC'), CONTROL_RANGES).trim();
  if (!s) return fallback;
  if ([...s].length > AVATAR_MAX_CODEPOINTS) return fallback;
  // Both tests are needed: Emoji_Component alone matches bare digits, so requiring a
  // pictographic keeps "123" out, while EMOJI_ONLY keeps letters out.
  if (!PICTOGRAPHIC.test(s) || !EMOJI_ONLY.test(s)) return fallback;
  return s;
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
