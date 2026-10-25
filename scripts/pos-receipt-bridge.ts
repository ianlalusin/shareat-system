/**
 * `npm run pos-receipt-bridge` - T-472: the 06:30 Manila nightly copy of every POS receipt from Firebase into Postgres.
 *
 * Invoked by the host's systemd timer (S3 adds the units and the npm script entry). Read-only on Firebase: the credential is
 * `POS_BRIDGE_SA_KEY_FILE`, a Datastore-Viewer-only service account, never the POS v2 server key.
 *
 * Exit code is load-bearing: non-zero when an org failed outright, any store-day was refused, or no org was found at all.
 *
 * Flags: `--org=<id>` runs one org; `--manual` records trigger `manual`; `--dry-run` reads and reports what it WOULD copy (it
 * ignores the 2027-01-01 write floor so the December rehearsal works) and writes nothing.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { posReceiptBridgeSweep } from '@shareat/domain';
import { PosReceiptBridgeAdapter } from '@shareat/etl-firestore/pos-receipt-bridge-adapter';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

/** Dead-man's switch. Never throws, never changes the exit code, and never prints the URL (it carries a secret token). */
async function heartbeat(failed: boolean, lines: string[]): Promise<void> {
  const url = process.env['POS_BRIDGE_HEARTBEAT_URL'];
  if (!url) {
    console.log('pos-receipt-bridge: no heartbeat configured (POS_BRIDGE_HEARTBEAT_URL unset) - a dead timer will not be noticed.');
    return;
  }
  try {
    const base = url.replace(/\/+$/, '');
    if (failed) {
      await fetch(`${base}/fail`, {
        method: 'POST',
        body: lines.join(String.fromCharCode(10)) || 'pos-receipt-bridge failed',
        signal: AbortSignal.timeout(10_000),
      });
    } else await fetch(base, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  } catch {
    console.error('pos-receipt-bridge: heartbeat ping failed (network) - the run itself is unaffected.');
  }
}

async function main(): Promise<number> {
  const orgId = arg('org');
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';
  const dryRun = process.argv.includes('--dry-run');
  console.log(`pos-receipt-bridge: running (${trigger}${dryRun ? ', dry run' : ''})${orgId ? ` for org ${orgId}` : ''}`);

  const port = PosReceiptBridgeAdapter.fromEnv(process.env);
  const result = await posReceiptBridgeSweep({ orgId, trigger, dryRun, now: new Date(), port });

  const failLines: string[] = [];
  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT - ${o.error}`);
      failLines.push(`${o.orgName}: FAILED OUTRIGHT - ${o.error}`);
      continue;
    }
    console.log(`${head}: ${o.detail ?? `wrote ${o.posted} - already there ${o.skipped}`}`);
    for (const f of o.failures) {
      if (f.kind === 'notice') console.log(`${head}:   note - ${f.subjectName}: ${f.reason}`);
      else {
        console.error(`${head}:   FAILED - ${f.subjectName}: ${f.reason}`);
        failLines.push(`${f.subjectName}: ${f.reason}`);
      }
    }
  }

  if (result.hadFailures) {
    console.error('pos-receipt-bridge: finished WITH FAILURES - see above.');
    await heartbeat(true, failLines);
    return 1;
  }
  if (result.outcomes.length === 0) {
    console.error('pos-receipt-bridge: no orgs were processed - nothing to copy?');
    await heartbeat(true, ['no orgs were processed']);
    return 1;
  }
  const posted = result.outcomes.reduce((n, o) => n + o.posted, 0);
  console.log(`pos-receipt-bridge: ok - ${dryRun ? 'would write' : 'wrote'} ${posted} - ${result.outcomes.length} orgs`);
  await heartbeat(false, []);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    // The message of a credential error is a fixed sentence; nothing from the key file is ever in it.
    console.error('pos-receipt-bridge: crashed -', err instanceof Error ? err.message : 'unknown error');
    await closeDb();
    process.exit(1);
  });
