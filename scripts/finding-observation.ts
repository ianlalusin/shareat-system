/**
 * `npm run finding-observation` — T-214's daily observation run.
 *
 * Invoked by the host's systemd timer, daily:
 *
 *   docs/ops/shareat-finding-observation.timer  (OnCalendar=*-*-* 01:30 Asia/Manila)
 *
 * ## ⭐ What it is for
 *
 * A finding is a pure function of current state and carries no clock, so **when a condition first
 * appeared is not recoverable from anywhere**. This job is the clock: once a day it records that
 * each detector fired and closes the occurrences that stopped firing. Miss a day and nothing is
 * corrupted — the next run advances `last_seen_on` and life goes on — but the day itself is gone,
 * because it cannot be reconstructed after the fact.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is precisely what happens when nothing speaks up.
 *
 * ⛔ **Registering this job is not the finish line. Arming its timer is.** See `docs/ops/README.md`.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runFindingObservation } from '@shareat/domain';

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

  console.log(`finding-observation: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runFindingObservation({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
      continue;
    }
    // ⚠️ The periods list is the line worth reading: it is the evidence that a month still carrying
    // an open occurrence was actually RE-ASKED, rather than quietly abandoned at the boundary and
    // its finding recorded as fixed.
    console.log(`${head}: ${o.detail ?? `opened ${o.posted}`}`);
  }

  if (result.hadFailures) {
    console.error('finding-observation: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. An empty run means no orgs were found, which is a configuration problem
    // wearing the costume of a quiet night.
    console.error('finding-observation: no orgs were processed — nothing to observe?');
    return 1;
  }
  console.log('finding-observation: ok');
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('finding-observation: crashed —', err);
    await closeDb();
    process.exit(1);
  });
