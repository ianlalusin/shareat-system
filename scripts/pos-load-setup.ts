/**
 * T-533 S2 - the one-time store setup load from POS v1 (Lipa). docs/tasks/533-pos-lipa-switch.md R2.
 *
 *   npm run pos:load-setup -- --store <erpStoreId> --org <orgId> --actor <person uuid> [--dry-run]
 *
 * Reads POS v1's tables, discounts and (T-626) menu, kitchen, hours and payment methods READ-ONLY (POS_BRIDGE_SA_KEY_FILE, Datastore-Viewer only) and writes
 * them through the audited domain functions as --actor, who must be a SUPER ADMIN (adding menu items and pairing prices to hours are super-admin only). --dry-run
 * does the same work inside a rolled-back savepoint and keeps nothing. A value already set in the ERP is never overwritten: it is listed as a difference.
 * Prints counts and names only, never a Firestore id or a key. Reports setup gaps and never fixes them. Check the result with `npm run pos:setup-check`.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function main(): Promise<void> {
  const storeId = arg('--store');
  const orgId = arg('--org');
  const personId = arg('--actor');
  const dryRun = process.argv.includes('--dry-run');
  if (!storeId || !UUID.test(storeId) || !orgId || !UUID.test(orgId) || !personId || !UUID.test(personId)) {
    fail('Usage: npm run pos:load-setup -- --store <erpStoreId uuid> --org <org uuid> --actor <person uuid> [--dry-run]');
  }
  const { closeDb, withOrgPrincipal } = await import('@shareat/db');
  const { PosStoreSetupFirestoreSource } = await import('@shareat/etl-firestore');
  const { loadStoreSetup, formatStoreSetupReport } = await import('../packages/etl/src/pos-v2/load-store-setup');
  try {
    const source = PosStoreSetupFirestoreSource.fromEnv(process.env);
    const report = await withOrgPrincipal(orgId!, (tx) => loadStoreSetup(tx, { orgId: orgId!, personId: personId! }, { storeId: storeId!, dryRun }, source));
    for (const line of formatStoreSetupReport(report)) console.log(line);
  } finally {
    await closeDb();
  }
}

main().catch((e: unknown) => {
  // A refusal or a missing key has a plain sentence; anything else prints its message only (no stack, no values).
  console.error(e instanceof Error ? e.message : 'The load failed.');
  process.exit(1);
});
