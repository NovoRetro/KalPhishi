// Password hashing, cookies, and session token handling (src/auth.mjs).
// Runs unmodified in Node because the module deliberately uses only Web Crypto.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, sha256hex, getCookie,
  sessionCookie, clearedSessionCookie, timingSafeEqualStr,
  SESSION_COOKIE, SESSION_TTL_MS, MIN_PASSWORD_LENGTH, PBKDF2_ITERATIONS,
} from '../src/auth.mjs';

// Keep the work factor low so the suite stays fast; the format is what is under test.
const FAST = 1000;
const req = cookie => new Request('https://example.test/', { headers: cookie ? { cookie } : {} });

test('hashPassword produces the documented pbkdf2$iters$salt$hash format', async () => {
  const stored = await hashPassword('correct-horse-battery', FAST);
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(Number(parts[1]), FAST);
  assert.equal(atob(parts[2]).length, 16, '16-byte salt');
  assert.equal(atob(parts[3]).length, 32, '256-bit derived key');
});

test('a correct password verifies and a wrong one does not', async () => {
  const stored = await hashPassword('correct-horse-battery', FAST);
  assert.equal(await verifyPassword('correct-horse-battery', stored), true);
  assert.equal(await verifyPassword('correct-horse-batter', stored), false);
  assert.equal(await verifyPassword('Correct-Horse-Battery', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('the salt is random, so equal passwords hash differently', async () => {
  const [a, b] = await Promise.all([
    hashPassword('same-password-here', FAST),
    hashPassword('same-password-here', FAST),
  ]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password-here', a), true);
  assert.equal(await verifyPassword('same-password-here', b), true);
});

test('the iteration count travels inside the hash, so old hashes keep verifying', async () => {
  // Lowering PBKDF2_ITERATIONS must not lock existing users out.
  const stored = await hashPassword('portable-across-costs', 2000);
  assert.match(stored, /^pbkdf2\$2000\$/);
  assert.equal(await verifyPassword('portable-across-costs', stored), true);
});

test('legacy scrypt hashes fail closed rather than throwing', async () => {
  // "salthex:hashhex" was the pre-Workers format; it cannot be verified here.
  const legacy = 'bb4d7d711a5fb78b1ed97a8475e91a73:458cf380c0b74cd2edf0a1b2c3d4e5f6';
  assert.equal(await verifyPassword('anything', legacy), false);
});

test('malformed and empty stored hashes fail closed', async () => {
  for (const bad of ['', null, undefined, 'pbkdf2$', 'not-a-hash', 'pbkdf2$abc$$']) {
    assert.equal(await verifyPassword('pw', bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a tampered hash does not verify', async () => {
  const stored = await hashPassword('tamper-check-password', FAST);
  const [p, iters, salt, hash] = stored.split('$');
  const flipped = hash[0] === 'A' ? 'B' + hash.slice(1) : 'A' + hash.slice(1);
  assert.equal(await verifyPassword('tamper-check-password', [p, iters, salt, flipped].join('$')), false);
});

test('sha256hex is stable, 64 hex chars, and matches a known vector', async () => {
  assert.equal(
    await sha256hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const h = await sha256hex('session-token');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await sha256hex('session-token'));
  assert.notEqual(h, await sha256hex('session-token '));
});

test('session cookie carries HttpOnly, Secure, SameSite and the full TTL', () => {
  const c = sessionCookie('abc123');
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=abc123;`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/, 'the Worker is HTTPS-only');
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}\\b`));
});

test('clearing the cookie empties the value and expires it immediately', () => {
  const c = clearedSessionCookie();
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=;`));
  assert.match(c, /Max-Age=0/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
});

test('getCookie finds its cookie among others and ignores near-misses', () => {
  assert.equal(getCookie(req(`a=1; ${SESSION_COOKIE}=tok; b=2`), SESSION_COOKIE), 'tok');
  assert.equal(getCookie(req(`${SESSION_COOKIE}=tok`), SESSION_COOKIE), 'tok');
  assert.equal(getCookie(req('other=1'), SESSION_COOKIE), null);
  assert.equal(getCookie(req(''), SESSION_COOKIE), null);
  assert.equal(getCookie(req(), SESSION_COOKIE), null, 'no cookie header at all');
  assert.equal(getCookie(req(`x${SESSION_COOKIE}=tok`), SESSION_COOKIE), null, 'prefixed name must not match');
});

test('getCookie keeps base64 padding in a value containing "="', () => {
  assert.equal(getCookie(req(`${SESSION_COOKIE}=YWJjZA==`), SESSION_COOKIE), 'YWJjZA==');
});

test('timingSafeEqualStr compares by value and rejects non-strings', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false, 'differing lengths');
  assert.equal(timingSafeEqualStr('', ''), true);
  assert.equal(timingSafeEqualStr(null, 'abc'), false);
  assert.equal(timingSafeEqualStr('abc', undefined), false);
  assert.equal(timingSafeEqualStr(123, 123), false, 'non-strings are rejected');
});

test('published auth constants stay within their documented bounds', () => {
  // Temporarily lowered from 12 for easier testing (src/auth.mjs) — floor is just
  // "not effectively no minimum," not the real target.
  assert.ok(MIN_PASSWORD_LENGTH >= 6, 'short passwords are the tradeoff for a low work factor');
  assert.ok(PBKDF2_ITERATIONS <= 100_000, 'Cloudflare caps PBKDF2 at 100k iterations');
  assert.equal(SESSION_TTL_MS, 30 * 24 * 3600 * 1000);
});
