// Guards on account deletion (APP-STORE.md — Apple 5.1.1(v), and basic decency).
//
// Deletion is the one irreversible thing a player can do to themselves, and the one
// operation whose failure mode is silent: an orphaned row leaves data behind that the
// account's owner was told is gone. The schema-sweep test below is the important one —
// it fails when somebody adds a table, not when somebody notices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const worker = read('src/worker.mjs');
const predictor = read('web/predictor.js');
const stripComments = s => s.replace(/\/\/[^\n]*/g, '');

const handler = worker.match(
  /if \(p === '\/api\/me' && m === 'DELETE'\) \{[\s\S]*?\n  \}/);

test('the account delete route exists, re-authenticates, and clears the cookie', () => {
  assert.ok(handler, 'DELETE /api/me is gone — Apple rejects registration without it');
  const c = stripComments(handler[0]);
  assert.match(c, /if \(!user\) return err\(401/);
  // A session is the wrong bar on its own: the realistic threat is an unlocked phone,
  // and that hand already has the session.
  assert.match(c, /user\.passhash && !await verifyPassword\(password \|\| '', user\.passhash\)/,
    'deletion must re-authenticate when there is a password to check');
  assert.match(c, /DELETE FROM users WHERE id = \?1/, 'the row must actually go');
  assert.doesNotMatch(c, /banned_at|UPDATE users SET/,
    'deletion must be deletion, not a tombstone or a flag');
  assert.match(c, /clearedSessionCookie\(\)/);
});

test('every table that references users is cascaded or cleared explicitly', () => {
  // The whole point of this file. A new table with a user_id and no ON DELETE CASCADE
  // silently survives account deletion; this catches it at the moment it is written,
  // which is the only moment anybody is thinking about it.
  const sql = readdirSync(join(root, 'migrations'))
    .filter(f => f.endsWith('.sql')).sort()
    .map(f => read(join('migrations', f))).join('\n');
  const del = stripComments(handler[0]);

  // Tables dropped by a later migration are not live schema — 0009 rebuilt predictions
  // through a predictions_new that no longer exists under that name.
  const dropped = new Set([...sql.matchAll(/DROP TABLE (\w+)/g)].map(m => m[1]));
  const renamed = new Map([...sql.matchAll(/ALTER TABLE (\w+) RENAME TO (\w+)/g)].map(m => [m[1], m[2]]));

  const bodies = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)];
  const offenders = [];
  for (const [, rawName, body] of bodies) {
    const name = renamed.get(rawName) || rawName;
    if (dropped.has(name) && !renamed.has(rawName)) continue;
    if (name === 'users') continue;
    // Columns that point at a user, whether or not they carry a real constraint.
    const pointsAtUser = /REFERENCES users\(id\)/.test(body) || /\b(user_id|owner_id)\b/.test(body);
    if (!pointsAtUser) continue;
    const cascades = /REFERENCES users\(id\) ON DELETE CASCADE/.test(body);
    const handledByHand = new RegExp(`DELETE FROM ${name} WHERE user_id`).test(del);
    if (!cascades && !handledByHand) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `these tables reference a user but neither cascade nor get cleared in DELETE /api/me: ${offenders.join(', ')}`);
});

test('password_resets is the known exception and is cleared by hand', () => {
  // It carries a bare user_id with no constraint, so nothing deletes it for us. Kept as
  // an explicit test rather than folded into the sweep above so that "fixing" the schema
  // later has to come here and decide deliberately.
  const sql = read('migrations/0007_password_resets.sql');
  assert.doesNotMatch(sql, /user_id[^\n]*REFERENCES/,
    'if password_resets gained a real FK, this route can stop clearing it by hand');
  assert.match(stripComments(handler[0]), /DELETE FROM password_resets WHERE user_id = \?1/);
});

test('the client warns about crews that die with the account', () => {
  // Owned crews are deleted for everyone in them. That is the existing ownership model,
  // but the people it affects are not the person pressing the button, so they get named
  // before the press rather than discovered after it.
  const fn = predictor.match(/box\.appendChild\(el\('div', 'setlabel', 'Leaving'\)\)[\s\S]*?\n  \}/);
  assert.ok(fn, 'the Leaving section is gone');
  assert.match(fn[0], /groups\.filter\(g => g\.isOwner\)/);
  assert.match(fn[0], /memberCount > 1/, 'a crew of one harms nobody and needs no warning');
  assert.match(fn[0], /It also deletes/);
  // The warning is a courtesy — if the lookup fails, leaving must still be possible.
  assert.match(fn[0], /catch \{ \/\* the warning is a courtesy/);
  // And the local "you have an account here" hint must go, or the app greets a deleted
  // account's owner as a returning player.
  assert.match(fn[0], /localStorage\.removeItem\('kalphish-user'\)/);
});
