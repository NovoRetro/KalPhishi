// One-shot: turn data/db.json into data/seed.sql for D1.
//
//   node scripts/migrate-to-d1.js <userId>=<newPassword> [...]
//
// Legacy scrypt hashes cannot be verified by the Worker and cannot be converted
// without the plaintext, so every password-bearing account needs a new password here.
// Accounts with no password stay claimable, exactly as before.
//
// Sessions are deliberately not migrated — everyone signs in once after the cutover.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

const sq = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function main() {
  const { hashPassword, MIN_PASSWORD_LENGTH } = await import('../src/auth.mjs');

  const supplied = new Map(
    process.argv.slice(2).map(a => {
      const i = a.indexOf('=');
      if (i < 1) throw new Error(`expected <userId>=<newPassword>, got: ${a}`);
      return [a.slice(0, i), a.slice(i + 1)];
    })
  );

  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));

  const needPasswords = db.users.filter(u => u.passhash && !supplied.has(u.id)).map(u => u.id);
  if (needPasswords.length) {
    throw new Error(
      `these accounts have a password and need a new one:\n` +
      needPasswords.map(id => `  node scripts/migrate-to-d1.js ${id}=<newPassword>`).join('\n')
    );
  }

  const out = [];
  for (const u of db.users) {
    let passhash = null;
    if (supplied.has(u.id)) {
      const pw = supplied.get(u.id);
      if (pw.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password for ${u.id} must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      passhash = await hashPassword(pw);
    }
    out.push(
      `INSERT INTO users (id,name,created,passhash,profile) VALUES (` +
      [sq(u.id), sq(u.name), sq(u.created), sq(passhash), sq(JSON.stringify(u.profile || {}))].join(',') + `);`
    );
  }

  for (const p of db.predictions) {
    out.push(
      `INSERT INTO predictions (id,user_id,showdate,type,payload,created,updated,result,score,bingo,live_checked,scored_at) VALUES (` +
      [
        sq(p.id), sq(p.userId), sq(p.showdate), sq(p.type), sq(JSON.stringify(p.payload)),
        sq(p.created), sq(p.updated),
        p.result ? sq(JSON.stringify(p.result)) : 'NULL',
        p.result ? p.result.score : 'NULL',
        p.result && p.result.bingo ? 1 : 0,
        p.liveChecked ? sq(JSON.stringify(p.liveChecked)) : 'NULL',
        sq(p.scoredAt),
      ].join(',') + `);`
    );
  }

  const dest = path.join(dataDir, 'seed.sql');
  fs.writeFileSync(dest, out.join('\n') + '\n');
  console.log(`Wrote ${dest} — ${db.users.length} users, ${db.predictions.length} predictions.`);
  console.log(`Claimable (no password): ${db.users.filter(u => !supplied.has(u.id)).map(u => u.id).join(', ') || 'none'}`);
  console.log(`\nseed.sql contains a password hash and is gitignored. Clear your shell history if needed.`);
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
