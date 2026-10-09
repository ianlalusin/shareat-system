import { expect, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - settings/wastage-monitor: the Monitor select keeps what was picked after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md. Legs and harness: t389-s2-common.ts.
 *
 * Form (record = the store id, a per-store singleton): setWastageMonitorAction. It is an EditableRecord only once a
 * Monitor is named (until then it is an open add form, spec N1). Refusal driven: the person picked left the business
 * between page load and Save ("is no longer active"), the stale-list case a real till sees.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `wastageMonitor.edit`; record = the store id; allow-list = personId. NOT storeId, NOT personLabel (hidden).
 *  - the picked person is no longer an option on the reopened page, so the select keeps its STORED choice (the spec's
 *    "no matching option: leave the stored selection" rule); the leg asserts the server never draws the typed id.
 *  - the nav key `store` rides the redirect (the action already sets it).
 *  - SPEC GAP, reported not worked around: a one-field select cannot be "too long" by honest use. The too-long leg posts a
 *    hand-crafted 6,000-character personId; the server refuses it (that is no person of the organisation).
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

import { createHarness, fixture, LONG, sql, type BaseCtx, type FormCase } from './t389-s2-common';

const { runTypedLegs } = createHarness({ h, seen });

interface MonCtx extends BaseCtx {
  monitor: string; // the stored Monitor
  leaver: string; // active when the page loaded, gone by the time Save runs
  fresh: string; // another active person: the good save
}
async function monCtx(hint: string): Promise<MonCtx> {
  const f = await fixture(`mon-${hint}`);
  const person = async (name: string, active = true) =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name, is_active) values (${f.orgId}, ${name}, ${active}) returning id`)[0]!.id;
  const monitor = await person('Stored Monitor');
  const leaver = await person('Leaver');
  const fresh = await person('Fresh Monitor');
  await sql`update stores set wastage_monitor_person_id = ${monitor} where id = ${f.storeId}`;
  await sql`update persons set is_active = false where id = ${leaver}`; // they left after the page was drawn
  return { f, record: f.storeId, monitor, leaver, fresh };
}

const edit: FormCase<MonCtx> = {
  label: 'settings wastage-monitor',
  form: 'wastageMonitor.edit',
  setup: monCtx,
  action: async () => (await import('../../src/app/settings/wastage-monitor/actions')).setWastageMonitorAction,
  page: async () => (await import('../../src/app/settings/wastage-monitor/page')).default as never,
  props: (_ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve(params) }),
  sel: (ctx) => ({ action: 'setWastageMonitorAction', hidden: { storeId: ctx.record } }),
  has: (ctx) => [`name="storeId" value="${ctx.record}"`, 'name="personId"'],
  hiddenNames: ['storeId', 'personLabel'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ storeId: ctx.record, personLabel: 'Stored Monitor', personId: ctx.leaver, ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /Leaver is no longer active/,
  fields: (ctx) => ({ personId: ctx.leaver }),
  changed: { list: 'personId', fields: (ctx) => ({ personId: ctx.leaver }) },
  notDrawn: (ctx) => [ctx.leaver],
  stored: (ctx, seg, m) => expect(m.selectedValue(seg, 'personId'), 'the stored Monitor is selected').toBe(ctx.monitor),
  tooLong: { personId: LONG },
  good: (ctx) => edit.refused(ctx, { personId: ctx.fresh }),
  ok: /now answers for wasted orders/,
  note: 'picked person is no longer an option on reopen',
};

runTypedLegs(edit);
