/**
 * T-342 / DEF-417 part 1 — proves the fix pattern under the RLS-enforcing role, and proves the
 * bug it replaces. `docs/tasks/342-def-417-cutover-null-tx-rls.md` §Tests item 2.
 *
 * ⭐ **This file runs inside the `integration` vitest project, whose `tests/integration/setup.ts`
 * arms `INTEGRATION_RESTRICTED_ROLE` ON BY DEFAULT (DEF-218, closed 2026-09-12) — `DATABASE_URL`
 * (what `@shareat/db`'s `transaction()` / `withOrgPrincipal()` resolve) is already the non-super,
 * non-BYPASSRLS `shareat_test_runner` role, never the admin/bypass one.** So the two branches
 * below are not a simulation of RLS enforcement — they run under the same enforcing role
 * `packages/db/tests/integration/restricted-role.test.ts` builds by hand, reached here through the
 * app-facing helpers (`transaction`, `withOrgPrincipal`) instead of a second bespoke connection.
 * Test 0 pins that down explicitly so this file does not silently stop meaning anything if the
 * default is ever flipped back to opt-in.
 *
 * - **Positive** (the fix the BUILDER will adopt): `attestStep`/`addOpeningFigure` wrapped in
 *   `withOrgPrincipal(orgId, tx => domainFn(tx, actor, …))` succeed — the org's own admin, doing
 *   the org's own work, is not refused. GREEN NOW; this is the pattern under test, not the bug.
 * - **Negative** (today's bug, DEF-417): the same calls through the bare null-tx branch
 *   (`domainFn(null, actor, …)`) reject with `/has no active role/` — `authorize()` reading
 *   `person_roles` (RLS `org_column`) through a transaction with no principal applied. GREEN NOW —
 *   this is the proof the harness really enforces RLS, and it is what today's shipped bug looks
 *   like from the inside. The RED for T-342 lives in the sibling guard test
 *   (`apps/erp/tests/t342-no-null-tx-from-actions.test.ts`), not here: this file is a control.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, transaction, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { addOpeningFigure, attestStep } from '@shareat/domain';

/** Admin/bypass connection, for fixture seeding only — same shape as every other integration
 * test file's own `sql` (e.g. `packages/domain/tests/integration/cutover.test.ts:38`). Never used
 * to run the code under test. */
const admin = postgres(url, { max: 3 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function fixture() {
  const code = uid('t342');
  const [org] = await admin<{ id: string }[]>`
    insert into organizations (name, code) values (${`T342 Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [person] = await admin<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'T342 Admin') returning id`;
  await admin`insert into person_roles (person_id, org_id, role) values (${person!.id}, ${orgId}, 'admin')`;
  const actor: Actor = { personId: person!.id, orgId };
  return { orgId, actor };
}

afterAll(async () => {
  await closeDb();
  await admin.end({ timeout: 5 });
});

describe('T-342 / DEF-417 part 1 — cutover under the RLS-enforcing role', () => {
  it('0. control: DATABASE_URL is genuinely the restricted, non-bypass role (not the admin connection)', async () => {
    // If this ever reports true, the two tests below prove nothing about RLS — they would be
    // running as the owner, which bypasses every policy in the database.
    const row = await transaction(async (tx) => {
      const rows = await tx.execute(dsql`select rolbypassrls as "rolbypassrls" from pg_roles where rolname = current_user`);
      return (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows)[0] as { rolbypassrls: boolean };
    });
    expect(row.rolbypassrls, 'DATABASE_URL must not be the bypass/admin role for this file to mean anything').toBe(false);
  });

  it('1. POSITIVE — withOrgPrincipal(orgId, tx => attestStep(tx, actor, …)): the org admin attests A1', async () => {
    const { orgId, actor } = await fixture();
    await expect(
      withOrgPrincipal(orgId, (tx) => attestStep(tx, actor, { stepCode: 'A1', note: 'T-342 positive control.' })),
    ).resolves.toBeUndefined();
  });

  it('1b. POSITIVE — withOrgPrincipal(orgId, tx => addOpeningFigure(tx, actor, …)) does not refuse the admin', async () => {
    // addOpeningFigure needs a fiscal period and a resolvable account; DEF-417 is specifically
    // about the transaction's PRINCIPAL, not about missing setup, so this asserts the failure it
    // gets (if any) is never the RLS refusal under test — a period/account error here would be a
    // fixture gap, not a repeat of the bug.
    const { orgId, actor } = await fixture();
    await admin`
      insert into fiscal_periods (org_id, starts_on, ends_on, status) values
        (${orgId}, '2026-12-01', '2026-12-31', 'open')`;
    const [store] = await admin<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('T342')}, 'T342 Store') returning id`;
    const { seedChartOfAccounts } = await import('../../../db/seed/chart-of-accounts');
    await seedChartOfAccounts(admin, orgId);

    await expect(
      withOrgPrincipal(orgId, (tx) =>
        addOpeningFigure(tx, actor, {
          accountCode: '1110',
          storeId: store!.id,
          direction: 'debit',
          amount: '100.00',
          entryDate: '2026-12-15',
        }),
      ),
    ).resolves.toMatchObject({ entryId: expect.any(String) });
  });

  it('2. NEGATIVE — attestStep(null, actor, …) (bare null-tx branch) rejects with /has no active role/', async () => {
    // ⛔ This IS today's DEF-417 bug, reproduced live: a bare `null` tx opens `transaction()` with
    // no principal applied, so `authorize()`'s RLS-scoped `person_roles` read sees zero rows for
    // an admin who very much has an active role. GREEN NOW — the proof the harness enforces RLS —
    // and it is exactly the failure the builder's fix (test 1 above) makes go away.
    const { actor } = await fixture();
    await expect(attestStep(null, actor, { stepCode: 'A1', note: 'T-342 negative control.' })).rejects.toThrow(
      /has no active role/,
    );
  });

  it('2b. NEGATIVE — addOpeningFigure(null, actor, …) (bare null-tx branch) rejects with /has no active role/', async () => {
    const { orgId, actor } = await fixture();
    await admin`
      insert into fiscal_periods (org_id, starts_on, ends_on, status) values
        (${orgId}, '2026-12-01', '2026-12-31', 'open')`;
    const [store] = await admin<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('T342')}, 'T342 Store') returning id`;
    await expect(
      addOpeningFigure(null, actor, {
        accountCode: '1110',
        storeId: store!.id,
        direction: 'debit',
        amount: '100.00',
        entryDate: '2026-12-15',
      }),
    ).rejects.toThrow(/has no active role/);
  });
});
