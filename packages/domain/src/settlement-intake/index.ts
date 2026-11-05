/**
 * T-511 S3 - the settlement file readers (pure). `docs/tasks/511-settlement-upload-s3-spec.md`.
 *
 * Turn a Grab or Foodpanda file into typed rows with no database, no auth and no posting: `safe-zip` (zip and inner-workbook guards),
 * `grab-transactions` / `grab-transfers` / `grab-payouts` (CSV readers and the payout control total), `foodpanda-workbook` (the invoice
 * workbook) and `deduction-mapping` (Component I as data). Server-only. Staging, store matching and posting arrive in slice 4.
 * Nothing in this folder imports `@shareat/db` transactions or writes to disk.
 */
/** Stamped on every file result so a stored row says which reader version produced it (defined in the leaf `version.ts`). */
export { READER_VERSION } from './version';

export * from './refusal';
export * from './safe-zip';
export * from './grab-transactions';
export * from './grab-transfers';
export * from './grab-payouts';
export * from './foodpanda-workbook';
export * from './deduction-mapping';
