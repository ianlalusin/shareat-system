/**
 * `npm run recode-items -- --org=<uuid> --actor=<super-admin person uuid> [--apply]` - T-386 R11, the one-time recode.
 *
 * Gives every legacy item code (anything not of the shape `AAAA-NNN`) a code allocated from its name, oldest first.
 * DRY RUN by default: the whole recode runs in one transaction and is ROLLED BACK, printing the exact codes `--apply` will
 * write. `--apply` commits that same transaction. Exit 1 when any item was skipped (a name with no letters or numbers) or the
 * org has no items.
 */
import { config } from 'dotenv';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closeDb, itemsRepo, withOrgPrincipal } from '@shareat/db';
import { recodeItems } from '@shareat/domain';

config({ path: '.env.local' });

export interface RecodeRunResult {
  recoded: number;
  kept: number;
  skipped: number;
  lines: string[];
}

class DryRunRollback extends Error {}

export async function run(o: {
  org: string;
  actor: string;
  apply: boolean;
  out?: (line: string) => void;
}): Promise<RecodeRunResult> {
  const lines: string[] = [];
  const emit = (l: string) => {
    lines.push(l);
    (o.out ?? console.log)(l);
  };

  let result: RecodeRunResult | undefined;
  try {
    await withOrgPrincipal(o.org, async (tx) => {
      const rows = await recodeItems(tx, { personId: o.actor, orgId: o.org }, { orgId: o.org });
      const total = (await itemsRepo.listItems(tx, o.org, { includeInactive: true })).length;
      const changed = rows.filter((r) => r.to !== null);
      const skippedRows = rows.filter((r) => r.to === null);
      for (const r of changed) emit(`${r.from} -> ${r.to}  ${r.name} (${r.status})`);
      if (skippedRows.length > 0) {
        emit('skipped:');
        for (const r of skippedRows) emit(`  ${r.from}  ${r.name} (${r.status}) - ${r.note}`);
      }
      result = { recoded: changed.length, kept: total - rows.length, skipped: skippedRows.length, lines };
      emit(`recoded ${result.recoded} · kept ${result.kept} · skipped ${result.skipped}`);
      emit(o.apply ? 'APPLIED.' : 'DRY RUN - nothing written. Re-run with --apply to write these codes.');
      if (!o.apply) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return result!;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const org = arg('org');
  const actor = arg('actor');
  if (!org || !actor) throw new Error('Pass --org=<uuid> --actor=<person uuid of a super-admin> [--apply].');
  const res = await run({ org, actor, apply: process.argv.includes('--apply') });
  if (res.recoded + res.kept + res.skipped === 0) {
    console.error('This org has no items.');
    return 1;
  }
  return res.skipped > 0 ? 1 : 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then(async (code) => {
      await closeDb();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('recode-items FAILED:', err);
      await closeDb();
      process.exit(1);
    });
}
