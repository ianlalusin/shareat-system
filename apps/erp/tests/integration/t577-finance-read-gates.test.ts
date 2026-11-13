import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Actor, Capability } from '@shareat/auth';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { M, expectAbsent, expectPresent, expectRefusalCard, pageError, plain, render, session, sql, uid, world, type World } from './t435-fixture';
import { ROUTE_CAPABILITY, capabilitiesForRoute } from '../../src/lib/route-capability';

/**
 * T-577 (DEF-834, Ian 13 Nov, bible row 461) - the finance screens are read-gated by capability and by store.
 * Spec: docs/tasks/577-erp-finance-read-gates.md.
 *
 *  - /ap (+ every child), /budgets, /cash-requests (+ [id]) need a capability from the map. For each route: a signed-in person without one
 *    is refused (the access-refused card, nothing of the page), and a holder of EACH listed capability on its own is let in.
 *  - expenses/[id], sales-days/[id], wastage/[id] load the record and then ask `can(..., { storeId: record.storeId })`; a record outside the
 *    viewer's stores is the SAME not-found as a forged id, never a "forbidden".
 *
 * Fixture: the shared T-435 world (S1, S2; A admin of both, M1 manager S1, M2 manager S2, C staff with no grant, V1 staff holding only
 * view_financial_reports). Everything below adds one record per store so a viewer's own record and the other store's can be told apart.
 *
 * Mutants: M1 delete a route from the map; M2 swap one child page back to requireSession; M3 drop the store check from a single-record page;
 * M4 check the store of the VIEWER instead of the record.
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

const NOT_FOUND = 'NEXT_NOT_FOUND';
const FORGED = '019a0000-0000-7000-8000-000000000001';

interface Records {
  supplierId: string;
  invoiceS1: string;
  expenseS1: string;
  expenseS2: string;
  dayS1: string;
  dayS2: string;
  wastageS1: string;
  wastageS2: string;
  cashRequestS1: string;
  /** staff holding exactly ONE capability at S1, by capability */
  only: Map<string, Actor>;
}

const EX = { s1: 'Zinnia fixture spend', s2: 'Yarrow fixture spend' } as const;
const WA = { s1: 'Quince wastage reason', s2: 'Rhubarb wastage reason' } as const;

let cached: Promise<Records> | null = null;
const records = (): Promise<Records> => (cached ??= build());

async function build(): Promise<Records> {
  const w = await world();
  const { orgId, s1, s2 } = w;
  const adminId = w.A.personId;

  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${adminId}) returning id`;
  const invoice = async (storeId: string) => {
    const [i] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
        attested_supplier, attested_invoice, attested_items, attested_price, created_by)
      values (${orgId}, ${storeId}, ${supplier!.id}, '2026-01-10', '500.00', 'verified', ${w.M1.personId}, now(), true, true, true, true, ${adminId})
      returning id`;
    return i!.id;
  };
  const invoiceS1 = await invoice(s1);
  const invoiceS2 = await invoice(s2);
  const [cat] = await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('cat')}, null) returning id`;
  const expense = async (storeId: string, invoiceId: string, particulars: string) => {
    const [e] = await sql<{ id: string }[]>`
      insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
      values (${orgId}, ${storeId}, '2026-01-10', '500.00', ${cat!.id}, ${supplier!.id}, ${invoiceId}, ${particulars}, 'draft', ${adminId}) returning id`;
    return e!.id;
  };
  const expenseS1 = await expense(s1, invoiceS1, EX.s1);
  const expenseS2 = await expense(s2, invoiceS2, EX.s2);

  const day = async (storeId: string, date: string) => {
    const [d] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${orgId}, ${storeId}, ${date}, '1000', '600', '400', ${adminId}) returning id`;
    return d!.id;
  };
  const dayS1 = await day(s1, '2026-01-11');
  const dayS2 = await day(s2, '2026-01-12');

  const wastage = async (storeId: string, dayId: string, reason: string) => {
    const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, ${uid('Chan')}, true) returning id`;
    const [x] = await sql<{ id: string }[]>`
      insert into order_wastages (org_id, store_id, sales_day_id, channel_id, channel, type_mode, amount, reason, created_by)
      values (${orgId}, ${storeId}, ${dayId}, ${ch!.id}, 'Foodpanda', 'instant', '50.00', ${reason}, ${adminId}) returning id`;
    return x!.id;
  };
  const wastageS1 = await wastage(s1, dayS1, WA.s1);
  const wastageS2 = await wastage(s2, dayS2, WA.s2);

  const [cr] = await sql<{ id: string }[]>`
    insert into cash_requests (org_id, store_id, requested_for, purpose, requested_amount, requested_on, created_by)
    values (${orgId}, ${s1}, ${adminId}, 'Synthetic float', '100.00', '2026-01-10', ${adminId}) returning id`;

  // One staff person per capability the new gates list: holds that capability at S1 and nothing else the gates look at.
  const only = new Map<string, Actor>();
  const everyCapability = new Set<string>();
  for (const route of ['/ap', '/budgets', '/cash-requests']) for (const c of capabilitiesForRoute(route)) everyCapability.add(c);
  for (const cap of [...everyCapability, 'edit_own_expense', 'create_expense', 'approve_expense', 'record_order_wastage', 'resolve_order_wastage', 'submit_sales_day', 'verify_sales_day']) {
    only.set(cap, await staffHolding(w, cap as Capability));
  }

  return { supplierId: supplier!.id, invoiceS1, expenseS1, expenseS2, dayS1, dayS2, wastageS1, wastageS2, cashRequestS1: cr!.id, only };
}

async function staffHolding(w: World, capability: Capability): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, ${`Only ${capability}`}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.s1})`;
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
    values (${w.orgId}, ${w.s1}, ${p!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2025-01-01', ${w.A.personId}) returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId: w.orgId, storeId: w.s1, employmentId: e!.id, personId: p!.id, setBy: w.A.personId, capabilities: [capability],
  });
  return { personId: p!.id, orgId: w.orgId };
}

// ---------------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------------

const page = {
  ap: () => import('../../src/app/ap/page'),
  apSuppliers: () => import('../../src/app/ap/suppliers/page'),
  apSupplier: () => import('../../src/app/ap/suppliers/[id]/page'),
  apInvoice: () => import('../../src/app/ap/invoices/[id]/page'),
  apVat: () => import('../../src/app/ap/vat/page'),
  budgets: () => import('../../src/app/budgets/page'),
  cashRequests: () => import('../../src/app/cash-requests/page'),
  cashRequest: () => import('../../src/app/cash-requests/[id]/page'),
  expense: () => import('../../src/app/expenses/[id]/page'),
  salesDay: () => import('../../src/app/sales-days/[id]/page'),
  wastage: () => import('../../src/app/wastage/[id]/page'),
};

describe('T-577 - the route map names the three finance screens', () => {
  it('/ap, /budgets and /cash-requests (and every child) are mapped to a real capability list', () => {
    expect(ROUTE_CAPABILITY['/ap']).toEqual(['record_supplier_invoice', 'verify_supplier_invoice', 'record_ap_payment', 'approve_supplier']);
    expect(ROUTE_CAPABILITY['/budgets']).toBe('manage_expense_budgets');
    expect(ROUTE_CAPABILITY['/cash-requests']).toEqual(['create_expense', 'approve_expense']);
    for (const child of ['/ap/suppliers', '/ap/suppliers/x', '/ap/invoices/x', '/ap/vat']) expect(capabilitiesForRoute(child), child).toEqual(capabilitiesForRoute('/ap'));
    expect(capabilitiesForRoute('/cash-requests/x')).toEqual(capabilitiesForRoute('/cash-requests'));
  });
});

describe('T-577 - a signed-in person without the capability is refused on every route (M1, M2)', () => {
  const cases: { name: string; load: keyof typeof page; params?: (r: Records) => Record<string, string> }[] = [
    { name: '/ap', load: 'ap' },
    { name: '/ap/suppliers', load: 'apSuppliers' },
    { name: '/ap/suppliers/[id]', load: 'apSupplier', params: (r) => ({ id: r.supplierId }) },
    { name: '/ap/invoices/[id]', load: 'apInvoice', params: (r) => ({ id: r.invoiceS1 }) },
    { name: '/ap/vat', load: 'apVat' },
    { name: '/budgets', load: 'budgets' },
    { name: '/cash-requests', load: 'cashRequests' },
    { name: '/cash-requests/[id]', load: 'cashRequest', params: (r) => ({ id: r.cashRequestS1 }) },
  ];

  for (const c of cases) {
    it(`${c.name}: C (no grant) and V1 (only view_financial_reports) get the refusal card and none of the page; M1 (manager) is let in`, async () => {
      const w = await world();
      const r = await records();
      const props = { params: c.params?.(r) ?? {} };
      for (const [who, actor] of [['C', w.C], ['V1', w.V1]] as const) {
        const html = await render(page[c.load], actor, props);
        expectRefusalCard(html, `${who} ${c.name}`);
        expectAbsent(html, `${who} ${c.name}`, '<form');
      }
      // positive control: the same render, as a holder, is NOT the refusal card (proves the refusal above is the gate, not a broken fixture)
      const ok = await render(page[c.load], w.M1, props);
      expect(plain(ok), `M1 ${c.name}`).not.toContain(M.refusedCard);
      expect(ok.length, `M1 ${c.name}: a real page`).toBeGreaterThan(500);
    });
  }

  it('each capability on a route list opens it ON ITS OWN (the any-of is real), and an unrelated one does not', async () => {
    const r = await records();
    const w = await world();
    const open = async (route: string, actor: Actor) => {
      const { requirePageAccess } = await import('../../src/lib/page-access');
      session.actor = actor;
      return (await requirePageAccess(route)).refusal === null;
    };
    for (const route of ['/ap', '/ap/suppliers', '/ap/vat', '/budgets', '/cash-requests']) {
      const accepted = capabilitiesForRoute(route);
      expect(accepted.length, route).toBeGreaterThan(0);
      for (const cap of accepted) expect(await open(route, r.only.get(cap)!), `${route} for a holder of only ${cap}`).toBe(true);
      // the refusal fires for someone who holds none of them
      expect(await open(route, w.C), `${route} for C`).toBe(false);
      expect(await open(route, w.V1), `${route} for V1`).toBe(false);
    }
    // a capability from ANOTHER route's list does not open this one
    expect(await open('/budgets', r.only.get('record_ap_payment')!), '/budgets for a payer').toBe(false);
    expect(await open('/ap', r.only.get('manage_expense_budgets')!), '/ap for a budget manager').toBe(false);
    expect(await open('/cash-requests', r.only.get('verify_supplier_invoice')!), '/cash-requests for a verifier').toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The single-record pages
// ---------------------------------------------------------------------------------------------------------------------

describe('T-577 - single-record pages: a record outside the viewer\'s stores is a not-found (M3, M4)', () => {
  const kinds = [
    { name: 'expenses/[id]', load: 'expense' as const, s1: (r: Records) => r.expenseS1, s2: (r: Records) => r.expenseS2, mark1: EX.s1, mark2: EX.s2, caps: ['create_expense', 'edit_own_expense', 'approve_expense'] },
    { name: 'sales-days/[id]', load: 'salesDay' as const, s1: (r: Records) => r.dayS1, s2: (r: Records) => r.dayS2, mark1: '2026-01-11', mark2: '2026-01-12', caps: ['submit_sales_day', 'verify_sales_day'] },
    { name: 'wastage/[id]', load: 'wastage' as const, s1: (r: Records) => r.wastageS1, s2: (r: Records) => r.wastageS2, mark1: WA.s1, mark2: WA.s2, caps: ['record_order_wastage', 'resolve_order_wastage'] },
  ];

  for (const k of kinds) {
    it(`${k.name}: M1 sees the S1 record and gets not-found for the S2 record, the SAME not-found as a forged id`, async () => {
      const w = await world();
      const r = await records();
      const own = await render(page[k.load], w.M1, { params: { id: k.s1(r) } });
      expectPresent(own, `M1 ${k.name} S1`, k.mark1);
      const other = await pageError(() => render(page[k.load], w.M1, { params: { id: k.s2(r) } }));
      const forged = await pageError(() => render(page[k.load], w.M1, { params: { id: FORGED } }));
      expect(forged, 'a forged id is a not-found (positive control: the harness reports one)').toBe(NOT_FOUND);
      expect(other, `S2 record for M1 must be the very same not-found`).toBe(forged);
    });

    it(`${k.name}: M2 is the mirror image (sees S2, not S1)`, async () => {
      const w = await world();
      const r = await records();
      expectPresent(await render(page[k.load], w.M2, { params: { id: k.s2(r) } }), `M2 ${k.name} S2`, k.mark2);
      expect(await pageError(() => render(page[k.load], w.M2, { params: { id: k.s1(r) } })), `S1 record for M2`).toBe(NOT_FOUND);
    });

    it(`${k.name}: A (admin of both stores) sees both records`, async () => {
      const w = await world();
      const r = await records();
      expectPresent(await render(page[k.load], w.A, { params: { id: k.s1(r) } }), `A ${k.name} S1`, k.mark1);
      expectPresent(await render(page[k.load], w.A, { params: { id: k.s2(r) } }), `A ${k.name} S2`, k.mark2);
    });

    it(`${k.name}: C at the record's own store but holding none of its capabilities gets not-found (the refusal fires)`, async () => {
      const w = await world();
      const r = await records();
      expect(await pageError(() => render(page[k.load], w.C, { params: { id: k.s1(r) } })), `C ${k.name} S1`).toBe(NOT_FOUND);
    });

    for (const cap of k.caps) {
      it(`${k.name}: a holder of only ${cap} at S1 sees the S1 record and not the S2 record`, async () => {
        const r = await records();
        const who = r.only.get(cap)!;
        expectPresent(await render(page[k.load], who, { params: { id: k.s1(r) } }), `${cap} ${k.name} S1`, k.mark1);
        expect(await pageError(() => render(page[k.load], who, { params: { id: k.s2(r) } })), `${cap} ${k.name} S2`).toBe(NOT_FOUND);
      });
    }
  }
});
