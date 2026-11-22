/**
 * T-625 step 4.1. Refills the clock-terminal mirror in the NEW (empty) Firestore: queues ONE fresh outbox row per live roster
 * employment, live biometric credential and current store config, and nothing else (no history, no tombstones). The relay then
 * publishes each from live data. Safe to repeat: an entity that already has an unsent row is skipped.
 *
 *   npx tsx scripts/firebase-move/reseed-mirror.ts                dry run: counts only, writes nothing
 *   npx tsx scripts/firebase-move/reseed-mirror.ts --check        read-only coverage: live entities with no outbox row
 *   npx tsx scripts/firebase-move/reseed-mirror.ts --confirm      queues the rows
 *
 * Prints counts only, never an id or a name.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { MoveArgError, parseMode, relayRunsNeeded, RELAY_ROWS_PER_RUN, safeMessage } from './lib';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function pendingLine(pending: readonly number[]): string {
  const runs = relayRunsNeeded(pending);
  return `waiting in the queue: ${sum(pending)} (busiest org ${Math.max(0, ...pending)}) - the relay sends ${RELAY_ROWS_PER_RUN} per org per run, so ${runs} run(s) to empty it`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { confirm } = parseMode(argv);
  const check = argv.includes('--check');
  if (check && confirm) throw new MoveArgError('Use --check OR --confirm, not both.');

  const { requireSystemUrl } = await import('./db');
  requireSystemUrl();
  const { readCoverage, enqueueAll } = await import('./reseed-db');

  const { coverage, pending } = await readCoverage();
  const live = sum(coverage.map((c) => c.live));
  console.log(`reseed-mirror: ${confirm ? 'CONFIRM' : check ? 'CHECK (read-only)' : 'DRY RUN (nothing is written)'}`);
  for (const c of coverage) console.log(`  ${c.entity}: ${c.live} live, ${c.noRow} never queued, ${c.noPending} with no unsent row`);
  if (live === 0) {
    console.error('reseed-mirror: zero live entities. That is a wrong database or connection, not an empty system. Nothing written.');
    return 1;
  }

  if (check) {
    console.log(`  ${pendingLine(pending)}`);
    const holes = sum(coverage.map((c) => c.noRow));
    console.log(holes === 0 ? 'reseed-mirror: OK - every live entity has been queued at least once.' : `reseed-mirror: ${holes} live entity(ies) were never queued. Run with --confirm.`);
    return holes === 0 ? 0 : 1;
  }

  if (!confirm) {
    console.log(`  would queue ${sum(coverage.map((c) => c.noPending))} row(s). Add --confirm to do it.`);
    return 0;
  }

  const r = await enqueueAll();
  const queued = Object.entries(r.added).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing';
  console.log(`reseed-mirror: queued ${queued}`);
  console.log(`  ${pendingLine(r.pending)}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('reseed-mirror FAILED:', safeMessage(e));
    process.exit(1);
  });
