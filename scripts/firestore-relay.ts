/**
 * `npm run firestore-relay` — T-204. Drains the Firestore mirror outbox (Lane A) and ingests the
 * Firestore inbox into Postgres, adjudicating each day a new punch lands in (Lane B), for every
 * org — closing DEF-132 (nothing ever ran either lane against real Firestore) and DEF-134
 * (nothing ever computed a fresh day's `attendance_days` row).
 *
 * ⚠️ **Cadence: every 1-5 minutes**, not hourly like the attendance sweep. That job's hourly
 * cadence comes from a real anchor — a wall-clock hour PER STORE. This job has no such anchor:
 * punches and mirror updates are useful as soon as possible, but nothing breaks if a run is a few
 * minutes late (idempotent, and Firestore is durable storage in the meantime, not a queue that
 * drops). `docs/ops/shareat-firestore-relay.timer` fires every 2 minutes (`OnCalendar=*:0/2`) —
 * close enough that a clock terminal's punch reaches the roster within a couple of minutes, not
 * the next hour, without hammering Firestore or Postgres on an idle store.
 *
 *   0-59/2 * * * *  cd /srv/shareat && /usr/bin/npm run firestore-relay >> /var/log/shareat/firestore-relay.log 2>&1
 *
 * ⭐ See `docs/ops/shareat-firestore-relay.timer` for the systemd unit, which is the form this
 * project prefers — and ⛔ **installing it is a step nobody has done yet**, same as the attendance
 * sweep. That step, not the code, is what failed for v1's depreciation cron and twice on POS.
 *
 * ## ⚠️ Exit code is load-bearing
 *
 * Non-zero when a publish or an ingest failed outright, because a cron mailer that only speaks up
 * on failure is the cheapest watchdog there is. A per-punch ADJUDICATION failure (most commonly:
 * the day is already frozen by a paid pay run) does NOT flip this — it is printed, loudly, but is
 * an expected outcome of a replayed old punch, not a job failure.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runFirestoreRelay } from '@shareat/domain';
import { createFirestoreInboxDriver, createFirestoreMirrorDriver } from '@shareat/sync-firestore';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  const limitArg = arg('limit');
  const limit = limitArg ? Number(limitArg) : undefined;
  // ⭐ `manual` when a human typed it. "Nobody has run it since March" and "the cron died in March
  // and someone has been running it by hand" are different problems with different fixes.
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`firestore-relay: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);
  const result = await runFirestoreRelay(
    { mirror: createFirestoreMirrorDriver(), inbox: createFirestoreInboxDriver() },
    { orgId, trigger, limit },
  );

  for (const o of result.outcomes) {
    const head = `  ${o.orgName} · ${o.job}`;
    if (o.error) console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
    // ⚠️ Printed unconditionally, error or not — T-233 guard C can leave `o.error` set with the
    // work already committed, so these counts can be real even on a FAILED OUTRIGHT line
    // (`finding-observation.ts`/`budget-reissue.ts`/`recurring-expense-draft.ts` already get this
    // right, DEF-225). Also DEF-227's shape: a refused pre-loop org-resolution read now reaches
    // this same per-org error line instead of rejecting the whole run.
    console.log(`${head}: posted ${o.posted}, skipped ${o.skipped}, failed ${o.failed}`);
    for (const f of o.failures) console.error(`      ⛔ ${f.subjectName}: ${f.reason}`);
    if (o.adjudicationFailures?.length) {
      for (const f of o.adjudicationFailures) {
        console.error(`      ⚠️  punch ${f.clientPunchId} landed but its day did not recompute: ${f.detail}`);
      }
    }
  }

  if (result.hadFailures) {
    console.error('firestore-relay: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // ⛔ Not a success. An empty run means no orgs were found, which is a configuration problem
    // wearing the costume of a quiet run (DEF-225).
    console.error('firestore-relay: no orgs were processed — nothing to relay?');
    return 1;
  }
  // ⚠️ Counts, never a bare silent 0-exit (bible §15.6) — DEF-225: this script used to print
  // nothing at all on success. ⛔ Split by job, not summed into one number: `posted` means mirror
  // docs published for `mirror_publish` and inbox punches ingested for `inbox_relay` — two
  // different units, and a single combined total would hide, e.g., a healthy mirror covering for a
  // stalled inbox.
  const mirrorPosted = result.outcomes
    .filter((o) => o.job === 'mirror_publish')
    .reduce((sum, o) => sum + o.posted, 0);
  const inboxPosted = result.outcomes
    .filter((o) => o.job === 'inbox_relay')
    .reduce((sum, o) => sum + o.posted, 0);
  console.log(
    `firestore-relay: ok — mirror ${mirrorPosted} · inbox ${inboxPosted} · ${result.outcomes.length} outcomes`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('firestore-relay: crashed —', err);
    await closeDb();
    process.exit(1);
  });
