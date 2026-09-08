/**
 * `npm run order-wastage-backstop` — T-178's 15-day auto-charge/absorb backstop for tracked order
 * wastage.
 *
 * Invoked by the host's systemd timer, daily:
 *
 *   docs/ops/shareat-order-wastage-backstop.timer  (OnCalendar=*-*-* 02:30 Asia/Manila)
 *
 * ## ⭐ What it is for
 *
 * A tracked order wastage (grab/foodpanda/dine-in short, damaged, disputed) sits open until a
 * human resolves it. This job is the 15-day clock: past that, it fires uniformly — allocated split
 * charged, else the store's Wastage Monitor charged, else the store absorbs net-zero — including
 * for disputed records (task 178 invariant 4, deliberately not carved out).
 *
 * ⛔ **Registering the domain function (`runOrderWastageBackstopSweep`, `@shareat/domain`) was not
 * the finish line. This script existing and its timer being armed is.** DEF-226: the function
 * shipped with T-178 and had no caller anywhere until this file — the same DEF-186 shape a second
 * time. See `docs/ops/README.md`.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when anything failed, because a cron mailer that only speaks up on failure is the
 * cheapest watchdog there is — and DEF-044 is precisely what happens when nothing speaks up.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runOrderWastageBackstopSweep } from '@shareat/domain';

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

  console.log(`order-wastage-backstop: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runOrderWastageBackstopSweep({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
    }
    // ⚠️ Printed unconditionally, error or not — no `continue` after the line above. T-233 guard C
    // can leave `o.error` set with the work already committed (`finishRun` itself refused), so
    // `posted`/`skipped`/`failed` can be real even on a FAILED OUTRIGHT line; skipping this line on
    // error would read as "nothing happened" for a run that actually closed something
    // (finding-observation.ts:48-51 is the sibling that already gets this right). Guard A/B leave
    // every count at 0 and `failures` empty, so printing this unconditionally costs nothing there.
    console.log(`${head}: posted ${o.posted}, skipped ${o.skipped}, failed ${o.failed}`);
    for (const f of o.failures) {
      console.error(`      ⛔ ${f.subjectName}: ${f.reason}`);
    }
  }

  if (result.hadFailures) {
    console.error('order-wastage-backstop: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. An empty run means no orgs were found, which is a configuration problem
    // wearing the costume of a quiet night (DEF-225's lesson, built in here rather than retrofitted).
    console.error('order-wastage-backstop: no orgs were processed — nothing to observe?');
    return 1;
  }
  // ⚠️ Counts, never a bare "done" (bible §15.6). `posted` here is wastages CLOSED — charged or
  // absorbed — `runOrderWastageBackstop`'s `outcomes.length` (packages/domain/src/wastage/orders.ts).
  const closed = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`order-wastage-backstop: ok — closed ${closed} · ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('order-wastage-backstop: crashed —', err);
    await closeDb();
    process.exit(1);
  });
