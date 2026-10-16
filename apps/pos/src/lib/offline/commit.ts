"use client";

/** The subset of Firebase's `WriteBatch` we depend on — declared locally so the
 *  helper is unit-testable with a fake and carries no hard Firestore import. */
export interface Committable {
  commit(): Promise<void>;
}

/**
 * Commits a batch "local-first". Firestore applies a batch's writes to the local
 * cache synchronously inside `commit()`, but the returned promise only resolves
 * once the SERVER acknowledges — which never happens while offline. We therefore
 * DO NOT await it: we return immediately (the caller already holds any
 * pre-generated doc ids) and route a late server-side failure to `onError` for
 * the sync report. This is the change that lets writes complete with no
 * connection.
 */
export function commitLocalFirst(
  batch: Committable,
  onError?: (err: unknown) => void,
): void {
  // Calling commit() triggers the synchronous local-cache write. The promise is
  // intentionally not awaited; we only observe eventual failure. A throwing
  // onError must not itself become an unhandled rejection, so it is guarded.
  void batch.commit().catch((err) => {
    try {
      if (onError) onError(err);
    } catch {
      // Swallow: an onError that throws must not escape as an unhandled rejection.
    }
  });
}
