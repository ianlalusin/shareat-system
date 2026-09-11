import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-251 / DEF-218 Contract 4 — the control tests, proving `shareat_test_runner` (Contract 1)
 * actually closes the hole DEF-218 names. `docs/tasks/251-def-218-integration-harness-role.md`.
 *
 * ⚠️ **Why this file opens its OWN restricted connection instead of using `transaction()` /
 * `DATABASE_URL`, unlike the spec's own Contract 4 sketch.** When this was written
 * `INTEGRATION_RESTRICTED_ROLE` was **off by default**, so a control written against
 * `transaction()` would have been red every run until someone flipped a flag nobody flipped —
 * exactly the "permanently red gate teaches everyone to ignore red" trap `setup.ts`'s header warns
 * about.
 *
 * ⭐ **That is no longer true: the flag went ON BY DEFAULT on 2026-09-12 and DEF-218 is closed.**
 * This file is deliberately left as it is anyway, and the reason is better than inertia — building
 * its own connection explicitly means it proves the MECHANISM (the role's own grants, from the
 * login role's side of the boundary) rather than today's harness configuration. It would stay green
 * and meaningful even if someone disarmed the default again, which is exactly what you want from a
 * control.
 *
 * ⭐ **The asymmetry this file exists to pin down, in executable form:** a forgotten principal
 * makes a WRITE fail loudly (SQLSTATE `42501`) and a READ fail *silently* — zero rows, which
 * looks exactly like "success, nothing to do." That silent half is what makes DEF-218 dangerous;
 * see invariant 8 in `rls.test.ts` for the same shape proven against the bypass admin connection
 * with an explicit role switch. This file proves it again from the LOGIN role's own side of the
 * boundary: no superuser, no BYPASSRLS, so nothing here depends on anyone remembering to switch
 * roles correctly.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { RESTRICTED_TEST_ROLE, RESTRICTED_TEST_PASSWORD } from '../../../../tests/integration/setup';

/** The admin/bypass connection — Contract 2: `TEST_DATABASE_URL` stays the owner role, untouched,
 * so this is the same fixture-seeding shape every other integration test file already uses. */
const admin = postgres(url, { max: 3 });

/** ⛔ `new URL()`, never string surgery — a password may legitimately contain `@` (setup.ts's own
 * rule, restated here because this file builds the swap independently of setup.ts). */
const restrictedUrl = new URL(url);
restrictedUrl.username = RESTRICTED_TEST_ROLE;
restrictedUrl.password = RESTRICTED_TEST_PASSWORD;
const restricted = postgres(restrictedUrl.toString(), { max: 3 });

let orgA: string;
let orgB: string;

/**
 * One transaction on the RESTRICTED connection. Always switches role to `shareat_app` first —
 * mirroring `applyPrincipal` (`packages/db/src/rls/principal.ts:41-46`), which does exactly this
 * as its first statement regardless of principal kind. `org === null` is "no principal set" in
 * this codebase's vocabulary (same meaning as `rls.test.ts`'s `asOrg(null, ...)`): the role is
 * switched, but no `app.org_id` / `app.principal_kind` is ever configured.
 */
async function asRestricted<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await restricted.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) {
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      await tx`select set_config('app.org_id', ${org}, true)`;
    }
    return (await fn(tx)) as never;
  })) as T;
}

beforeEach(async () => {
  await admin`truncate table stores, organizations restart identity cascade`;
  // Two orgs, both seeded with rows — DEF-218 spec's own morning: "I wasted a probe ... selecting
  // an arbitrary org that had none and briefly concluded the policy was broken; it was my test
  // data, not the policy." orgA is guaranteed non-empty by construction, never picked blind.
  const [a] = await admin<{ id: string }[]>`insert into organizations (name, code) values ('Restricted Role Org A','rr-org-a') returning id`;
  const [b] = await admin<{ id: string }[]>`insert into organizations (name, code) values ('Restricted Role Org B','rr-org-b') returning id`;
  orgA = a!.id;
  orgB = b!.id;
  await admin`insert into stores (org_id, code, name) values
    (${orgA}, 'RRA1', 'Restricted A One'), (${orgA}, 'RRA2', 'Restricted A Two'), (${orgB}, 'RRB1', 'Restricted B One')`;
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
  await restricted.end({ timeout: 5 });
});

describe('T-251 / DEF-218 Contract 4 — shareat_test_runner control tests', () => {
  it('1. the role is genuinely restricted: rolsuper=false and rolbypassrls=false for current_user', async () => {
    // The cheap assertion everything else depends on. It catches a future change that widens
    // the role's grants out of habit ("just to make a test pass") and silently reopens DEF-218.
    // Deliberately NOT inside asRestricted() — this checks the LOGIN role itself, current_user
    // before any SET ROLE.
    const [row] = await restricted<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    expect(row?.rolsuper, `${RESTRICTED_TEST_ROLE} must not be a superuser — a superuser bypasses RLS regardless of any policy`).toBe(false);
    expect(row?.rolbypassrls, `${RESTRICTED_TEST_ROLE} must not carry BYPASSRLS — that is DEF-218 itself, reopened`).toBe(false);
  });

  it('2. a write with NO principal is refused LOUDLY — SQLSTATE 42501, matched by code, never by message', async () => {
    // Messages get reworded; this project has been bitten by tests matching a spelling instead
    // of a shape (DEF-077, DEF-183's sqlstateOf helper above in rls.test.ts).
    let code = 'NO ERROR — the write was ALLOWED, which is DEF-218 itself';
    try {
      await asRestricted(null, (tx) => tx`insert into stores (org_id, code, name) values (${orgA}, 'CTRL-W', 'no principal write')`);
    } catch (e) {
      code = (e as { code?: string }).code ?? String(e);
    }
    expect(code, 'a no-principal write must be refused by the RLS policy').toBe('42501');
  });

  it('3. a read with NO principal returns ZERO ROWS, never an error — the dangerous asymmetry', async () => {
    // This is why a forgotten principal in a job produces "success, nothing to do" instead of a
    // red: the write above fails loudly, the read below fails silently. Both halves, one file,
    // so the difference is documented in executable form rather than asserted about in prose.
    const rows = await asRestricted(null, (tx) => tx<{ code: string }[]>`select code from stores`);
    expect(rows, 'zero rows, not an error — three rows exist across orgA/orgB, none visible with no principal set').toEqual([]);
  });

  it('4. WITH a principal, the restricted role sees exactly that org’s rows and no others', async () => {
    const rows = await asRestricted(orgA, (tx) => tx<{ code: string }[]>`select code from stores order by code`);
    expect(rows.map((r) => r.code)).toEqual(['RRA1', 'RRA2']);
  });

  it('5. the admin connection still bypasses RLS — the contrast Contract 4 exists to draw', async () => {
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    expect(role?.rolbypassrls, 'TEST_DATABASE_URL must stay the bypass role — Contract 2 depends on this').toBe(true);

    // Same statement as test 2, same table, same missing principal — on the admin connection it
    // SUCCEEDS. That contrast, not a description of it, is the point of this test.
    const [written] = await admin<{ code: string }[]>`
      insert into stores (org_id, code, name) values (${orgA}, 'CTRL-A', 'admin, no principal') returning code
    `;
    expect(written?.code, 'the admin connection writes with no principal set at all — the exact exposure DEF-218 names').toBe('CTRL-A');
  });
});
