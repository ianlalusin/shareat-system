/**
 * T-626 - the parity check: does POS v2 hold what POS v1 says this store sells?
 *
 *   npm run pos:setup-check -- --store <erpStoreId> --org <orgId>
 *
 * READ-ONLY. Reads POS v1's menu and kitchen (POS_BRIDGE_SA_KEY_FILE, Datastore-Viewer only), compares them with the store in the ERP database, then reads the menu the
 * tablet is given and checks every copied item is in it at the right price for the hours that are open now. Prints a plain table of OK and GAP lines (names and money
 * only, never a Firestore id or a key) and exits 1 when anything is a gap or a difference.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const storeId = arg('--store');
  const orgId = arg('--org');
  if (!storeId || !UUID.test(storeId) || !orgId || !UUID.test(orgId)) {
    console.error('Usage: npm run pos:setup-check -- --store <erpStoreId uuid> --org <org uuid>');
    return 1;
  }
  const { closeDb, withOrgPrincipal } = await import('@shareat/db');
  const { PosStoreSetupFirestoreSource } = await import('@shareat/etl-firestore');
  const { checkStoreSetup, formatStoreSetupCheck } = await import('../packages/etl/src/pos-v2/check-store-setup');
  try {
    const source = PosStoreSetupFirestoreSource.fromEnv(process.env);
    const result = await withOrgPrincipal(orgId, (tx) => checkStoreSetup(tx, { orgId, storeId }, source));
    for (const line of formatStoreSetupCheck(result)) console.log(line);
    return result.ok ? 0 : 1;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    // A refusal or a missing key has a plain sentence; anything else prints its message only (no stack, no values).
    console.error(e instanceof Error ? e.message : 'The check failed.');
    process.exit(1);
  },
);
