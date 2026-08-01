// One-shot after migration 0002: give every existing user a handle, and give the
// owner row (whose name is an email address) its email column.
//
//   node scripts/backfill-handles.js            # print the UPDATEs (dry run)
//   node scripts/backfill-handles.js --local    # apply to the local D1
//   node scripts/backfill-handles.js --remote   # apply to production
//
// Reads live rows via wrangler rather than hardcoding anyone's data. Handles come from
// the display name / account name — never from the email (that is the leak handles fix).
// Rows that already have a handle are left alone, so this is safe to re-run.
const { execFileSync } = require('child_process');

const MODE = process.argv.includes('--remote') ? '--remote'
           : process.argv.includes('--local') ? '--local'
           : null;

const sq = v => `'${String(v).replace(/'/g, "''")}'`;

function d1(sql, apply) {
  // execFileSync with shell:true concatenates args unescaped on Windows, splitting the
  // SQL on spaces — so invoke wrangler's bin through node directly. require.resolve can't
  // reach it (the package's exports map hides ./bin), hence the explicit path.
  const wrangler = require('path').join(__dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [wrangler, 'd1', 'execute', 'kalphishi', apply || '--local', '--json', '--command', sql];
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results;
}

async function main() {
  const { handleCandidates, isValidEmail, normalizeEmail } = await import('../lib/identity.mjs');

  const users = d1(
    'SELECT id, name, handle, email, profile FROM users ORDER BY created', MODE || '--local'
  );
  const taken = new Set(users.map(u => u.handle && u.handle.toLowerCase()).filter(Boolean));
  const updates = [];

  for (const u of users) {
    const sets = [];

    if (!u.handle) {
      // Prefer the profile displayName; fall back to the account name unless the name is
      // an email address, in which case use only its local part's letters as a seed —
      // an email must never survive into a public handle.
      let profile = {};
      try { profile = JSON.parse(u.profile || '{}'); } catch {}
      let seed = profile.displayName || u.name || '';
      if (isValidEmail(seed)) seed = seed.split('@')[0].replace(/[0-9]+$/, '');
      let chosen = null;
      for (const cand of handleCandidates(seed)) {
        if (!taken.has(cand)) { chosen = cand; break; }
      }
      if (!chosen) throw new Error(`no free handle for ${u.id}`);
      taken.add(chosen);
      sets.push(`handle = ${sq(chosen)}`);
    }

    // A name that is a valid email doubles as the row's login address.
    if (!u.email && isValidEmail(u.name)) {
      sets.push(`email = ${sq(normalizeEmail(u.name))}`);
    }

    if (sets.length) updates.push(`UPDATE users SET ${sets.join(', ')} WHERE id = ${sq(u.id)};`);
  }

  if (!updates.length) { console.log('Nothing to do — all rows already have handles.'); return; }

  if (!MODE) {
    console.log('Dry run. Would apply:\n');
    for (const s of updates) console.log('  ' + s);
    console.log('\nRe-run with --local or --remote to apply.');
    return;
  }

  d1(updates.join(' '), MODE);
  console.log(`Applied ${updates.length} update(s) ${MODE}.`);
  const after = d1('SELECT handle, CASE WHEN email IS NULL THEN 0 ELSE 1 END AS has_email FROM users', MODE);
  console.log('Now:', after.map(r => `${r.handle}${r.has_email ? ' (email set)' : ''}`).join(', '));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
