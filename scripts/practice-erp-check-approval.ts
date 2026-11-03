/**
 * Practice ERP only: checks, against the practice database, exactly what the POS server's `approveManagerPin` does (apps/pos/src/server/pos2/deps.ts):
 * resolve the tablet's terminal link from (POS store id, device id), then verify a manager PIN. Prints accepted / refused per PIN. Never prints a PIN.
 * Run: node scripts/practice-erp-start.mjs check-approval   (guarded to _test databases like the other practice scripts)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '../packages/db/src/client';
import { withOrgPrincipal } from '../packages/db/src/rls/principal';
import { resolvePosTerminalLink } from '../packages/auth/src/pos-terminal-link';
import { verifyPosManagerApproval } from '../packages/auth/src/pos-approval';
import { AuthenticationError } from '../packages/auth/src/errors';

const dbName = (process.env.DATABASE_URL ?? '').split('?')[0]!.split('/').pop() ?? '';
if (!/_test/.test(dbName)) throw new Error(`practice-erp-check-approval: refusing, "${dbName}" is not a _test database.`);
const ids = JSON.parse(readFileSync(join(process.cwd(), 'apps', 'pos', 'emulator', '.practice', 'practice-erp.json'), 'utf8')) as { orgId: string; deviceId: string };
const PINS: [string, string][] = [
  ['manager PIN', '246801'],
  ['admin PIN', '135790'],
  ['cashier PIN (must be refused)', '112358'],
  ['made-up PIN (must be refused)', '999999'],
];

async function main() {
  const link = await withOrgPrincipal(ids.orgId, (tx) => resolvePosTerminalLink(tx, { orgId: ids.orgId, posStoreId: 'practice-store', deviceId: ids.deviceId }));
  console.log(`tablet link: resolved (terminal no ${link.terminalNo})`);
  for (const [label, pin] of PINS) {
    try {
      const r = await verifyPosManagerApproval(null, { orgId: ids.orgId, erpStoreId: link.erpStoreId, pin, terminalPersonId: link.terminalPersonId, deviceId: link.terminalPersonId });
      console.log(`${label}: ACCEPTED (approver ${r.approverPersonId})`);
    } catch (e) {
      if (!(e instanceof AuthenticationError)) throw e;
      console.log(`${label}: refused - ${e.message}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
