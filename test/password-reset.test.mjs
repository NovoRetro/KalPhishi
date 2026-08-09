// Guards on admin-issued password reset.
//
// The redemption route is unauthenticated by necessity — the whole point is that the caller
// cannot sign in — so the token is the entire proof, and every property below exists to
// keep it from being worth more than one use. None of this can be unit tested without D1,
// so these assert the properties are present in the source. Brittle by nature, but the
// failures they catch are the kind nobody notices: a reset route that quietly stops
// expiring links, or stops burning them, still works perfectly in manual testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const worker = read('src/worker.mjs');
const auth = read('src/auth.mjs');
const migration = read('migrations/0007_password_resets.sql');
const predictor = read('web/predictor.js');

const issue = worker.match(/\/api\/admin\/users\/'\) && p\.endsWith\('\/reset'\)[\s\S]*?\n  }/);
const redeem = worker.match(/if \(p === '\/api\/password\/reset'[\s\S]*?\n  }/);

test('the reset token is stored hashed, never in the clear', () => {
  // The table holding raw tokens would be a table of live passwords-in-waiting: anyone who
  // could read it could take any account. Storing the hash means a leak yields nothing.
  assert.ok(issue, 'reset issue handler not found');
  assert.match(issue[0], /sha256hex\(token\)/, 'the stored value must be a hash of the token');
  assert.ok(!/INSERT INTO password_resets[^)]*\)\s*\.bind\(\s*token\b/.test(issue[0]),
    'the raw token must never be bound into the row');
  assert.match(migration, /token_hash TEXT PRIMARY KEY/,
    'the column must be named for what it holds, so a later edit cannot mistake it');
});

test('issuing a link supersedes any outstanding one for that account', () => {
  // Two live links means a superseded one still works — so handing the wrong link over,
  // then correcting it, would leave the first one usable.
  assert.match(issue[0], /DELETE FROM password_resets WHERE user_id = \?1/,
    'issuing must clear prior links for that user');
});

test('a banned account cannot be handed a reset link', () => {
  // Otherwise a ban is undone by anyone who asks an operator nicely enough.
  assert.match(issue[0], /banned_at/, 'issue must refuse a banned account');
});

test('redemption refuses spent, expired and unknown links alike', () => {
  assert.ok(redeem, 'reset redemption handler not found');
  assert.match(redeem[0], /used_at/, 'a spent link must be refused');
  assert.match(redeem[0], /expires < Date\.now\(\)/, 'an expired link must be refused');
  // One message for all three. Distinguishing them would confirm whether a token ever
  // existed, which is the only thing guessing at them could learn.
  const messages = [...redeem[0].matchAll(/err\(410, '([^']+)'/g)].map(m => m[1]);
  assert.ok(messages.length >= 2 && new Set(messages).size === 1,
    `missing, spent and expired must return one identical message, got: ${JSON.stringify(messages)}`);
});

test('redemption burns the link and revokes every session', () => {
  // Burning is what makes a second use fail closed. Revoking ALL sessions matters because a
  // forgotten password is exactly the case where somebody else may have the account open —
  // /api/password spares the caller's own session, but there is no caller here.
  assert.match(redeem[0], /UPDATE password_resets SET used_at/, 'the link must be marked used');
  assert.match(redeem[0], /DELETE FROM sessions WHERE user_id = \?1/,
    'every session must be revoked, not just other ones');
});

test('redemption issues no session of its own', () => {
  // Signing them in would make a leaked link directly equivalent to the account. They set a
  // password and then prove it by signing in with it.
  assert.ok(!/newSession/.test(redeem[0]),
    'redeeming must not hand out a session — the new password is the proof');
});

test('reset tokens are minted at the same strength as session tokens', () => {
  // One definition, so neither can be weakened without the other noticing.
  assert.match(auth, /export function newToken\(\)[\s\S]*?getRandomValues\(new Uint8Array\(32\)\)/,
    'newToken must be 256 bits of CSPRNG');
  const session = auth.match(/export async function newSession[\s\S]*?\n}/);
  assert.match(session[0], /newToken\(\)/, 'newSession must use the shared minter');
  assert.match(issue[0], /newToken\(\)/, 'reset issue must use the shared minter');
});

test('the reset token is not persisted in the browser', () => {
  // An invite is stashed in sessionStorage because it has to survive a registration round
  // trip. A reset token has no round trip to survive, and is credential-grade — it should
  // not outlive the tab it arrived in.
  const block = predictor.match(/---------- password reset links ----------[\s\S]*?function renderPasswordReset/);
  assert.ok(block, 'reset link block not found');
  // Comments stripped first: this block explains in prose that it deliberately avoids
  // sessionStorage, and matching that sentence would pass the test for the wrong reason —
  // or fail it, as it did on the first run.
  const code = block[0].replace(/\/\/.*$/gm, '');
  assert.ok(!/sessionStorage|localStorage/.test(code),
    'the reset token must not be written to browser storage');
  assert.match(block[0], /searchParams\.delete\('reset'\)/,
    'the token must be stripped from the URL so a refresh cannot replay it');
});

test('expired reset rows are swept alongside expired sessions', () => {
  assert.match(worker, /DELETE FROM password_resets WHERE expires < \?1/,
    'the cron must age out reset links');
});
