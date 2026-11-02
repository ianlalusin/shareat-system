/**
 * `npm run lobby-nightly` - T-455 S9a: the 05:30 Manila purge of the customer lobby, for every org that runs it.
 * docs/tasks/455-customer-lobby.md "S9 rulings" item 4; the units are docs/ops/shareat-lobby-nightly.{service,timer}.
 *
 * Per org (`runLobbyNightly`): expire entries older than 3 h, sweep stale pending discount claims, and NULL the personal columns (display name, note, device and
 * ip hashes, hand-off link, celebrant name) on entries closed more than 24 h ago. No row is deleted. The job holds no data of its own: re-running it changes nothing.
 *
 * Exit code is load-bearing: non-zero when any org failed. No org with a lobby_stores row is NOT a failure (the timer is armed before the first store is switched on).
 * Counts only are printed, never a name.
 *
 * ⛔ Registering this job is not the finish line. Arming its timer is, and only Ian can do that (docs/ops/customer-lobby-runbook.md).
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runLobbyNightlyJob } from '@shareat/domain';

config({ path: '.env.local' });

async function main(): Promise<number> {
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';
  console.log(`lobby-nightly: running (${trigger})`);

  const result = await runLobbyNightlyJob();

  for (const o of result.outcomes) {
    if (!o.ok) {
      console.error(`  org ${o.orgId}: FAILED - ${o.error ?? 'unknown'}`);
      continue;
    }
    console.log(
      `  org ${o.orgId}: expired ${o.entriesExpired ?? 0} entries, ${o.claimsExpired ?? 0} claims; purged ${o.entriesPurged ?? 0} entries, ${o.birthdayNamesPurged ?? 0} birthday names`,
    );
  }

  if (result.hadFailures) {
    console.error('lobby-nightly: finished WITH FAILURES - see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    // Not a failure: the timer is armed BEFORE the first store is switched on (docs/ops/customer-lobby-runbook.md), and until then no org has a lobby_stores row.
    console.log('lobby-nightly: no org has a lobby_stores row yet - nothing to purge');
    return 0;
  }
  console.log(`lobby-nightly: ok - ${result.outcomes.length} org(s)`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    // Only the error class: a database message can echo a row value.
    console.error('lobby-nightly: crashed -', err instanceof Error ? err.name : 'unknown error');
    await closeDb();
    process.exit(1);
  });
