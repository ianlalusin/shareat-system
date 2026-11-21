/**
 * T-598 S9 / DEF-410: a backfill script keeps going after one org fails, and says which failed.
 */
import { describe, expect, it } from 'vitest';
import { forEachOrg } from '../../scripts/lib/each-org';

const orgs = [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }, { id: '3', name: 'Three' }];

describe('forEachOrg', () => {
  it('org 2 fails, org 3 still runs, and the failure names org 2', async () => {
    const ran: string[] = [];
    const { done, failed } = await forEachOrg(orgs, async (o) => {
      if (o.id === '2') throw new Error('periods are closed');
      ran.push(o.id);
      return o.name;
    });
    expect(ran).toEqual(['1', '3']);
    expect(done).toEqual(['One', 'Three']);
    expect(failed).toEqual([{ org: orgs[1], message: 'periods are closed' }]);
  });

  it('a clean run has no failures', async () => {
    const { failed } = await forEachOrg(orgs, async (o) => o.id);
    expect(failed).toEqual([]);
  });
});
