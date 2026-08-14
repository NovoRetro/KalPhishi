// Guards on the reach listing.
//
// GET /api/admin/reach answers "who has not predicted the next open show", so that the one
// outbound channel this beta has — a person writing in the group chat — can be aimed at the
// right people and checked afterwards.
//
// Two things about it are load-bearing and neither shows up as a broken feature when it
// regresses. It must not widen what an admin route exposes (the moderation listing settled
// that: handle only, never the email), and it must never grow the ability to SEND anything.
// The moment it does, this project has an outbound channel nobody decided to build, wired to
// unverified addresses, firing from a cron that already runs three times a day.
//
// Same source-assertion pattern and same reason as moderation/password-reset: the queries
// need D1, so the properties are asserted against the source. Behaviour was verified
// separately against a real local D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = readFileSync(join(root, 'src/worker.mjs'), 'utf8');

const handler = () => {
  // No trailing "\n" after the brace: the checkout is CRLF on Windows, so "  }\n" matches
  // nothing while "\n  }" does — the \r is absorbed by the lazy run in front of it. The same
  // trap is noted in moderation.test.mjs.
  const h = worker.match(/if \(p === '\/api\/admin\/reach' && m === 'GET'[\s\S]*?\n  }/);
  assert.ok(h, 'reach handler not found');
  return h[0];
};
// Comments explain why the email is omitted and why nothing is sent; matching that prose
// would fail the very assertions it describes.
const code = () => handler().replace(/\/\/[^\n]*/g, '');

test('the reach listing is admin-gated', () => {
  assert.match(handler(), /isAdmin\(request, env\)/);
  assert.match(handler(), /403/);
});

test('the reach listing never returns an email or an internal id', () => {
  const c = code();
  assert.doesNotMatch(c, /\bemail\b/, 'a targeting list must not widen email exposure');
  assert.doesNotMatch(c, /\bid:/, 'internal ids never leave the server');
  // publicName is what keeps a legacy email-as-name out of the response.
  assert.match(c, /publicName\(r\)/);
});

test('the reach listing excludes banned accounts', () => {
  assert.match(code(), /NOT_BANNED/, 'a list of people to chase is the last place a ban should lapse');
});

test('the open show is resolved through the same lock the save route enforces', () => {
  // A hand-rolled date comparison here would drift from lockStateFor and start naming
  // people as "missing" for a show they can no longer save.
  const c = code();
  assert.match(c, /lockState\(/);
  assert.doesNotMatch(c, /Date\.now\(\)|new Date\(\)/, 'compare through lockState, not by hand');
});

test('the listing reports both games separately', () => {
  // The two are scored separately and plenty of people only ever play one, so a single
  // has-predicted boolean would name people who already did the thing being asked of them.
  const c = code();
  assert.match(c, /'setlist'/);
  assert.match(c, /'bingo'/);
  assert.match(c, /needs/);
});

test('the reach listing sends nothing', () => {
  // The whole decision behind this endpoint is that delivery stays human. A fetch to a mail
  // provider added here would be the project's first external service dependency and its
  // first unverified-address mailing, arriving as a one-line diff in an admin route.
  const c = code();
  assert.doesNotMatch(c, /\bfetch\s*\(/, 'the reach listing queries; it must never send');
  assert.doesNotMatch(c, /mail|resend|sendgrid|smtp|notif|push|subscri/i, 'no delivery here');
});

test('no outbound channel has appeared anywhere else either', () => {
  // The standing property, asserted where it is cheap to check. If this ever fails on
  // purpose, the roadmap decision in handoff.md item 4 is what is being reversed.
  const src = ['src/worker.mjs', 'src/auth.mjs', 'src/db.mjs']
    .map(f => readFileSync(join(root, f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /mailchannels|sendgrid|resend\.com|nodemailer|send_email/i);
});
