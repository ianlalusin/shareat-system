import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S2 (DEF-198) — view an attached photo. `docs/tasks/369-unwired-money-screens.md` §S2, T1–T5,
 * plus the *View photo* link on the supplier-invoice page (the BUILDER bullet that makes the route
 * reachable at all).
 *
 * ⛔ TESTER, not BUILDER. The route handler is `GET(request, { params: Promise<{ fileId }> })` in
 * `apps/erp/src/app/files/[fileId]/route.ts` — the standard App Router shape. REAL `readFileUrl`,
 * REAL authorize, REAL Postgres; only the session is doubled. The in-memory storage driver is
 * installed exactly as `packages/domain/tests/integration/files.test.ts` does (`setStorageDriver`).
 *
 * Every refusal has a positive control (T1). The three non-success cases (uploaded by another org /
 * nonexistent / not yours) must be BYTE-FOR-BYTE the same response, so a probe learns nothing about
 * which of them it hit (T-364 Q1 (a): no existence leak).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('next/navigation', () => ({
  // T-448 A3: FormModal/Dialog read the address.
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called — the route must return its own uniform 404, not the framework page');
  },
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/components/money/MoneyLines', async () => await import('../../src/components/money/MoneyLines'));
// AUDIT C: the route's `readFileUrl` can be swapped for a stub that throws a DIFFERENT refusal. Defaults to the real
// function, so every other test in this file is unaffected.
const READ_FILE_URL_STUB: { fn: ((...args: unknown[]) => Promise<unknown>) | null } = { fn: null };
// The same swap for `canReadFile`, which the screens call before drawing the link (a presentation aid must never take
// the page down - the orchestrator's S2 fault leg).
const CAN_READ_FILE_STUB: { fn: ((...args: unknown[]) => Promise<unknown>) | null } = { fn: null };
vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return {
    ...actual,
    canReadFile: (...args: Parameters<typeof actual.canReadFile>) =>
      CAN_READ_FILE_STUB.fn ? CAN_READ_FILE_STUB.fn(...args) : actual.canReadFile(...args),
    readFileUrl: (...args: Parameters<typeof actual.readFileUrl>) =>
      READ_FILE_URL_STUB.fn ? READ_FILE_URL_STUB.fn(...args) : actual.readFileUrl(...args),
  };
});

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, inMemoryDriver, recordInvoice, setStorageDriver, type StorageDriver } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UNIFORM = "This photo isn't available to you.";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** One org: Lipa and Malvar; manager (Lipa), otherManager (Malvar only), staff (Lipa, NO position
 * grant — so no `record_supplier_invoice`); one receipt_photo at Lipa whose bytes are in the driver. */
async function fixture(hint: string) {
  const code = uid(`t369s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [lipa] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Lipa') returning id`;
  const [malvar] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}m`)}, 'Malvar') returning id`;
  const storeId = lipa!.id;
  const malvarId = malvar!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager', [storeId]);
  const otherManagerId = await mk('Malvar Manager', 'manager', [malvarId]);
  const staffId = await mk('Staff', 'staff', [storeId]);

  const fileId = await receipt(orgId, storeId, managerId);
  return { orgId, storeId, malvarId, managerId, staffId, fileId, manager: actor(orgId, managerId), otherManager: actor(orgId, otherManagerId), staff: actor(orgId, staffId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A stored_files row whose bytes really are in the driver, so `signedUrl` succeeds. */
async function receipt(orgId: string, storeId: string, by: string): Promise<string> {
  const path = `orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('r')}.jpg`;
  await driver.put({ path, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' } as never);
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${path}, 'image/jpeg', 3, ${uid('sum')}, ${by}) returning id`;
  return row!.id;
}
const pathOf = async (fileId: string) => (await sql<{ storage_path: string }[]>`select storage_path from stored_files where id = ${fileId}`)[0]!.storage_path;

async function loadRoute() {
  try {
    return await import('../../src/app/files/[fileId]/route');
  } catch (err) {
    throw new Error(`apps/erp/src/app/files/[fileId]/route.ts does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
async function get(who: Actor | null, fileId: string): Promise<Response> {
  ACTOR_HOLDER.actor = who;
  const { GET } = await loadRoute();
  return GET(new Request(`http://localhost/files/${fileId}`), { params: Promise.resolve({ fileId }) } as never);
}
const body = async (r: Response) => await r.clone().text();

// -----------------------------------------------------------------------------------------------

describe('T1 — a manager at the receipt\'s store is sent to a signed URL (positive control)', () => {
  it('302; Location starts memory://orgs/{org}/stores/{store}/receipt_photo/; Cache-Control contains no-store (and private)', async () => {
    const f = await fixture('t1');
    const res = await get(f.manager, f.fileId);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(`memory://orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/`), `Location was: ${location}`).toBe(true);
    const cache = res.headers.get('cache-control') ?? '';
    expect(cache).toMatch(/no-store/);
    expect(cache).toMatch(/private/);
  });
});

describe('T2 (✗) — a staff member without record_supplier_invoice gets the uniform 404', () => {
  it('404 with the uniform sentence, no Location, and neither the fileId nor the storage path in the body', async () => {
    const f = await fixture('t2');
    const res = await get(f.staff, f.fileId);
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    const text = await body(res);
    expect(text).toContain(UNIFORM);
    expect(text, 'the body must not carry the file id').not.toContain(f.fileId);
    expect(text).not.toContain(await pathOf(f.fileId));
    expect(text).not.toMatch(UUID);
    // Positive control in the same leg: the manager is sent on (T1), so the 404 was the capability.
    expect((await get(f.manager, f.fileId)).status).toBe(302);
  });
});

describe('T3 — another org\'s file, a random uuid and a non-uuid are the same 404, byte for byte', () => {
  it('bodies and status codes are identical to T2\'s refusal (no existence leak); a non-uuid never reaches the database', async () => {
    const f = await fixture('t3');
    const other = await fixture('t3-other');
    const refusal = await get(f.staff, f.fileId); // T2's shape
    const reference = await body(refusal);
    expect(refusal.status).toBe(404);

    const probes: [string, string][] = [
      ["another org's file id", other.fileId],
      ['a random uuid', crypto.randomUUID()],
      ['a non-uuid', 'not-a-uuid'],
      ['a path-shaped id', '..%2F..%2Fetc'],
    ];
    for (const [label, id] of probes) {
      const res = await get(f.manager, id);
      expect(res.status, label).toBe(404);
      expect(res.headers.get('location'), label).toBeNull();
      expect(await body(res), `${label}: body differs from the uniform refusal`).toBe(reference);
    }
    // Positive control: the manager's own file is still served.
    expect((await get(f.manager, f.fileId)).status).toBe(302);
  });
});

describe('T4 — a manager at ANOTHER store gets the same 404', () => {
  it('the Malvar-only manager is refused Lipa\'s receipt; the Lipa manager is not', async () => {
    const f = await fixture('t4');
    const res = await get(f.otherManager, f.fileId);
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
    expect(await body(res)).toContain(UNIFORM);
    expect((await get(f.manager, f.fileId)).status, 'control').toBe(302);
  });
});

describe('T5 — an internal fault is a 500, never a 404, and leaks nothing', () => {
  const writes: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  beforeEach(() => {
    writes.length = 0;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (writes.push(String(chunk)), (realOut as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (writes.push(String(chunk)), (realErr as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  });

  it('a driver whose signedUrl throws -> 500 with a body that carries no path and no id; the failure is not logged WITH the url, path or file id', async () => {
    const f = await fixture('t5');
    const real = driver;
    const broken: StorageDriver = { ...real, signedUrl: async () => { throw new Error('storage: bucket unreachable'); } };
    setStorageDriver(broken);

    const res = await get(f.manager, f.fileId);
    expect(res.status, 'an internal fault must not masquerade as "not available to you"').toBe(500);
    expect(res.headers.get('location')).toBeNull();
    const text = await body(res);
    expect(text).not.toContain(UNIFORM);
    const path = await pathOf(f.fileId);
    for (const secret of [f.fileId, path, 'orgs/', 'memory://']) expect(text, `body leaked ${secret}`).not.toContain(secret);
    for (const secret of [f.fileId, path, 'memory://']) {
      expect(writes.filter((w) => w.includes(secret)), `something was logged containing ${secret}`).toEqual([]);
    }

    // Positive control: with the working driver restored, the same request is served.
    setStorageDriver(real);
    expect((await get(f.manager, f.fileId)).status).toBe(302);
  });
});

// -----------------------------------------------------------------------------------------------
// The link — a route nobody can reach is DEF-198 again
// -----------------------------------------------------------------------------------------------

describe('photo thumbnail — the supplier-invoice page shows the attached photo', () => {
  let InvoiceDetailPage: typeof import('../../src/app/ap/invoices/[id]/page').default;
  beforeAll(async () => {
    InvoiceDetailPage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  }, 30_000);

  it('an invoice with a receipt shows a photo thumbnail (img src /files/{id}); an invoice with no receipt shows none', async () => {
    const f = await fixture('link');
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Link Supplier', creditTermsDays: 30 }));
    const withPhoto = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: supplier.id, invoiceNo: 'INV-PHOTO', invoiceDate: '2026-01-10', totalAmount: '500.00', receiptFileId: f.fileId }),
    );
    const without = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: supplier.id, invoiceNo: 'INV-NOPHOTO', invoiceDate: '2026-01-11', totalAmount: '200.00' }),
    ).catch(() => null);

    ACTOR_HOLDER.actor = f.manager;
    const html = renderToStaticMarkup(
      (await InvoiceDetailPage({ params: Promise.resolve({ id: withPhoto.id }), searchParams: Promise.resolve({}) })) as never,
    );
    expectPhotoThumbnail(html, f.fileId, await pathOf(f.fileId));

    // Positive control: where the domain refuses a photo-less invoice, this leg has nothing to compare;
    // where it allows one, the page must carry no photo link.
    if (without) {
      const plain = renderToStaticMarkup(
        (await InvoiceDetailPage({ params: Promise.resolve({ id: without.id }), searchParams: Promise.resolve({}) })) as never,
      );
      expect(plain).not.toMatch(/\/files\//);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// View photo — the two other pages the spec names (deliveries/[id], customers/[customerId])
// -----------------------------------------------------------------------------------------------

/** The assertions every photo thumbnail must satisfy, identical across the three pages (PhotoThumb, T-441 S6). */
function expectPhotoThumbnail(html: string, fileId: string, storagePath: string) {
  expect(html, `no photo thumbnail (<img src="/files/${fileId}">) in: ${html.slice(0, 600)}`).toContain(`src="/files/${fileId}"`);
  expect(html).toMatch(/aria-label="[^"]*: open full size"/);
  expect(html, 'the page must never embed the signed URL or the storage path').not.toMatch(/memory:\/\//);
  expect(html).not.toContain(storagePath);
}

describe('photo thumbnail — /inventory/deliveries/[id] shows the delivery proof', () => {
  let DeliveryPage: typeof import('../../src/app/inventory/deliveries/[id]/page').default;
  beforeAll(async () => {
    DeliveryPage = (await import('../../src/app/inventory/deliveries/[id]/page')).default;
  }, 30_000);

  it('a delivery with proofFileId shows a photo thumbnail (img src /files/{proofFileId}); the page embeds no signed URL', async () => {
    const f = await fixture('dlv');
    const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
    const [kitchen] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${f.orgId}, ${f.storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${f.managerId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${f.managerId}) returning id`;
    const { createDeliveryDocument } = await import('../../../../packages/domain/src/deliveries/documents');
    const { deliveryId } = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.manager, {
        storeId: f.storeId, kind: 'purchase', supplierId: null, referenceNo: 'DR-S2', deliveredOn: '2026-01-10', proofFileId: f.fileId,
        lines: [{ itemId: item!.id, orderedQuantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '300.0000', locationId: kitchen!.id }],
      }),
    );

    ACTOR_HOLDER.actor = f.manager;
    const html = renderToStaticMarkup((await DeliveryPage({ params: Promise.resolve({ id: deliveryId }), searchParams: Promise.resolve({}) })) as never);
    expectPhotoThumbnail(html, f.fileId, await pathOf(f.fileId));
  });
});

describe('photo thumbnail — /customers/[customerId] shows a collection\'s receipt', () => {
  let CustomerPage: typeof import('../../src/app/customers/[customerId]/page').default;
  beforeAll(async () => {
    CustomerPage = (await import('../../src/app/customers/[customerId]/page')).default;
  }, 30_000);

  it('a collection with receiptFileId shows a photo thumbnail (img src /files/{receiptFileId}); a collection without one adds none', async () => {
    const f = await fixture('cust');
    const { createCustomer, recordCharge, recordCollection } = await import('@shareat/domain');
    const [cash] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
    // createCustomer/recordCharge need manage_chart_of_accounts (admin); the PAGE is rendered as the manager.
    const [adminRow] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${adminRow!.id}, ${f.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${adminRow!.id}, ${f.storeId})`;
    const admin = actor(f.orgId, adminRow!.id);
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, admin, { name: 'Resto S2' }));
    const charge = await asOrg(f.orgId, (tx) =>
      recordCharge(tx, admin, { storeId: f.storeId, customerId: customer.id, chargeDate: '2026-01-10', dueDate: null, totalAmount: '1000.00', revenueAccountCode: '4150' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, admin, {
        storeId: f.storeId, customerId: customer.id, collectionDate: '2026-01-15', amount: '400.00', moneyAccountId: cash!.id,
        receiptFileId: f.fileId, allocations: [{ chargeId: charge.chargeId, amountApplied: '400.00' }],
      }),
    );

    ACTOR_HOLDER.actor = f.manager;
    const render = async () =>
      renderToStaticMarkup(
        (await CustomerPage({ params: Promise.resolve({ customerId: customer.id }), searchParams: Promise.resolve({ store: f.storeId }) } as never)) as never,
      );
    const withReceipt = await render();
    expectPhotoThumbnail(withReceipt, f.fileId, await pathOf(f.fileId));

    // Positive control: a collection recorded WITHOUT a receipt adds no second photo link.
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, admin, {
        storeId: f.storeId, customerId: customer.id, collectionDate: '2026-01-16', amount: '100.00', moneyAccountId: cash!.id,
        receiptFileId: null, allocations: [{ chargeId: charge.chargeId, amountApplied: '100.00' }],
      }),
    );
    const html = await render();
    expect((html.match(/src="\/files\//g) ?? []).length, 'exactly one photo thumbnail for the one collection that has a receipt').toBe(1);
  });
});

// -----------------------------------------------------------------------------------------------
// S2 AUDIT legs (A, B, C) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

describe('AUDIT A — the photo thumbnail is shown ONLY to people who hold the file\'s purpose capability at its store', () => {
  let InvoicePage: typeof import('../../src/app/ap/invoices/[id]/page').default;
  let DeliveryPage: typeof import('../../src/app/inventory/deliveries/[id]/page').default;
  let CustomerPage: typeof import('../../src/app/customers/[customerId]/page').default;
  beforeAll(async () => {
    InvoicePage = (await import('../../src/app/ap/invoices/[id]/page')).default;
    DeliveryPage = (await import('../../src/app/inventory/deliveries/[id]/page')).default;
    CustomerPage = (await import('../../src/app/customers/[customerId]/page')).default;
  }, 30_000);
  const links = (html: string) => (html.match(/src="\/files\//g) ?? []).length;

  it('invoice page: a staff member WITHOUT record_supplier_invoice sees NO photo thumbnail (a thumbnail of a file they cannot open is a dead control); the manager sees exactly one', async () => {
    const f = await fixture('auditA-inv');
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Link Supplier', creditTermsDays: 30 }));
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: supplier.id, invoiceNo: 'INV-A', invoiceDate: '2026-01-10', totalAmount: '500.00', receiptFileId: f.fileId }),
    );
    const render = async (who: Actor) => {
      ACTOR_HOLDER.actor = who;
      return renderToStaticMarkup((await InvoicePage({ params: Promise.resolve({ id: inv.id }), searchParams: Promise.resolve({}) })) as never);
    };
    expect(links(await render(f.manager)), 'positive control: the holder sees the link').toBe(1);
    expect(links(await render(f.staff)), 'a viewer without the capability was handed a /files/ link').toBe(0);
    expect(links(await render(f.otherManager)), "a manager of ANOTHER store was handed a /files/ link").toBe(0);
  });

  it('delivery page: the proof photo thumbnail shows for the holder and NOT for staff or another store\'s manager', async () => {
    const f = await fixture('auditA-dlv');
    const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
    const [kitchen] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${f.orgId}, ${f.storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${f.managerId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${f.managerId}) returning id`;
    const { createDeliveryDocument } = await import('../../../../packages/domain/src/deliveries/documents');
    const { deliveryId } = await asOrg(f.orgId, (tx) =>
      createDeliveryDocument(tx, f.manager, {
        storeId: f.storeId, kind: 'purchase', supplierId: null, referenceNo: 'DR-A', deliveredOn: '2026-01-10', proofFileId: f.fileId,
        lines: [{ itemId: item!.id, orderedQuantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitCost: '300.0000', locationId: kitchen!.id }],
      }),
    );
    const render = async (who: Actor) => {
      ACTOR_HOLDER.actor = who;
      return renderToStaticMarkup((await DeliveryPage({ params: Promise.resolve({ id: deliveryId }), searchParams: Promise.resolve({}) })) as never);
    };
    expect(links(await render(f.manager)), 'positive control: the holder sees the link').toBe(1);
    expect(links(await render(f.staff)), 'staff without the capability was handed a /files/ link').toBe(0);
    expect(links(await render(f.otherManager)), "another store's manager was handed a /files/ link").toBe(0);
  });

  it("customer page: a collection receipt's thumbnail shows for the holder of record_ar_collection and NOT for staff without it", async () => {
    const f = await fixture('auditA-cust');
    const { createCustomer, recordCharge, recordCollection } = await import('@shareat/domain');
    const [cash] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
    const [adminRow] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${adminRow!.id}, ${f.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${adminRow!.id}, ${f.storeId})`;
    const admin = actor(f.orgId, adminRow!.id);
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, admin, { name: 'Resto A' }));
    const charge = await asOrg(f.orgId, (tx) =>
      recordCharge(tx, admin, { storeId: f.storeId, customerId: customer.id, chargeDate: '2026-01-10', dueDate: null, totalAmount: '1000.00', revenueAccountCode: '4150' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, admin, {
        storeId: f.storeId, customerId: customer.id, collectionDate: '2026-01-15', amount: '400.00', moneyAccountId: cash!.id,
        receiptFileId: f.fileId, allocations: [{ chargeId: charge.chargeId, amountApplied: '400.00' }],
      }),
    );
    const render = async (who: Actor) => {
      ACTOR_HOLDER.actor = who;
      return renderToStaticMarkup(
        (await CustomerPage({ params: Promise.resolve({ customerId: customer.id }), searchParams: Promise.resolve({ store: f.storeId }) } as never)) as never,
      );
    };
    expect(links(await render(f.manager)), 'positive control: the holder sees the link').toBe(1);
    expect(links(await render(f.staff)), 'staff without the capability was handed a /files/ link').toBe(0);
  });
});

describe('AUDIT B — the signed URL lives about five minutes', () => {
  it('the 302 Location carries expires ≈ now + 300 seconds (±10 s)', async () => {
    const f = await fixture('auditB-ttl');
    const before = Date.now();
    const res = await get(f.manager, f.fileId);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    const expires = Number(new URL(location.replace('memory://', 'http://memory/')).searchParams.get('expires'));
    expect(Number.isFinite(expires), `no expires in ${location}`).toBe(true);
    expect(Math.abs(expires - (before + 300_000)), `the TTL is ${Math.round((expires - before) / 1000)}s, not ~300s`).toBeLessThanOrEqual(10_000);
  });
});

describe('AUDIT C — only a "missing file / not yours" outcome becomes the uniform 404', () => {
  afterEach(() => {
    READ_FILE_URL_STUB.fn = null;
  });

  it('readFileUrl throwing a DIFFERENT RefusalError -> NOT the uniform "isn\'t available to you" 404 (a 500, or that refusal\'s own sentence); the body carries no id — control: the real function is still 302/404 as before', async () => {
    const f = await fixture('auditC');
    const { refuse } = await import('@shareat/domain');
    READ_FILE_URL_STUB.fn = async () => {
      throw refuse('readFileUrl: the storage account is suspended (raw)', 'Photos are unavailable right now. Try again in a few minutes.');
    };
    const res = await get(f.manager, f.fileId);
    const text = await body(res);
    expect(text, 'an unrelated refusal was disguised as "not available to you"').not.toContain(UNIFORM);
    expect(res.status, 'an unrelated refusal must not be a 404').not.toBe(404);
    expect(res.headers.get('location')).toBeNull();
    expect(text).not.toContain(f.fileId);

    READ_FILE_URL_STUB.fn = null;
    expect((await get(f.manager, f.fileId)).status, 'control: the real function serves the manager again').toBe(302);
  });
});

describe('AUDIT D — a fault while deciding whether to draw the thumbnail never takes the bill page down', () => {
  let InvoicePage: typeof import('../../src/app/ap/invoices/[id]/page').default;
  beforeAll(async () => {
    InvoicePage = (await import('../../src/app/ap/invoices/[id]/page')).default;
  }, 30_000);
  afterEach(() => {
    CAN_READ_FILE_STUB.fn = null;
  });

  it('canReadFile throwing an unexpected error (an unmapped purpose, a driver fault): the invoice page still renders its evidence panel, WITHOUT a photo thumbnail — control: the unstubbed page draws exactly one', async () => {
    const f = await fixture('auditD-fault');
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Fault Supplier', creditTermsDays: 30 }));
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: supplier.id, invoiceNo: 'INV-D', invoiceDate: '2026-01-10', totalAmount: '500.00', receiptFileId: f.fileId }),
    );
    const render = async () => {
      ACTOR_HOLDER.actor = f.manager;
      return renderToStaticMarkup((await InvoicePage({ params: Promise.resolve({ id: inv.id }), searchParams: Promise.resolve({}) })) as never);
    };
    const links = (h: string) => (h.match(/src="\/files\//g) ?? []).length;
    expect(links(await render()), 'positive control: the holder sees the link').toBe(1);

    CAN_READ_FILE_STUB.fn = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'capability')");
    };
    let html = '';
    try {
      html = await render();
    } catch (err) {
      throw new Error(`the bill page threw because the link check faulted: ${String((err as Error).message).slice(0, 160)}`);
    }
    expect(html, 'the page still renders its evidence panel').toMatch(/photo attached/);
    expect(links(html), 'a faulted link check still drew a link').toBe(0);
    expect(html).not.toMatch(/Cannot read properties/);
  });

  it('a receipt whose file row is gone/foreign (canReadFile false): the page renders, "photo attached" stays, and no thumbnail is drawn', async () => {
    const f = await fixture('auditD-gone');
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Gone Supplier', creditTermsDays: 30 }));
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, { storeId: f.storeId, supplierId: supplier.id, invoiceNo: 'INV-G', invoiceDate: '2026-01-10', totalAmount: '500.00', receiptFileId: f.fileId }),
    );
    CAN_READ_FILE_STUB.fn = async () => false;
    ACTOR_HOLDER.actor = f.manager;
    const html = renderToStaticMarkup((await InvoicePage({ params: Promise.resolve({ id: inv.id }), searchParams: Promise.resolve({}) })) as never);
    expect(html).toMatch(/photo attached/);
    expect(html).not.toMatch(/src="\/files\//);
  });
});
