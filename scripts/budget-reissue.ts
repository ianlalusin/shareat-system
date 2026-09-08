/**
 * `npm run budget-reissue` — T-215's daily envelope roll-forward.
 *
 * Invoked by the host's systemd timer, daily, alongside the other scheduled jobs.
 *
 * ## ⭐ What it is for
 *
 * A spending cap that has to be re-typed every month is a cap that stops existing in the second
 * month. This job moves a `weekly`/`daily`/`bi_weekly` budget's WINDOW forward, and creates the
 * next row for a `monthly`/`quarterly`/`annually` one — **only once that period has arrived.**
 * v1's own comment is the reason and it is ported verbatim: *"never pre-create future months, so
 * the reissue processor can't run away."*
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is exactly what happens when nothing speaks up.
 *
 * ⛔ **Registering this job is not the finish line. Arming its timer is**, and only Ian can do
 * that: `provision.sh` is the only thing that installs unit files and the deploy pipeline ships no
 * `docs/`. Three jobs have now shipped unarmed (DEF-194). See `docs/ops/README.md`.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runBudgetReissue } from '@shareat/domain';

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

  console.log(`budget-reissue: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runBudgetReissue({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
      // ⭐ T-233 guard C can keep the REAL posted/skipped even when only the run's own
      // bookkeeping failed — print them, or an operator reads "FAILED OUTRIGHT" for a run that
      // actually created something.
      console.log(`${head}: ${o.detail ?? `created ${o.posted}`}`);
      continue;
    }
    // ⚠️ Counts, never a bare "done" (bible §15.6). "created 0" on a run that saw 40 budgets is a
    // healthy no-op; "created 0" on a run that saw none is a configuration problem, and the two
    // are indistinguishable without the first number.
    console.log(`${head}: ${o.detail ?? `created ${o.posted}`}`);
    for (const f of o.failures) console.error(`${head}:   ⚠️ ${f.subjectName} — ${f.reason}`);
  }

  if (result.hadFailures) {
    console.error('budget-reissue: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. No orgs found is a configuration problem wearing the costume of a quiet
    // night — the same distinction `finding-observation` draws, for the same reason.
    console.error('budget-reissue: no orgs were processed — nothing to reissue?');
    return 1;
  }
  // ⚠️ Counts, never a bare "done" (bible §15.6) — the same rule the per-org lines above already
  // follow, applied to the script's own summary line.
  const created = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`budget-reissue: ok — created ${created} · ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('budget-reissue: crashed —', err);
    await closeDb();
    process.exit(1);
  });
