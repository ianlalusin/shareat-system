import { expect, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - settings/sales-channels: each channel card's edit form keeps what was typed after a refused save
 * (DEF-617). Spec: docs/tasks/389-refused-save-keeps-typing.md. Legs and harness: t389-s2-common.ts.
 *
 * Form: updateSalesChannelAction (one per active channel). Refusal driven: "settles later" with no receivable account
 * (the browser's `required` only demands that a remittance radio is ticked, so it cannot pre-empt this one).
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `salesChannel.edit`; record = the channel id; allow-list = name, isRemittedDaily, receivableAccountCode,
 *    wastageTypeMode (every user-editable control). NOT storeId, NOT channelId (hidden).
 *  - the nav key `store` rides the redirect (the action already sets it), so the same store reopens.
 *  - the "Add a channel" form on the same page is an open add form (spec N1): out of scope, not asserted.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { createSalesChannel } from '@shareat/domain';
import { asOrg, createHarness, fixture, LONG, uid, type BaseCtx, type FormCase } from './t389-s2-common';

const { runTypedLegs } = createHarness({ h, seen });

interface ChCtx extends BaseCtx {
  storeId: string;
  a: string;
  aName: string;
  b: string;
}
async function chCtx(hint: string): Promise<ChCtx> {
  const f = await fixture(`chan-${hint}`);
  const mk = (name: string) =>
    asOrg(f.orgId, (tx) => createSalesChannel(tx, f.admin, { storeId: f.storeId, name, isRemittedDaily: true, wastageTypeMode: 'tracked' })).then((r) => r.channelId);
  const aName = `Stored Channel ${uid(hint)}`;
  const a = await mk(aName);
  const b = await mk(`Sibling Channel ${uid(hint)}`);
  return { f, record: a, storeId: f.storeId, a, aName, b };
}
const editHas = (id: string) => [`name="channelId" value="${id}"`, 'name="isRemittedDaily"'];

const edit: FormCase<ChCtx> = {
  label: 'settings sales-channel edit',
  form: 'salesChannel.edit',
  setup: chCtx,
  action: async () => (await import('../../src/app/settings/sales-channels/actions')).updateSalesChannelAction,
  page: async () => (await import('../../src/app/settings/sales-channels/page')).default as never,
  props: (_ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve(params) }),
  sel: (ctx) => ({ action: 'updateSalesChannelAction', hidden: { channelId: ctx.a } }),
  has: (ctx) => editHas(ctx.a),
  hiddenNames: ['storeId', 'channelId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    const base = {
      storeId: ctx.storeId,
      channelId: ctx.a,
      name: 'Typed Channel Name',
      isRemittedDaily: 'false',
      receivableAccountCode: '',
      wastageTypeMode: 'instant',
    };
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /settles later, so it needs a receivable account/,
  fields: () => ({ name: 'Typed Channel Name', isRemittedDaily: 'false', receivableAccountCode: '', wastageTypeMode: 'instant' }),
  changed: { list: 'name,receivableAccountCode,wastageTypeMode', fields: () => ({ name: 'Typed Channel Name', receivableAccountCode: '', wastageTypeMode: 'instant' }) },
  notDrawn: ['Typed Channel Name'],
  stored: (ctx, seg, m) => {
    expect(m.inputValue(seg, 'name')).toBe(ctx.aName);
    expect(m.checked(seg, 'isRemittedDaily', 'true'), 'the stored answer is ticked').toBe(true);
    expect(m.checked(seg, 'isRemittedDaily', 'false'), 'the typed answer is never ticked by the server').toBe(false);
    expect(m.selectedValue(seg, 'receivableAccountCode')).toBe('');
    expect(m.checked(seg, 'wastageTypeMode', 'tracked')).toBe(true);
    expect(m.checked(seg, 'wastageTypeMode', 'instant')).toBe(false);
  },
  tooLong: { name: LONG },
  good: (ctx) => edit.refused(ctx, { isRemittedDaily: 'true', name: `Renamed Channel ${uid('good')}` }),
  ok: /Saved\. Anything already recorded/,
  siblings: async (ctx) => [{ label: 'another channel', sel: { action: 'updateSalesChannelAction', hidden: { channelId: ctx.b } }, has: editHas(ctx.b) }],
};

runTypedLegs(edit);
