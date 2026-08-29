/**
 * The hot lane's transport-free half. Phase 4, lane B.
 *
 * ⭐ `packages/domain` owns the SHAPE; `packages/sync-firestore` owns the SDK. The same isolation
 * `packages/storage-firebase` and `packages/etl-firestore` already exist for, and the reason
 * `CLAUDE.md`'s one-line "packages/domain/sync/" is read as the logic rather than the adapter.
 */
export * from './publisher';
export * from './ingestor';
