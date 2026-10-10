import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - channel-settlements: a channel's payout account.
 * Census: channel-settlements/page.tsx, <EditableRecord action={setPayoutDestinationAction} hidden={{ channelId }}>, one
 * per wired channel. Refusal driven: the chosen account was RETIRED in the meantime (the spec's own example): the
 * domain says "<name> is retired, so nothing can be banked into it." and the browser cannot pre-empt it.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id = the channel's own hidden `channelId`.
 *  - allow-list = moneyAccountId (the one visible control; it is a select, so it is NOT a hidden id). NOT channelId.
 *  - a typed account that has no option on the page (retired) is simply not applied by the browser (R3); the server
 *    still keeps it in the slot, so the cookie carries the typed id.
 * Harness and legs: t389-s3-common.ts (the S1 supplier pattern).
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
import { actor, captureRedirect, closeAfterAll, keepTypingLegs, outcomeOf, person, resetJar, sql, uid } from './t389-s3-common';

closeAfterAll();

async function setup(hint: string) {
  const code = uid(`t389s3cs-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const mkAccount = async (label: string, isActive = true) =>
    (await sql<{ id: string; name: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${orgId}, ${storeId}, ${`${label} ${uid('m')}`}, 'bank', '1140', 'office', ${isActive}) returning id, name`)[0]!;
  const bankA = await mkAccount('Bank A');
  const bankB = await mkAccount('Bank B');
  const retired = await mkAccount('Retired', false);
  const mkChannel = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${orgId}, ${storeId}, ${`${name} ${uid('c')}`}, false, '1220', ${bankA.id}) returning id`)[0]!.id;
  const channelId = await mkChannel('Foodpanda');
  const siblingChannelId = await mkChannel('GrabFood');
  return { orgId, storeId, channelId, siblingChannelId, bankA, bankB, retired, admin: actor(orgId, adminId), other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'channel-settlements payout account',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.channelId,
  siblingId: (c) => c.siblingChannelId,
  marker: (_c, id) => `name="channelId" value="${id}"`,
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = { channelId: c.channelId, moneyAccountId: c.retired.id };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(_c, fd, who) {
    h.actor = who;
    const { setPayoutDestinationAction } = await import('../../src/app/channel-settlements/actions');
    const signal = await captureRedirect(() => setPayoutDestinationAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: /is retired/i,
  expectedFields: (c) => ({ moneyAccountId: c.retired.id }),
  neverKept: () => ['channelId'],
  changedLeg: (c) => ({ changed: 'moneyAccountId', fields: { moneyAccountId: c.retired.id } }),
  async render(_c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/channel-settlements/page');
    return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(params) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.channelId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: (c) => [`value="${c.bankA.id}" selected`],
  typedNotDrawn: (c) => [c.retired.id],
  tooLong: { name: 'moneyAccountId' },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('channelId', c.channelId);
    fd.set('moneyAccountId', c.bankB.id);
    return fd;
  },
  expectOk: 'destination',
});
