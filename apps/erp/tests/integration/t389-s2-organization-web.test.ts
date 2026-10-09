import { expect, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - settings/organization: the registered-identity form keeps what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md. Legs and harness: t389-s2-common.ts.
 *
 * Form (singleton): setOrganizationIdentityAction, the refusal driven is a malformed TIN ("12-3": a TIN is 9-12 digits).
 * CONTRACT PINNED HERE: form key `organization.identity`; record '' (singleton, spec R2 / per-form step 3);
 * allow-list legalName, tin, taxType (no hidden ids: the form has none).
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

const identity: FormCase<BaseCtx> = {
  label: 'settings organization identity',
  form: 'organization.identity',
  setup: async (hint) => {
    const f = await fixture(`org-${hint}`);
    await sql`update organizations set legal_name = 'Stored Legal Name', tin = '123456789', tax_type = 'vat' where id = ${f.orgId}`;
    return { f, record: '' };
  },
  action: async () => (await import('../../src/app/settings/organization/actions')).setOrganizationIdentityAction,
  page: async () => (await import('../../src/app/settings/organization/page')).default as never,
  props: (_ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve(params) }),
  sel: () => ({ action: 'setOrganizationIdentityAction', hidden: {} }),
  has: () => ['name="legalName"', 'name="taxType"'],
  hiddenNames: [],
  refused: (_ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ legalName: 'Typed Legal Name', tin: '12-3', taxType: 'non_vat', ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /TIN must be 9-12 digits/,
  fields: () => ({ legalName: 'Typed Legal Name', tin: '12-3', taxType: 'non_vat' }),
  changed: { list: 'legalName,taxType', fields: () => ({ legalName: 'Typed Legal Name', taxType: 'non_vat' }) },
  notDrawn: ['Typed Legal Name', '12-3'],
  stored: (_ctx, seg, m) => {
    expect(m.inputValue(seg, 'legalName')).toBe('Stored Legal Name');
    expect(m.inputValue(seg, 'tin')).toBe('123456789');
    expect(m.selectedValue(seg, 'taxType')).toBe('vat');
  },
  tooLong: { legalName: LONG },
  good: (ctx) => identity.refused(ctx, { tin: '123-456-789' }),
  ok: /Saved\./,
};

runTypedLegs(identity);
