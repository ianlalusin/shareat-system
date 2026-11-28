import { expect, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - staff/[employmentId]: the positions form (a checkbox group plus a radio group) keeps what was
 * ticked after a refused save (DEF-617). Spec: docs/tasks/389-refused-save-keeps-typing.md. Legs and harness: t389-s2-common.ts.
 *
 * Form: setPositionsAction. Refusal driven: a primary position that is not among the ticked ones ("a contradiction, not a
 * shortcut"), which the browser cannot pre-empt (radio and checkboxes are independent controls).
 * The Issue-PIN form on the same page (`name="pin"`) is a command, out of scope and never echoed (spec R4); the legs
 * below do not touch it.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `staff.positions`; record = the employment id; allow-list = positionIds (checkbox group, kept as an ARRAY when
 *    two or more are ticked), primaryPositionId (radio group). NOT employmentId (hidden). Nothing named pin, ever.
 *  - SPEC GAP, reported not worked around: the group controls hold only ids, so "too long" cannot be made by honest use.
 *    The too-long leg posts a hand-crafted 6,000-character primaryPositionId; the server refuses it the same way.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown>>,
  refills: [] as Array<{ formKey?: string; typed?: { kind?: string; fields?: Record<string, unknown> } | null }>,
  modals: [] as Array<{ title?: unknown; defaultOpen?: boolean }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
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

// T-590b: the positions form is in a FormModal with a RefillForm, so the legs read these two instead of EditableRecord props.
vi.mock('../../src/app/staff/[employmentId]/RefillForm', async (orig) => {
  const real = await orig<typeof import('../../src/app/staff/[employmentId]/RefillForm')>();
  const { createElement } = await import('react');
  return {
    ...real,
    RefillForm: (p: { formKey?: string; typed?: never }) => {
      seen.refills.push(p);
      return createElement(real.RefillForm as never, p as never);
    },
  };
});
vi.mock('@/components/ui', async (orig) => {
  const real = await orig<typeof import('@/components/ui')>();
  const { createElement } = await import('react');
  return {
    ...real,
    FormModal: (p: { title?: unknown; defaultOpen?: boolean }) => {
      seen.modals.push({ title: p.title, defaultOpen: p.defaultOpen });
      return createElement(real.FormModal as never, p as never);
    },
  };
});

import { renamePerson, seedCanonicalPositions, setEmploymentPositions } from '@shareat/domain';
import { asOrg, createHarness, fixture, LONG, sql, uid, type BaseCtx, type FormCase } from './t389-s2-common';

const { runTypedLegs } = createHarness({ h, seen });

interface StaffCtx extends BaseCtx {
  p1: string; // stored: assigned and primary
  p2: string; // typed as primary, never ticked
  p3: string; // typed as ticked
}
async function staffCtx(hint: string): Promise<StaffCtx> {
  const f = await fixture(`staff-${hint}`);
  await asOrg(f.orgId, (tx) => seedCanonicalPositions(tx, f.orgId));
  // T-451: administrators edit a staff subject; their own role has no position picker.
  const [subject] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Staff Subject') returning id`;
  if (!subject) throw new Error('Staff subject fixture was not inserted.');
  await sql`insert into person_roles (person_id, org_id, role) values (${subject.id}, ${f.orgId}, 'staff')`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${f.orgId}, ${f.storeId}, ${subject.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  const ps = await sql<{ id: string }[]>`select id from positions where org_id = ${f.orgId} and store_id is null order by name limit 3`;
  const [p1, p2, p3] = [ps[0]!.id, ps[1]!.id, ps[2]!.id];
  await asOrg(f.orgId, (tx) => setEmploymentPositions(tx, f.admin, { employmentId: emp!.id, positionIds: [p1], primaryPositionId: p1 }));
  await asOrg(f.orgId, (tx) => renamePerson(tx, f.admin, { employmentId: emp!.id, lastName: 'Storedlast', firstName: 'Storedfirst', middleName: 'Storedmid' }));
  return { f, record: emp!.id, p1, p2, p3 };
}

const positions: FormCase<StaffCtx> = {
  label: 'staff positions',
  form: 'staff.positions',
  modal: { title: 'Edit positions' },
  setup: staffCtx,
  action: async () => (await import('../../src/app/staff/actions')).setPositionsAction,
  page: async () => (await import('../../src/app/staff/[employmentId]/page')).default as never,
  props: (ctx, params) => ({ params: Promise.resolve({ employmentId: ctx.record }) as never, searchParams: Promise.resolve(params) }),
  sel: (ctx) => ({ action: 'setPositionsAction', hidden: { employmentId: ctx.record } }),
  has: (ctx) => [`name="employmentId" value="${ctx.record}"`, 'name="positionIds"'],
  hiddenNames: ['employmentId'],
  // ticked p1 and p3, primary p2: the primary is not among the ticked ones
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    const base: Record<string, string | string[]> = { employmentId: ctx.record, positionIds: [ctx.p1, ctx.p3], primaryPositionId: ctx.p2 };
    for (const [k, v] of Object.entries({ ...base, ...over })) {
      if (v === null) continue;
      for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
    }
    return fd;
  },
  refusal: /primary position must be one of the assigned positions/,
  fields: (ctx) => ({ positionIds: [ctx.p1, ctx.p3], primaryPositionId: ctx.p2 }),
  changed: { list: 'primaryPositionId', fields: (ctx) => ({ primaryPositionId: ctx.p2 }) },
  notDrawn: [],
  stored: (ctx, seg, m) => {
    expect(m.checkedValues(seg, 'positionIds'), 'the stored assignment is ticked, the typed p3 is not').toEqual([ctx.p1]);
    expect(m.checkedValues(seg, 'primaryPositionId'), 'the stored primary is chosen, the typed p2 is not').toEqual([ctx.p1]);
  },
  tooLong: { primaryPositionId: LONG },
  good: (ctx) => positions.refused(ctx, { primaryPositionId: ctx.p3 }),
  ok: /Positions saved/,
  // T-590b: the name pop-up is the other refill on this page; it must stay shut and untyped.
  siblings: async (ctx) => [{ label: 'the name pop-up', sel: { action: 'renamePersonAction', hidden: { employmentId: ctx.record } }, has: [`name="employmentId" value="${ctx.record}"`, 'name="lastName"'], modal: { formKey: 'staff.rename', title: 'Edit name' } }],
};

/**
 * T-590 A1: the name form is a FormModal + RefillForm too. Refusal driven: a first name of only spaces, which the
 * browser's `required` lets through and the server refuses ("both a last name and a first name").
 */
const TYPED_LAST = 'Typedlast-T590';
const TYPED_MID = 'Typedmid-T590';
const rename: FormCase<StaffCtx> = {
  label: 'staff name',
  form: 'staff.rename',
  modal: { title: 'Edit name' },
  setup: staffCtx,
  action: async () => (await import('../../src/app/staff/actions')).renamePersonAction,
  page: positions.page,
  props: positions.props,
  sel: (ctx) => ({ action: 'renamePersonAction', hidden: { employmentId: ctx.record } }),
  has: (ctx) => [`name="employmentId" value="${ctx.record}"`, 'name="lastName"'],
  hiddenNames: ['employmentId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    const base: Record<string, string | null> = { employmentId: ctx.record, lastName: TYPED_LAST, firstName: '   ', middleName: TYPED_MID };
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.append(k, v as string);
    return fd;
  },
  refusal: /first name/i,
  fields: () => ({ lastName: TYPED_LAST, firstName: '   ', middleName: TYPED_MID }),
  changed: { list: 'lastName', fields: () => ({ lastName: TYPED_LAST }) },
  notDrawn: [TYPED_LAST, TYPED_MID],
  stored: (_ctx, seg, m) => {
    expect(m.inputValue(seg, 'lastName'), 'the stored last name is drawn, not the typed one').toBe('Storedlast');
    expect(m.inputValue(seg, 'middleName'), 'the stored middle name is drawn').toBe('Storedmid');
  },
  tooLong: { lastName: LONG },
  good: (ctx) => rename.refused(ctx, { firstName: 'Goodfirst' }),
  ok: /Name saved/,
  siblings: async (ctx) => [{ label: 'the positions pop-up', sel: { action: 'setPositionsAction', hidden: { employmentId: ctx.record } }, has: [`name="employmentId" value="${ctx.record}"`, 'name="positionIds"'], modal: { formKey: 'staff.positions', title: 'Edit positions' } }],
};

runTypedLegs(positions);
runTypedLegs(rename);
