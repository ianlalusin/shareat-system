/**
 * @shareat/etl-firestore — the ONLY package in this repo permitted to depend on
 * `firebase-admin`. docs/tasks/114a-firestore-reader-and-capture.md.
 *
 * Isolated from `@shareat/etl` on purpose: T-112 invariant 22 asserts `packages/etl`
 * declares no Firebase dependency, so the read-only-migration guarantee is a fact about the
 * dependency graph, not a promise about behaviour — including for the analysis code T-114b
 * will add to `packages/etl`, which must never be able to reach production.
 */
export * from './client';
export * from './reader';
export * from './plan';
export * from './pos-receipts';
export * from './pos-receipt-map';
