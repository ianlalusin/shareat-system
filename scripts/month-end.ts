/**
 * `npm run month-end` — the month-end scheduler's entry point. T-140.
 *
 * Invoked by the host's cron or a systemd timer, e.g. on the 1st at 02:00:
 *
 *   0 2 1 * *  cd /srv/shareat && /usr/bin/npm run month-end >> /var/log/shareat-month-end.log 2>&1
 *
 * ## ⭐ Why a CLI and not an HTTP route
 *
 * An HTTP trigger needs a shared secret and adds a public surface to protect for no gain — and POS
 * already carries that landmine, where the `gcloud` job output **echoes `CRON_SECRET`** into the
 * console. In-process `node-cron` is worse still: it dies with the process and fires N times on N
 * instances.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is precisely what happens when nothing speaks up.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runMonthEnd, lastCompletedPeriod } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main(): Promise<number> {
  const period = arg('period') ?? lastCompletedPeriod();
  const orgId = arg('org');
  // ⭐ `manual` when a human typed it. "Nobody has run it since March" and "the cron died in March
  // and someone has been clicking the button" are different problems with different fixes.
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`month-end: running through ${period} (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runMonthEnd({ period, orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName} · ${o.job}`;
    if (o.error) console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
    // ⚠️ Printed unconditionally, error or not — T-233 guard C can leave `o.error` set with the
    // work already committed (`finishRun` itself refused), so these counts can be real even on a
    // FAILED OUTRIGHT line; skipping this line on error would read as "nothing happened" for a run
    // that actually posted something (`finding-observation.ts`/`budget-reissue.ts`/
    // `recurring-expense-draft.ts` are the siblings that already get this right, DEF-225).
    console.log(
      `${head}: posted ${o.posted}, skipped ${o.skipped}, failed ${o.failed}`,
    );
    // ⚠️ Every failure is printed in full. The most likely one is mundane and WILL happen —
    // "no fiscal period covers 2026-06-30" — and swallowing it here would rebuild the silence
    // this whole task exists to remove.
    for (const f of o.failures) {
      console.error(`      ⛔ ${f.subjectName}: ${f.reason}`);
    }
  }

  if (result.hadFailures) {
    console.error('month-end: finished WITH FAILURES — see above. Nothing was rolled back;');
    console.error('           each item posts in its own transaction, so re-running is safe and');
    console.error('           will pick up whatever is fixed.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. An empty run means no orgs were found, which is a configuration problem
    // wearing the costume of a quiet night (DEF-225).
    console.error('month-end: no orgs were processed — nothing to close?');
    return 1;
  }
  // ⚠️ Counts, never a bare "done" (bible §15.6) — DEF-225: this line used to be a bare
  // "finished cleanly" with no numbers at all.
  const posted = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`month-end: ok — posted ${posted} · ${result.outcomes.length} outcomes`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    // ⛔ A crash before any run row is written is the one case the table cannot record, so it has
    // to be loud here.
    console.error('month-end: CRASHED before completing —', err);
    await closeDb();
    process.exit(1);
  });
