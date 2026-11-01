import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEF-809 follow-up: where a sign-in lands when `next` says nothing usable.
 * manager -> /sales-days, staff WITHOUT submit_sales_day -> STAFF_HOME, staff WITH a position grant -> /sales-days;
 * an explicit safe `next` always wins; unsafe `next` never does. `can` is the real decision in production
 * (position grants count there); here it is faked so the three people can be told apart.
 */
const { H } = vi.hoisted(() => ({ H: { allowed: new Set<string>() } }));

vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<typeof import('@shareat/auth')>()),
  can: vi.fn(async (_tx: unknown, actor: { personId: string }, cap: string) => cap === 'submit_sales_day' && H.allowed.has(actor.personId)),
}));
vi.mock('../src/lib/session', () => ({ actorForToken: async (token: string) => ({ personId: token, orgId: 'org' }) }));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('../src/app/reports/lib', () => ({ scopedStores: vi.fn(async () => ({ stores: [{ id: 's1' }, { id: 's2' }], coversWholeOrg: false })) }));

import { landingForActor, landingForToken, STAFF_HOME } from '../src/app/sign-in/landing';

const actor = (personId: string) => ({ personId, orgId: 'org' });

describe('sign-in landing', () => {
  beforeEach(() => H.allowed.clear());

  it('manager (holds submit_sales_day) -> /sales-days', async () => {
    H.allowed.add('mgr');
    expect(await landingForActor(actor('mgr'), '')).toBe('/sales-days');
  });
  it('staff without the grant -> staff home, not /sales-days', async () => {
    expect(await landingForActor(actor('staff'), '')).toBe(STAFF_HOME);
    expect(STAFF_HOME).not.toBe('/sales-days');
  });
  it('staff WITH a position grant -> /sales-days (token path used by the actions)', async () => {
    H.allowed.add('granted');
    expect(await landingForToken('granted', '')).toBe('/sales-days');
  });
  it('explicit safe next wins for everyone', async () => {
    expect(await landingForActor(actor('staff'), '/expenses?month=2026-09')).toBe('/expenses?month=2026-09');
    expect(await landingForActor(actor('staff'), '/')).toBe('/');
    H.allowed.add('mgr');
    expect(await landingForToken('mgr', '/inventory')).toBe('/inventory');
  });
  it('open-redirect shapes never win; they fall to the role landing', async () => {
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com', 'javascript:alert(1)']) {
      expect(await landingForActor(actor('staff'), bad)).toBe(STAFF_HOME);
    }
  });
  it('an explicit /sales-days is honoured as an explicit request', async () => {
    expect(await landingForActor(actor('staff'), '/sales-days')).toBe('/sales-days');
  });
});
