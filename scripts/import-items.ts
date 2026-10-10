/**
 * SUPERSEDED by `npm run master-data` (T-391). This script used to read v1's item master, import the items it judged
 * unambiguous and print the rest. The T-391 planner now decides every case it only reported (majority unit, containers,
 * twins, kinds), links v1 records so a re-run never double-writes, and holds what it cannot decide for Ian. The old
 * writer is gone on purpose: two ways to create items from v1 would mint two identities for one product.
 */
console.error('scripts/import-items.ts is superseded by `npm run master-data` (T-391). Nothing was read or written.');
process.exit(1);
