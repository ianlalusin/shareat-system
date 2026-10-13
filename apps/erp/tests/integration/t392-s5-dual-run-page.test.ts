/**
 * T-392 S5 (TESTER) - the dual-run week page and its server action. docs/tasks/392-dual-run-comparator.md "S5 spec (refinements)" invariant 52,
 * invariant 31, and "Ian rulings, 2026-10-13" (ONLY admin / super_admin record a disposition; managers see the pages read-only).
 * `renderToStaticMarkup`, real Postgres, real @shareat/auth; only `requireSession` / `requireActor`, the flash redirect and `Page` are mocked
 * (the t350-s2-render pattern). Synthetic data.
 *
 * ---- PINNED CONTRACT ----
 * apps/erp/src/app/reports/dual-run/[store]/[week]/page.tsx: default export async ({ params: Promise<{ store: code; week: Monday }>, searchParams: Promise<{ version?: reportId }> }).
 *   - lists the lines of the current version (the stored label or key appears); an older `?version=` is read-only (no form);
 *   - the version history marks "v1 changed" / "v2 changed" / "keys changed" against the next older version;
 *   - the disposition form is rendered ONLY for an admin / super_admin (Ian's ruling, replaces the spec's "run_cutover holder") and ONLY for a line the
 *     domain would accept (delta != 0, not TIES / UNMAPPED_KEY / INVENTORY_BASIS / SUPPLIER_ADVANCE_1240 / sales_tender "none"): a <select name="class"> with
 *     exactly V1_DEFECT and V2_DEFECT, <input name="ref" pattern="DEF-[0-9]+" required>, <textarea name="note" required maxlength="500">, hidden storeId /
 *     weekStart / kind / lineKey inputs, and NO amount field.
 * apps/erp/src/app/reports/dual-run/actions.ts: 'use server'; recordDualRunDispositionAction(formData: FormData): Promise<void>
 *   = requireActor() -> withOrgPrincipal -> recordDualRunDisposition -> redirectWithFlash(path, params, { ok } | { error }) (the findings/actions.ts pattern).
 *   FormData fields: storeId (the store UUID), weekStart, kind, lineKey, class, ref, note.
 * apps/erp/src/components/nav.tsx holds { href: '/reports/dual-run', label: 'Dual run' } after 'POS reconciliation'.
 *
 * Red today: none of these modules exists (the import in beforeAll fails: "Cannot find module ... reports/dual-run/...").
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { line, makeFixture, seedReport, type S5Fixture } from '../../../../packages/domain/tests/integration/t392-s5-fixture';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 5 });

const h = vi.hoisted(() => ({
  current: { orgId: '', personId: '' } as { orgId: string; personId: string },
  flash: [] as { path: string; params: unknown; flash: Any }[],
}));

vi.mock('../../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({
    actor: h.current,
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  })),
  requireActor: vi.fn(async () => h.current),
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/lib/flash', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    redirectWithFlash: vi.fn(async (path: string, params: unknown, flash: Any) => {
      h.flash.push({ path, params, flash });
    }),
  };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

const W = '2026-10-19';
let WeekPage: (p: Any) => Promise<unknown>;
let recordAction: (fd: FormData) => Promise<void>;

beforeAll(async () => {
  WeekPage = (await import('../../src/app/reports/dual-run/[store]/[week]/page')).default as Any;
  recordAction = (await import('../../src/app/reports/dual-run/actions')).recordDualRunDispositionAction as Any;
}, 60_000);
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const LINES = [
  line('ap_supplier', 'SUP-ACME-77', '500.00', '0.00', 'UNEXPLAINED'),
  line('ap_supplier', 'SUP-TIED', '100.00', '100.00', 'TIES'),
  line('ap_supplier', 'v1:ap__x', '300.00', '0.00', 'UNMAPPED_KEY'),
  line('inventory_basis', '1310', '200.00', '0.00', 'INVENTORY_BASIS'),
];

async function seed(f: S5Fixture, twoVersions = false): Promise<{ oldId?: string; newId: string }> {
  const labelled = LINES.map((l) => (l.key === 'SUP-ACME-77' ? { ...l, label: 'Acme Supplies' } : l));
  let oldId: string | undefined;
  if (twoVersions) {
    oldId = await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W, verdict: 'open', days: 2, v1fp: 'v1-a', v2fp: 'v2-a', createdAt: '2026-10-26T00:00:00Z', lines: labelled, createdBy: f.admin.personId });
  }
  const newId = await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W, verdict: 'open', days: 2, v1fp: twoVersions ? 'v1-b' : 'v1-a', v2fp: 'v2-a', createdAt: '2026-10-27T00:00:00Z', lines: labelled, createdBy: f.admin.personId });
  return { oldId, newId };
}

async function render(f: S5Fixture, as: { orgId: string; personId: string }, search: Record<string, string> = {}): Promise<string> {
  h.current = as;
  const el = await WeekPage({ params: Promise.resolve({ store: f.lipa.code, week: W }), searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el as never);
}

const hiddenLineKeys = (html: string): string[] =>
  [...html.matchAll(/name="lineKey"[^>]*?value="([^"]*)"|value="([^"]*)"[^>]*?name="lineKey"/g)].map((m) => m[1] ?? m[2] ?? '');

describe('52. the week page: the form is for admins, on actionable lines, offering exactly two classes', () => {
  it(
    'an admin sees the lines and a form with exactly the V1_DEFECT / V2_DEFECT options, pattern DEF-[0-9]+, a required note, no amount field, and hidden keys only for the actionable line. Mutant: form rendered for everyone / every line. Red today: the page module does not exist',
    async () => {
      const f = await makeFixture(sql, '52a');
      await seed(f);
      const html = await render(f, f.admin);
      expect(html.includes('Acme Supplies') || html.includes('SUP-ACME-77')).toBe(true);
      expect(html).toContain('name="class"');
      const select = html.match(/<select[^>]*name="class"[^>]*>([\s\S]*?)<\/select>/);
      expect(select, 'a <select name="class">').not.toBeNull();
      const options = [...select![1]!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
      expect([...new Set(options)].sort()).toEqual(['V1_DEFECT', 'V2_DEFECT']);
      expect(html).toContain('pattern="DEF-[0-9]+"');
      expect(html).toMatch(/<input[^>]*name="ref"[^>]*required|<input[^>]*required[^>]*name="ref"/);
      expect(html).toMatch(/<textarea[^>]*name="note"/);
      expect(html).toMatch(/maxLength="500"|maxlength="500"/i);
      expect(html).not.toMatch(/name="(amount|delta|deltaAt)"/);
      const keys = new Set(hiddenLineKeys(html));
      expect(keys.has('SUP-ACME-77')).toBe(true);
      for (const k of ['SUP-TIED', 'v1:ap__x', '1310']) expect(keys.has(k), `no form for ${k}`).toBe(false);
    },
    60_000,
  );

  it(
    "a DEFAULT manager (holds run_cutover and view_financial_reports) sees the lines read-only: no form at all (Ian's ruling). Mutant: form rendered for everyone / for run_cutover holders. Red today: the page module does not exist",
    async () => {
      const f = await makeFixture(sql, '52b');
      await seed(f);
      const html = await render(f, f.manager);
      expect(html.includes('Acme Supplies') || html.includes('SUP-ACME-77')).toBe(true);
      expect(html).not.toContain('name="ref"');
      expect(html).not.toContain('name="class"');
      expect(html).not.toContain('pattern="DEF-[0-9]+"');
      expect(html).not.toMatch(/<textarea/);
    },
    60_000,
  );

  it(
    'a person holding view_financial_reports only (granted, not an admin) sees the lines and no form. Red today: the page module does not exist',
    async () => {
      const f = await makeFixture(sql, '52c');
      await seed(f);
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Viewer') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.lipa.id})`;
      await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${p!.id}, 'view_financial_reports', null, null)`;
      const html = await render(f, { orgId: f.orgId, personId: p!.id });
      expect(html.includes('Acme Supplies') || html.includes('SUP-ACME-77')).toBe(true);
      expect(html).not.toContain('name="ref"');
      expect(html).not.toMatch(/<textarea/);
    },
    60_000,
  );

  it(
    'two versions whose v1 fingerprints differ: the history says "v1 changed" and not "v2 changed"; the older version opened with ?version= is read-only (no form) for an admin. Mutant: history not compared / old version editable. Red today: the page module does not exist',
    async () => {
      const f = await makeFixture(sql, '52d');
      const { oldId } = await seed(f, true);
      const html = await render(f, f.admin);
      expect(html).toContain('v1 changed');
      expect(html).not.toContain('v2 changed');
      const old = await render(f, f.admin, { version: oldId! });
      expect(old.includes('Acme Supplies') || old.includes('SUP-ACME-77')).toBe(true);
      expect(old).not.toContain('name="ref"');
    },
    60_000,
  );

  it('nav.tsx holds /reports/dual-run labelled "Dual run", after "POS reconciliation"', () => {
    const nav = readFileSync(fileURLToPath(new URL('../../src/components/nav.tsx', import.meta.url)), 'utf8');
    const pos = nav.indexOf('POS reconciliation');
    const dual = nav.indexOf("href: '/reports/dual-run'");
    expect(pos).toBeGreaterThan(-1);
    expect(dual, "nav.tsx must contain { href: '/reports/dual-run', ... }").toBeGreaterThan(pos);
    expect(nav.slice(dual, dual + 80)).toContain("label: 'Dual run'");
  });
});

describe('31. the server action: recording is refused for anyone but an admin, in the domain', () => {
  const form = (f: S5Fixture, over: Record<string, string> = {}): FormData => {
    const fd = new FormData();
    const v: Record<string, string> = { storeId: f.lipa.id, weekStart: W, kind: 'ap_supplier', lineKey: 'SUP-ACME-77', class: 'V2_DEFECT', ref: 'DEF-610', note: 'invoice not entered', ...over };
    for (const [k, val] of Object.entries(v)) fd.set(k, val);
    return fd;
  };
  const disp = async (f: S5Fixture) => Number((await sql<Any[]>`select count(*)::int n from dual_run_dispositions where org_id = ${f.orgId}`)[0]!.n);

  it(
    'a default manager (holds run_cutover) and staff submitting the form get an error flash and NO row; an admin gets an ok flash and a row at the current delta. Mutant: the gate only in the UI. Red today: the action module does not exist',
    async () => {
      const f = await makeFixture(sql, '31a');
      await seed(f);
      for (const who of [f.manager, f.staff, f.staffWithGrants]) {
        h.current = who;
        h.flash.length = 0;
        await recordAction(form(f));
        expect(h.flash).toHaveLength(1);
        expect(h.flash[0]!.flash.error, 'an error flash').toBeTruthy();
        expect(h.flash[0]!.flash.ok).toBeUndefined();
        expect(await disp(f)).toBe(0);
      }
      h.current = f.admin;
      h.flash.length = 0;
      await recordAction(form(f));
      expect(h.flash).toHaveLength(1);
      expect(h.flash[0]!.flash.ok, 'an ok flash').toBeTruthy();
      const [row] = await sql<Any[]>`select delta_at::text d, class, ref from dual_run_dispositions where org_id = ${f.orgId}`;
      expect(row).toMatchObject({ d: '-500.00', class: 'V2_DEFECT', ref: 'DEF-610' });
    },
    60_000,
  );

  it(
    'an admin submitting a ref that is not DEF-nnn, or the class INVENTORY_BASIS, gets an error flash and NO row (the form attributes are hints; the domain is the gate). Red today: the action module does not exist',
    async () => {
      const f = await makeFixture(sql, '31b');
      await seed(f);
      h.current = f.admin;
      for (const over of [{ ref: 'def-1' }, { ref: 'DEF-1x' }, { class: 'INVENTORY_BASIS' }, { note: '' }]) {
        h.flash.length = 0;
        await recordAction(form(f, over));
        expect(h.flash[0]?.flash.error, JSON.stringify(over)).toBeTruthy();
        expect(await disp(f)).toBe(0);
      }
    },
    60_000,
  );
});
