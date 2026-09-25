/**
 * `npm run fiscal-period-seed` — T-276's monthly fiscal-period coverage top-up.
 *
 * Invoked by the host's systemd timer, monthly on the 1st, alongside the other scheduled jobs.
 *
 * ## ⭐ What it is for
 *
 * An org is seeded 12 months of fiscal periods once, at bootstrap. This job keeps that window 12
 * months ahead of the current Manila business month, and — option (c) — backfills any month that
 * already elapsed with no period at all (created `open`, never closed retroactively), so a gap
 * shows up as a failure line here instead of `postEntry` silently refusing the next post.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is exactly what happens when nothing speaks up.
 *
 * ⛔ **Registering this job is not the finish line. Arming its timer is**, and only Ian can do
 * that: `provision.sh` is the only thing that installs unit files and the deploy pipeline ships no
 * `docs/`. See `docs/ops/README.md`.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runFiscalPeriodSeed } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  // ⭐ `manual` when a human typed it. "Nobody has run it since March" and "the cron died in March
  // and someone has been running it by hand" are different problems with different fixes.
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`fiscal-period-seed: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runFiscalPeriodSeed({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
      console.log(`${head}: ${o.detail ?? `inserted ${o.posted}`}`);
      continue;
    }
    // ⚠️ Counts, never a bare "done" (bible §15.6) — "inserted 0" on a fully-covered org is a
    // healthy no-op; the same figure on a run that saw no org at all is a configuration problem.
    console.log(`${head}: ${o.detail ?? `inserted ${o.posted}`}`);
    for (const f of o.failures) console.error(`${head}:   ⚠️ ${f.subjectName} — ${f.reason}`);
  }

  if (result.hadFailures) {
    console.error('fiscal-period-seed: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success — no orgs found is a configuration problem wearing the costume of a quiet
    // night, the same distinction budget-reissue and finding-observation both draw.
    console.error('fiscal-period-seed: no orgs were processed — nothing to seed?');
    return 1;
  }
  const inserted = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`fiscal-period-seed: ok — inserted ${inserted} · ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('fiscal-period-seed: crashed —', err);
    await closeDb();
    process.exit(1);
  });
