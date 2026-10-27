/**
 * `npm run inter-entity-reconcile` - T-398 S5e: the 06:30 Manila reconciliation of the commissary's books with each linked franchise's.
 *
 * Invoked by the host's systemd timer, daily:
 *
 *   docs/ops/shareat-inter-entity-reconcile.timer  (OnCalendar=*-*-* 06:30:00 Asia/Manila)
 *
 * For every organisation: each RECEIVED shipment is compared with what the other side posted, and each linked pair's running balance with the
 * other side's one-number figure. The commissary (the seller) gets one open "credit note to the franchise" to-do per short shipment line.
 * Nothing is posted and no franchise book is ever written.
 *
 * Exit code is load-bearing: non-zero when any organisation failed, or when no organisation was found at all (a configuration problem wearing
 * the costume of a quiet morning).
 *
 * Flags: `--org=<id>` runs one organisation; `--manual` records trigger `manual` (a human typed it).
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runInterEntityReconcile } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

async function main(): Promise<number> {
  const orgId = arg('org');
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`inter-entity-reconcile: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runInterEntityReconcile({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT - ${o.error}`);
      console.log(`${head}: ${o.detail ?? `raised ${o.posted}`}`);
      continue;
    }
    console.log(`${head}: ${o.detail ?? `raised ${o.posted}`}`);
  }

  if (result.hadFailures) {
    console.error('inter-entity-reconcile: finished WITH FAILURES - see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    console.error('inter-entity-reconcile: no orgs were processed - nothing to reconcile?');
    return 1;
  }
  const raised = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`inter-entity-reconcile: ok - raised ${raised} credit-note to-do(s) - ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('inter-entity-reconcile: crashed -', err);
    await closeDb();
    process.exit(1);
  });
