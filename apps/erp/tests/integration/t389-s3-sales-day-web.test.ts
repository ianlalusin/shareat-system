import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - sales-days/[id]: the Platform sales form of a POS-feed day.
 * Census: sales-days/[id]/page.tsx, <EditableRecord action={setPlatformSalesAction} label="platform sales" hidden={{
 * storeId, salesDayId }}>, one box + one "no sales" tick per non-remitted channel (`channel_<id>`, `nosales_<id>`), shown
 * once the day already has a platform row (otherwise it is an add form: N1, out of scope). Refusal driven: a NEGATIVE
 * amount on one channel ("... can't be negative"), with another channel's "no sales" ticked.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id = the sales day's own hidden `salesDayId`.
 *  - allow-list = every `channel_<channelId>` and `nosales_<channelId>` name (a RegExp family). NOT storeId, salesDayId.
 *  - an unticked "no sales" that the client lists in __changed rides as an empty array.
 *
 * ⚠️ SPEC DEFECT (report, do not work around): R1/R2 allow a typed field name only as /^[A-Za-z][A-Za-z0-9_]{0,63}$/
 * (flash.ts TYPED_FIELD, keep-typing.ts FIELD_NAME), but the census says this form's controls are named `channel_<id>` and
 * `nosales_<id>` where <id> is the channel's UUID, which contains hyphens. As built, `keepTyping` skips every one of them
 * (`allowed()` returns false), so nothing is kept, and `decodeFlash` would drop a slot that carried one. The names the
 * test expects below are the real control names. Making them travel needs a MECHANISM change in S1-owned files
 * (flash.ts / keep-typing.ts, e.g. hyphens allowed in a name or the id encoded), which a sweep lane may not make: the
 * builder stops and reports to the orchestrator.
 *
 * Harness and legs: t389-s3-common.ts (the S1 supplier pattern). Fixture from packages/domain t375-s4-platform.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      if (p) seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { importTestDay, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { actor, asOrg, captureRedirect, closeAfterAll, keepTypingLegs, outcomeOf, person, sql, uid } from './t389-s3-common';

closeAfterAll();

async function setup(hint: string) {
  const code = uid(`t389s3sd-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const managerId = await person(orgId, 'Manager', 'manager', [storeId]);
  const staffId = await person(orgId, 'Staff', 'staff', [storeId]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });
  const mkChannel = async (name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkInId = await mkChannel('Walk-in', true, null);
  const foodpandaId = await mkChannel('Foodpanda', false, '1220');
  const grabId = await mkChannel('GrabFood', false, '1220');
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId, channelId: walkInId, createdBy: adminId });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });
  const { id: salesDayId } = await asOrg(orgId, (tx) => importTestDay(tx, actor(orgId, staffId), { storeId, businessDate: '2027-01-10' }));
  // The day already carries a Foodpanda platform row, so the page draws the platform form as a locked record.
  await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${salesDayId}, ${foodpandaId}, '500.00')`;
  return { orgId, storeId, salesDayId, foodpandaId, grabId, admin: actor(orgId, adminId), other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'sales-days platform sales',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.salesDayId,
  // The Foodpanda box is unique to this record's form (other forms on the page also carry salesDayId).
  marker: (c) => `name="channel_${c.foodpandaId}"`,
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = {
      storeId: c.storeId, salesDayId: c.salesDayId,
      [`channel_${c.foodpandaId}`]: '-777.77',
      [`channel_${c.grabId}`]: '',
      [`nosales_${c.grabId}`]: 'on',
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(_c, fd, who) {
    h.actor = who;
    const { setPlatformSalesAction } = await import('../../src/app/sales-days/actions');
    const signal = await captureRedirect(() => setPlatformSalesAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: /amount/i,
  expectedFields: (c) => ({
    [`channel_${c.foodpandaId}`]: '-777.77',
    [`channel_${c.grabId}`]: '',
    [`nosales_${c.grabId}`]: 'on',
  }),
  neverKept: () => ['salesDayId', 'storeId'],
  // Foodpanda's "no sales" box left UNticked and changed: it must reopen unticked, so it rides as an empty array.
  changedLeg: (c) => ({
    changed: `channel_${c.foodpandaId},nosales_${c.foodpandaId}`,
    fields: { [`channel_${c.foodpandaId}`]: '-777.77', [`nosales_${c.foodpandaId}`]: [] },
  }),
  async render(c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/sales-days/[id]/page');
    return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: c.salesDayId }), searchParams: Promise.resolve({ store: c.storeId, ...params }) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && r.label === 'platform sales' && (r.hidden as Record<string, string> | undefined)?.salesDayId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: () => ['value="500.00"'],
  typedNotDrawn: () => ['777.77'],
  tooLong: { name: (c) => `channel_${c.foodpandaId}` },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('storeId', c.storeId);
    fd.set('salesDayId', c.salesDayId);
    fd.set(`channel_${c.foodpandaId}`, '600.00');
    fd.set(`channel_${c.grabId}`, '');
    fd.set(`nosales_${c.grabId}`, 'on');
    return fd;
  },
  expectOk: true,
});
