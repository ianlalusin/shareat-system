/**
 * T-598 S7 / DEF-542: the fiscal-period repo does its day arithmetic with core, so a year core refuses is refused here too.
 */
import { describe, expect, it } from 'vitest';
import { firstCoverageGapBefore } from '../src/repo/fiscal-periods';
import type { Tx } from '../src/client';

// The date is judged before the transaction is touched, so a bare stub is enough: a refusal means the date check ran first.
const tx = {} as Tx;

describe('firstCoverageGapBefore date arithmetic (DEF-542)', () => {
  it('refuses a year core refuses (3000), as core does', async () => {
    await expect(firstCoverageGapBefore(tx, 'org', '3000-01-01')).rejects.toThrow(/Invalid business date/);
  });
  it('refuses a year before 1900 (0099)', async () => {
    await expect(firstCoverageGapBefore(tx, 'org', '0099-01-01')).rejects.toThrow(/Invalid business date/);
  });
});
