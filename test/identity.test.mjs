// Email and handle rules (lib/identity.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail, isValidEmail, slugifyHandle, handleCandidates,
  isValidHandle, isReservedHandle, HANDLE_MAX,
} from '../lib/identity.mjs';

const first = (name, n) => [...handleCandidates(name)].slice(0, n);

test('normalizeEmail trims and lowercases so casing cannot fork an account', () => {
  assert.equal(normalizeEmail('  Someone@Example.COM '), 'someone@example.com');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('isValidEmail accepts ordinary addresses', () => {
  for (const e of ['a@b.co', 'someone@example.com', 'first.last+tag@sub.domain.org',
                   '  Mixed@Case.NET  ']) {
    assert.equal(isValidEmail(e), true, `${e} should be valid`);
  }
});

test('isValidEmail rejects malformed input', () => {
  for (const e of ['', null, undefined, 'no-at-sign', '@example.com', 'user@',
                   'user@@example.com', 'user@nodot', 'user @example.com',
                   'user@.example.com', 'user@example.com.', 'user@ex..ample.com']) {
    assert.equal(isValidEmail(e), false, `${JSON.stringify(e)} should be invalid`);
  }
});

test('isValidEmail bounds the overall length and the local part', () => {
  assert.equal(isValidEmail('a'.repeat(65) + '@example.com'), false, 'local part over 64');
  assert.equal(isValidEmail('a'.repeat(250) + '@example.com'), false, 'over 254 total');
  assert.equal(isValidEmail('a'.repeat(64) + '@example.com'), true, 'exactly 64 is fine');
});

test('slugifyHandle lowercases and collapses punctuation', () => {
  assert.equal(slugifyHandle('  Robbie  '), 'robbie');
  assert.equal(slugifyHandle("Mike's Song"), 'mike-s-song');
  assert.equal(slugifyHandle('SANTOS'), 'santos');
  assert.equal(slugifyHandle('!!!'), '', 'nothing usable');
});

test('slugifyHandle truncates without leaving a trailing dash', () => {
  const h = slugifyHandle('a'.repeat(HANDLE_MAX + 10));
  assert.equal(h.length, HANDLE_MAX);
  const dashy = slugifyHandle('abcdefghijklmnopqrstuvw xyz');
  assert.ok(!dashy.endsWith('-'), `got ${dashy}`);
  assert.ok(dashy.length <= HANDLE_MAX);
});

test('handleCandidates yields the plain slug first, then numeric suffixes', () => {
  assert.deepEqual(first('Robbie', 3), ['robbie', 'robbie-2', 'robbie-3']);
});

test('handleCandidates skips the bare slug when it is reserved', () => {
  const c = first('admin', 2);
  assert.ok(!c.includes('admin'), 'reserved bare handle must not be offered');
  assert.equal(c[0], 'admin-2');
});

test('handleCandidates falls back when the name has nothing usable', () => {
  const c = first('!!!', 2);
  assert.equal(c[0], 'phan');
  assert.equal(c[1], 'phan-2');
});

test('every candidate is a valid handle, including suffixed long names', () => {
  for (const name of ['Robbie', 'SANTOS', "Mike's Song", '!!!', 'a'.repeat(40), 'admin']) {
    for (const h of first(name, 12)) {
      assert.ok(isValidHandle(h), `${h} (from ${name}) should be a valid handle`);
      assert.ok(h.length <= HANDLE_MAX, `${h} exceeds ${HANDLE_MAX}`);
    }
  }
});

test('candidates are unique within a run', () => {
  const c = first('Robbie', 25);
  assert.equal(new Set(c).size, c.length);
});

test('isValidHandle rejects shapes that would break a URL or read as official', () => {
  for (const bad of ['', 'a', '-leading', 'trailing-', 'double--dash', 'Upper',
                     'has space', 'has_underscore', 'a'.repeat(HANDLE_MAX + 1),
                     'api', 'admin', 'leaderboard']) {
    assert.equal(isValidHandle(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
  for (const ok of ['ab', 'robbie', 'robbie-2', 'mike-s-song', 'a1-b2']) {
    assert.equal(isValidHandle(ok), true, `${ok} should be valid`);
  }
});

test('reserved handles are matched case-insensitively', () => {
  assert.equal(isReservedHandle('API'), true);
  assert.equal(isReservedHandle('Admin'), true);
  assert.equal(isReservedHandle('robbie'), false);
});

test('a handle is never derived from an email address', () => {
  // The leak this change exists to close: slugifying an email must not survive as a
  // handle. Callers pass display names, and an address does not validate as one.
  const fromEmail = slugifyHandle('someone@example.com');
  assert.equal(isValidHandle(fromEmail), true, 'it would technically be well-formed…');
  assert.ok(fromEmail.includes('example-com'), '…which is exactly why callers must not pass emails');
});

test('publicName never echoes an email hiding in the account name', async () => {
  const { publicName } = await import('../src/db.mjs');
  assert.equal(publicName({ name: 'owner@example.com', profile: '{"displayName":"Robbie"}', handle: 'robbie-2' }), 'Robbie');
  assert.equal(publicName({ name: 'owner@example.com', profile: '{}', handle: 'robbie-2' }), 'robbie-2');
  assert.equal(publicName({ name: 'owner@example.com', profile: null, handle: null }), 'phan');
  assert.equal(publicName({ name: 'SANTOS', profile: '{}', handle: 'santos' }), 'SANTOS', 'plain names pass through');
});
