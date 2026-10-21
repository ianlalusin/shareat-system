/**
 * `npm run pos-day-import` - T-396 S1: the 06:00 Manila import of every POS-linked store's closed days, as DRAFTS.
 *
 * Invoked by the host's systemd timer, daily at 06:00 Manila (docs/ops/README.md).
 *
 * ## What it is for
 *
 * Drafts yesterday's sales day, and any missed day in the last 7, for every store with a live POS link. The draft is `open`: it never
 * submits, verifies or posts. A day POS has no sales for yet is a notice (asked again tomorrow); everything else that goes wrong is a
 * failure line, printed below.
 *
 * ## Exit code is load-bearing
 *
 * Non-zero when an org failed outright, when any store-date was refused, or when no org was found at all (a configuration fault
 * wearing the costume of a quiet morning).
 *
 * Flags: `--org=<id>` runs one org; `--manual` records audit source and run trigger `manual`; `--dry-run` fetches and tries every
 * import inside a transaction it rolls back, writes no run row, and lists what would import.
 *
 * Registering this job is not the finish line. Arming its timer is, and only Ian can do that (docs/ops/README.md).
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { posDayImportSweep } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

/**
 * Dead-man's switch: tells the healthcheck service how the run went. Never throws, never changes the exit code, and never
 * writes the URL anywhere (it carries a secret token - even a network error message may quote it).
 */
async function heartbeat(failed: boolean, lines: string[]): Promise<void> {
  const url = process.env['POS_IMPORT_HEARTBEAT_URL'];
  if (!url) {
    console.log('pos-day-import: no heartbeat configured (POS_IMPORT_HEARTBEAT_URL unset) - a dead timer will not be noticed.');
    return;
  }
  try {
    const base = url.replace(/\/+$/, '');
    if (failed) {
      await fetch(`${base}/fail`, {
        method: 'POST',
        body: lines.join(String.fromCharCode(10)) || 'pos-day-import failed',
        signal: AbortSignal.timeout(10_000),
      });
    } else await fetch(base, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  } catch {
    console.error('pos-day-import: heartbeat ping failed (network) - the run itself is unaffected.');
  }
}

async function main(): Promise<number> {
  const orgId = arg('org');
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';
  const dryRun = process.argv.includes('--dry-run');
  console.log(`pos-day-import: running (${trigger}${dryRun ? ', dry run' : ''})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await posDayImportSweep({ orgId, trigger, dryRun, now: new Date() });

  const failLines: string[] = [];
  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) {
      console.error(`${head}: FAILED OUTRIGHT - ${o.error}`);
      failLines.push(`${o.orgName}: FAILED OUTRIGHT - ${o.error}`);
      continue;
    }
    console.log(`${head}: ${o.detail ?? `imported ${o.posted} - already there ${o.skipped}`}`);
    for (const w of o.wouldImport ?? []) console.log(`${head}:   would import ${w}`);
    for (const f of o.failures) {
      if (f.kind === 'notice') console.log(`${head}:   note - ${f.subjectName}: ${f.reason}`);
      else {
        console.error(`${head}:   FAILED - ${f.subjectName}: ${f.reason}`);
        failLines.push(`${f.subjectName}: ${f.reason}`);
      }
    }
  }

  if (result.hadFailures) {
    console.error('pos-day-import: finished WITH FAILURES - see above.');
    await heartbeat(true, failLines);
    return 1;
  }
  if (result.outcomes.length === 0) {
    console.error('pos-day-import: no orgs were processed - nothing to import?');
    await heartbeat(true, ['no orgs were processed']);
    return 1;
  }
  const posted = result.outcomes.reduce((n, o) => n + o.posted, 0);
  console.log(`pos-day-import: ok - ${dryRun ? 'would import' : 'imported'} ${posted} - ${result.outcomes.length} orgs`);
  await heartbeat(false, []);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('pos-day-import: crashed -', err);
    await closeDb();
    process.exit(1);
  });
