// Guards on the ban filter.
//
// A ban is only worth anything if EVERY path that exposes a user applies it. That cannot
// be unit tested — the queries need D1 — so these assert the filter is present in the
// source of each one. Source assertions are brittle by nature, but the failure they catch
// is worse: a new public listing added without the filter puts a banned account back on
// the site, silently, and nothing else would notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const worker = read('src/worker.mjs');
const db = read('src/db.mjs');
const auth = read('src/auth.mjs');

test('session resolution refuses a banned account', () => {
  // The check that cannot be forgotten: every authenticated route goes through here, so a
  // live cookie stops working on the next request rather than lasting until it expires.
  const fn = auth.match(/export async function currentUser[\s\S]*?\n}/);
  assert.ok(fn, 'currentUser not found');
  assert.match(fn[0], /banned_at IS NULL/, 'currentUser must not resolve a banned account');
});

test('login rejects a banned account after checking the password', () => {
  const login = worker.match(/if \(p === '\/api\/login'[\s\S]*?\n  }/);
  assert.ok(login, 'login handler not found');
  assert.match(login[0], /isBanned\(user\)/);
  // Order matters: checking before the password would let anyone probe which accounts are
  // banned by submitting a wrong one.
  assert.ok(
    login[0].indexOf('verifyPassword') < login[0].indexOf('isBanned'),
    'the ban check must come after password verification',
  );
});

test('the leaderboard excludes banned accounts', () => {
  const board = worker.match(/if \(p === '\/api\/leaderboard'[\s\S]*?\n  }/);
  assert.ok(board, 'leaderboard handler not found');
  assert.match(board[0], /NOT_BANNED/);
});

test('the per-show predictions listing excludes banned accounts', () => {
  // This one returns a handle per row, so without the filter a banned account's name is
  // still on the page even though its profile 404s.
  const listing = worker.match(/if \(p === '\/api\/predictions' && m === 'GET'[\s\S]*?\n  }/);
  assert.ok(listing, 'predictions listing not found');
  assert.match(listing[0], /NOT_BANNED/);
});

test('friend lists exclude banned accounts', () => {
  const fn = db.match(/export async function friendsOf[\s\S]*?\n}/);
  assert.ok(fn, 'friendsOf not found');
  assert.match(fn[0], /NOT_BANNED/);
});

test('a banned public profile is indistinguishable from one that never existed', () => {
  const prof = worker.match(/if \(p\.startsWith\('\/api\/profile\/'\)[\s\S]*?\n  }/);
  assert.ok(prof, 'public profile handler not found');
  assert.match(prof[0], /!u \|\| isBanned\(u\)/);
  assert.match(prof[0], /404/);
});

test('both admin routes are gated, and the gate denies when no token is configured', () => {
  for (const route of ["p === '/api/admin/users' && m === 'GET'", "p.startsWith('/api/admin/users/') && m === 'PATCH'"]) {
    const i = worker.indexOf(route);
    assert.ok(i > 0, `route not found: ${route}`);
    assert.match(worker.slice(i, i + 220), /isAdmin\(request, env\)/, `${route} is not admin-gated`);
  }
  // Anchored on the expression rather than a trailing ";\n", which does not match under
  // the CRLF checkout this repo gets on Windows.
  const gate = worker.match(/const isAdmin =[\s\S]*?ADMIN_TOKEN\);/);
  assert.ok(gate, 'isAdmin not found');
  assert.match(gate[0], /!!env\.ADMIN_TOKEN &&/, 'a missing ADMIN_TOKEN must deny, not open the routes');
  assert.match(gate[0], /timingSafeEqualStr/, 'the token compare must be constant time');
});

test('the admin listing never returns an email or an internal id', () => {
  const list = worker.match(/if \(p === '\/api\/admin\/users' && m === 'GET'[\s\S]*?\n  }/);
  assert.ok(list, 'admin listing not found');
  // Comments stripped first: the block explains why it omits the email, and matching that
  // prose would fail the assertion it is describing.
  const code = list[0].replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\bemail\b/, 'moderation works from the handle and must not widen email exposure');
  assert.doesNotMatch(code, /\bid:/, 'internal ids never leave the server');
});

test('an admin rename is sanitised like any other name', () => {
  // The person removing a lookalike name must not be the one able to introduce one.
  const patch = worker.match(/if \(p\.startsWith\('\/api\/admin\/users\/'\) && m === 'PATCH'[\s\S]*?\n  }/);
  assert.ok(patch, 'admin patch not found');
  assert.match(patch[0], /sanitizeLine\(b\.displayName\)/);
  assert.match(patch[0], /isValidHandle\(/);
  assert.match(patch[0], /that handle is taken/, 'a rename must not collide with an existing handle');
});

test('banning revokes sessions as well as marking the row', () => {
  const patch = worker.match(/if \(p\.startsWith\('\/api\/admin\/users\/'\) && m === 'PATCH'[\s\S]*?\n  }/);
  assert.match(patch[0], /DELETE FROM sessions WHERE user_id/);
});

test('the migration adds both columns and nothing destructive', () => {
  const sql = read('migrations/0006_moderation.sql');
  assert.match(sql, /ADD COLUMN banned_at/);
  assert.match(sql, /ADD COLUMN banned_reason/);
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b/i, 'a moderation migration must not remove anything');
});
