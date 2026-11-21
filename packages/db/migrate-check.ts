/**
 * DEF-094: drizzle's migrator applies only the journal entries NEWER than the newest one already recorded, so an entry whose `when`
 * is older than that and was never applied is passed over without a word and "Migrations applied" still prints. This names those entries.
 * Pure, so a test can hand it a journal; `migrate.ts` feeds it the real journal and the recorded `created_at` values.
 */
export interface JournalEntry {
  readonly tag: string;
  readonly when: number;
}

export function skippedJournalEntries(appliedCreatedAt: readonly (number | string)[], journal: readonly JournalEntry[]): string[] {
  const done = new Set(appliedCreatedAt.map(Number));
  return journal.filter((e) => !done.has(e.when)).map((e) => e.tag);
}
