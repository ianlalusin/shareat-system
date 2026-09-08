/**
 * `npm run attendance-sweep` — T-199. Closes shifts nobody clocked out of.
 *
 * ⚠️ **HOURLY, not daily.** The cut-off is a wall-clock hour PER STORE (v1: all three on 02:00),
 * so a daily timer could not serve two stores on different hours. Each run asks every store
 * whether its hour has come round; a store whose hour has not arrived is a cheap no-op.
 *
 *   0 * * * *  cd /srv/shareat && /usr/bin/npm run attendance-sweep >> /var/log/shareat-sweep.log 2>&1
 *
 * ⭐ See `docs/ops/shareat-attendance-sweep.timer` for the systemd unit, which is the form this
 * project prefers — and ⛔ **installing it is a step nobody has done yet.** That step, not the
 * code, is what failed for v1's depreciation cron and twice on POS.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is. ⛔ But it is NOT the safety net: a mailer cannot report a job that
 * was never scheduled at all. The `openShiftsStale` finding is what covers that, because it reads
 * the data rather than the scheduler.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runAttendanceSweep } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  // ⭐ `manual` when a human typed it. "Nobody has run it since March" and "the cron died in March
  // and someone has been running it by hand" are different problems with different fixes.
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`attendance-sweep: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);
  const result = await runAttendanceSweep({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName} · ${o.job}`;
    if (o.error) console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
    // ⚠️ Printed unconditionally, error or not — T-233 guard C can leave `o.error` set with the
    // work already committed, so these counts can be real even on a FAILED OUTRIGHT line
    // (`finding-observation.ts`/`budget-reissue.ts`/`recurring-expense-draft.ts` already get this
    // right, DEF-225).
    console.log(`${head}: closed ${o.posted}, still open ${o.skipped}, failed ${o.failed}`);
    for (const f of o.failures) console.error(`      ⛔ ${f.subjectName}: ${f.reason}`);
  }

  if (result.hadFailures) {
    console.error('attendance-sweep: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. An empty run means no orgs were found, which is a configuration problem
    // wearing the costume of a quiet hour (DEF-225).
    console.error('attendance-sweep: no orgs were processed — nothing to sweep?');
    return 1;
  }
  // ⚠️ Counts, never a bare silent 0-exit (bible §15.6) — DEF-225: this script used to print
  // nothing at all on success.
  const closed = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`attendance-sweep: ok — closed ${closed} · ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('attendance-sweep: crashed —', err);
    await closeDb();
    process.exit(1);
  });
