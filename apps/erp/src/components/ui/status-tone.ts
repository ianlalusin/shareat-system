/**
 * Status -> tone (T-387 S3; ADR-013 Amendment 7, "the badge colour code"; lead ruling 2026-10-10).
 *
 * One table maps every lifecycle value in `packages/db/schema/*.ts` (and the branch-order stages) to one of six
 * tones. The complete-map guard in `tests/t387-s3-status-tone.test.ts` fails when a schema value has no entry, so
 * a new status cannot ship without a colour. An unmapped value at runtime does NOT throw: it falls back to
 * `closed` (a legacy or ETL value must never crash a page); the guard is what keeps the table complete.
 *
 * Both `void` and `voided` spellings exist in the schema (GLOSSARY :154-155) and both are mapped.
 */
export type Tone = 'info' | 'warning' | 'success' | 'progress' | 'danger' | 'closed';

const group = (tone: Tone, values: readonly string[]): ReadonlyArray<readonly [string, Tone]> =>
  values.map((v) => [v, tone] as const);

export const STATUS_TONE: Readonly<Record<string, Tone>> = Object.fromEntries([
  ...group('info', ['draft', 'open', 'planned', 'reserved']),
  ...group('warning', ['duplicate', 'submitted', 'requested', 'pending', 'waiting', 'needs_review', 'deferred', 'pending_valuation', 'paused', 'disputed']),
  ...group('success', [
    'approved', 'posted', 'confirmed', 'accepted', 'seated', 'played', 'released', 'received', 'verified', 'computed', 'finalized',
    'resolved', 'succeeded', 'active', 'liquidated', 'fully_amortised', 'paid_off', 'final',
  ]),
  ...group('progress', ['counting', 'reviewing', 'preparing', 'running', 'in_transit', 'dispatched', 'ready', 'called']),
  ...group('danger', ['void', 'voided', 'overdue', 'rejected', 'declined', 'failed', 'aborted', 'defaulted', 'written_off']),
  ...group('closed', [
    'closed', 'cancelled', 'removed', 'expired', 'reversed', 'disposed', 'merged', 'archived', 'inactive', 'locked', 'charged', 'income',
    'resigned', 'terminated', 'retired', 'withdrawn', 'superseded_by_work', 'gone',
  ]),
]);

/** The values with no entry in `table`. The complete-map guard runs every schema value through this. */
export function unmappedStatuses(values: readonly string[], table: Readonly<Record<string, Tone>> = STATUS_TONE): string[] {
  return values.filter((v) => !Object.prototype.hasOwnProperty.call(table, v));
}

/** The tone for a status. An unmapped value is `closed` (never throws; see the file header). */
export function statusTone(status: string): Tone {
  return Object.prototype.hasOwnProperty.call(STATUS_TONE, status) ? (STATUS_TONE[status] as Tone) : 'closed';
}

/** Sentence case: first letter up, `_` to a space, nothing else changed. Humanises unmapped values too. */
export function statusLabel(status: string): string {
  const t = status.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
