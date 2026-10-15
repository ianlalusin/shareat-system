/**
 * `npm run usage-auto-post` - T-401 S6 round 2 (Ian, 15 Oct): the next-afternoon auto-post of POS-pull usage drafts.
 *
 * Invoked by the host's systemd timer, daily at 14:05 Manila (docs/ops/README.md).
 *
 * ## What it is for
 *
 * Finalizing the v1 POS usage pull makes a usage DRAFT at the expected quantities. A manager posts it after staff correct it to the
 * actuals. A draft nobody posted by 14:00 Manila the day after its business date is posted by this job: lines inside the tolerance as
 * they stand, lines outside it at the expected quantity. The record is marked auto-posted and audited (`stock.usage_auto_posted`).
 * A draft the system cannot post (a room being counted, a closed stock month, a short item) is left as a draft and printed below.
 *
 * ## Exit code is load-bearing
 *
 * Non-zero when an org failed outright, or when no org was found at all (a configuration fault wearing the costume of a quiet
 * afternoon). A draft that was skipped is printed as a warning and does NOT fail the run: it is still a draft a manager can post.
 *
 * Registering this job is not the finish line. Arming its timer is, and only Ian can do that (docs/ops/README.md).
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { usageAutoPostSweep } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';
  console.log(`usage-auto-post: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await usageAutoPostSweep({ orgId });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT - ${o.error}`);
      continue;
    }
    console.log(`${head}: auto-posted ${o.posted} - left as draft ${o.skipped.length}`);
    for (const s of o.skipped) console.error(`${head}:   WARNING usage record ${s.recordId} not posted - ${s.reason}`);
  }

  if (result.hadFailures) {
    console.error('usage-auto-post: finished WITH FAILURES - see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    console.error('usage-auto-post: no orgs were processed - nothing to post?');
    return 1;
  }
  const posted = result.outcomes.reduce((n, o) => n + o.posted, 0);
  const left = result.outcomes.reduce((n, o) => n + o.skipped.length, 0);
  console.log(`usage-auto-post: ok - auto-posted ${posted} - left as draft ${left} - ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('usage-auto-post: crashed -', err);
    await closeDb();
    process.exit(1);
  });
