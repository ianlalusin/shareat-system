import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { grantsConfer, type Actor, type Capability } from '@shareat/auth';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { M, plain, session, sql, world, type World } from './t435-fixture';
import { capabilitiesForRoute } from '../../src/lib/route-capability';

/**
 * T-617 (Ian, 22 Nov 2026, "approve the defaults") - the 13 routes that awaited a decision are gated by EXISTING capability words.
 * Spec: docs/tasks/617-gate-the-13-awaiting-routes.md.
 *
 * For each route: a holder of EACH word on its own is let in, a person with no grant is refused (the access-refused card), an admin is let in
 * (/franchise is the super admin's; /items/import the admin's own word). /attendance/leave is open: a staff member sees their OWN leave and none of the
 * store-wide half; a manager sees both. /opening-balances refuses staff (managers hold run_cutover - see the report: Ian's "admins only" needs a word that does not exist).
 *
 * Mutants: M1 delete one route's map entry (that route's "refused" case goes red); M2 swap one page back to bare requireSession (the page-level case goes red);
 * M3 give /attendance/leave a word (the own-leave case goes red).
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ROUTES = [
  '/attendance',
  '/channel-settlements',
  '/channel-settlements/record',
  '/commissary/catalogue',
  '/commissary/discrepancies',
  '/commissary/orders',
  '/items',
  '/items/import',
  '/opening-balances',
  '/statutory-discounts',
  '/trade/orders',
  '/franchise',
] as const;

async function gate(route: string, actor: Actor): Promise<string | null> {
  const { requirePageAccess } = await import('../../src/lib/page-access');
  session.actor = actor;
  const { refusal } = await requirePageAccess(route);
  return refusal === null ? null : plain(renderToStaticMarkup(refusal as never));
}

async function staffHolding(w: World, capability: Capability): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, ${`T617 only ${capability}`}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.s1})`;
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
    values (${w.orgId}, ${w.s1}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2025-01-01', ${w.A.personId}) returning id`;
  await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId: w.s1, employmentId: e!.id, personId: p!.id, setBy: w.A.personId, capabilities: [capability] });
  return { personId: p!.id, orgId: w.orgId };
}

async function superAdmin(w: World): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'T617 super admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'super_admin')`;
  return { personId: p!.id, orgId: w.orgId };
}

describe('T-617 - each of the 12 gated routes: holder in, no-grant refused, admin in', () => {
  for (const route of ROUTES) {
    it(`${route}: a holder of each word on its own is let in; a person with no grant is refused; an admin (or the super admin) is let in`, async () => {
      const w = await world();
      const words = capabilitiesForRoute(route);
      expect(words.length, `${route} is mapped`).toBeGreaterThan(0);

      const refused = await gate(route, w.C);
      expect(refused, `${route} for a person with no grant`).toContain(M.refusedCard);
      expect(refused).not.toContain('This page has no access rule yet.');

      // Role-only / super-admin-only words cannot be conferred by a grant; the role cases below cover them.
      for (const word of words.filter((x) => grantsConfer(x))) {
        expect(await gate(route, await staffHolding(w, word)), `${route} for a holder of only ${word}`).toBeNull();
      }

      const who = route === '/franchise' ? await superAdmin(w) : w.A;
      expect(await gate(route, who), `${route} for ${route === '/franchise' ? 'the super admin' : 'an admin'}`).toBeNull();
    });
  }

  it('/items/import and /franchise: a manager is refused (admin / super admin only); /opening-balances lets a manager in (run_cutover is a manager word) and refuses staff', async () => {
    const w = await world();
    expect(await gate('/items/import', w.M1)).toContain(M.refusedCard);
    expect(await gate('/franchise', w.M1)).toContain(M.refusedCard);
    expect(await gate('/franchise', w.A)).toContain(M.refusedCard);
    expect(await gate('/opening-balances', w.M1)).toBeNull();
    expect(await gate('/opening-balances', w.C)).toContain(M.refusedCard);
  });

  it('a manager is let in to the manager screens', async () => {
    const w = await world();
    for (const route of ['/attendance', '/channel-settlements', '/commissary/catalogue', '/commissary/discrepancies', '/commissary/orders', '/items', '/statutory-discounts', '/trade/orders']) {
      expect(await gate(route, w.M1), `${route} for a manager`).toBeNull();
    }
  });

  it('a cashier by position keeps the screens it acts on (SC/PWD register, branch orders, catalogue, discrepancies) and loses the ones it never acted on', async () => {
    const w = await world();
    const { CANONICAL_POSITION_DEFAULTS } = await import('../../../../packages/domain/src/people/position-defaults');
    const cashierWords = CANONICAL_POSITION_DEFAULTS.Cashier;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'T617 position cashier') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.s1})`;
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
      values (${w.orgId}, ${w.s1}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2025-01-01', ${w.A.personId}) returning id`;
    await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId: w.s1, employmentId: e!.id, personId: p!.id, setBy: w.A.personId, capabilities: cashierWords });
    const cashier: Actor = { personId: p!.id, orgId: w.orgId };
    for (const route of ['/statutory-discounts', '/commissary/orders', '/commissary/catalogue', '/commissary/discrepancies', '/attendance/leave']) {
      expect(await gate(route, cashier), `${route} for the Cashier position`).toBeNull();
    }
    for (const route of ['/attendance', '/channel-settlements', '/items', '/items/import', '/opening-balances', '/trade/orders', '/franchise']) {
      expect(await gate(route, cashier), `${route} for the Cashier position`).toContain(M.refusedCard);
    }
  });
});

describe('T-617 - /attendance/leave is open: own leave for everyone, the store-wide half only for manage_attendance', () => {
  const leave = () => import('../../src/app/attendance/leave/page');
  async function renderLeave(actor: Actor): Promise<string> {
    session.actor = actor;
    const mod = await leave();
    const el = await mod.default({ searchParams: Promise.resolve({}) } as never);
    return plain(renderToStaticMarkup(el as never));
  }

  it('the route is open to a person with no grant (no refusal card)', async () => {
    const w = await world();
    expect(await gate('/attendance/leave', w.C)).toBeNull();
  });

  it('a staff member with no word sees their own leave and not the "Decide leave" half; a manager sees both', async () => {
    const w = await world();
    const staff = await renderLeave(w.C);
    expect(staff).toContain('My leave');
    expect(staff).not.toContain('Decide leave');
    expect(staff).not.toContain(M.refusedCard);
    const manager = await renderLeave(w.M1);
    expect(manager).toContain('My leave');
    expect(manager).toContain('Decide leave');
  });
});
