import { describe, expect, it } from 'vitest';
import { skippedJournalEntries } from '../../packages/db/migrate-check';

/**
 * T-598 S9 / DEF-094 - a journal entry the migrator passed over is named, not silently skipped.
 * MUTANT: compare only the newest `when` (`e.when > max(applied)`) -> the older skipped entry below is not found and this goes red.
 */
const journal = [
  { tag: '0001_a', when: 1000 },
  { tag: '0002_b', when: 500 }, // written with an older timestamp than 0001: drizzle skips it once 0001 is recorded
  { tag: '0003_c', when: 2000 },
];

describe('skippedJournalEntries', () => {
  it('names an older entry that was never recorded', () => {
    expect(skippedJournalEntries([1000, 2000], journal)).toEqual(['0002_b']);
  });
  it('is empty when every entry was recorded (created_at arrives as text from bigint)', () => {
    expect(skippedJournalEntries(['1000', '500', '2000'], journal)).toEqual([]);
  });
  it('an entry newer than everything applied is also unapplied', () => {
    expect(skippedJournalEntries([500, 1000], journal)).toEqual(['0003_c']);
  });
});
