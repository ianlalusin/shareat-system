/**
 * T-601 S1 - posSoakChecks against a real database. docs/tasks/601-pos-soak-readiness.md S1.
 * The pure decision (every check failing alone) is `src/pos/soak-checks.test.ts`; THIS file proves the extra facts are read right: the manage_stores
 * gate, the active terminal link, the approver (capability AND a live PIN), and that the list writes nothing. Made-up data only.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { asOrg, closeAll, fixture, makeStaff, pinOf, sql, uuid, type Fx } from './_fixtures/t525-pos';
import { posSoakChecks } from '../../src/pos/soak-checks';

afterAll(closeAll);

const RULE_KEYS: [string, string][] = [
  ['tax.vat_percent', '12.00'],
  ['pos.senior_pwd_discount_percent', '20.00'],
  ['pos.business_day_start_hour', '4.00'],
  ['pos.table_warn_minutes', '90.00'],
];

/** A store with PINs and the four seeded rules (copied from t533-s3-preflight.test.ts; not imported across test files). */
async function ready(): Promise<Fx> {
  const f = await fixture('test');
  for (const [key, value] of RULE_KEYS) {
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason)
              values (${f.orgId}, ${key}, ${value}, '2026-01-01', ${f.adminId}, 'seed for the test')`;
  }
  await sql`update tenders set pos_v1_alias = lower(name) where store_id = ${f.storeId} and is_active`;
  for (const id of [f.managerId, f.counterId, f.kitchenId]) await pinOf(f, id);
  return f;
}

const DEPS = { keyFilePresent: () => true };
const run = (f: Fx, actor = f.admin) => asOrg(f.orgId, (tx) => posSoakChecks(tx, actor, { storeId: f.storeId }, DEPS));
const row = async (f: Fx, code: string) => (await run(f)).find((c) => c.code === code)!;

describe('T-601 S1 posSoakChecks', () => {
  it('a store manager is refused (the manage_stores gate), and so is a cashier', async () => {
    const f = await ready();
    for (const who of [f.manager, f.counter]) {
      const err = await run(f, who).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AuthorizationError);
    }
  });

  it('returns the 15 checks in order, and a store in TEST mode passes test_mode', async () => {
    const f = await ready();
    const checks = await run(f);
    expect(checks.map((c) => c.code)).toEqual([
      'menu_items', 'menu_packages', 'menu_refills', 'menu_flavours', 'kitchen_stations', 'menu_dayparts', 'stands_presets',
      'tablet_till', 'terminal_link', 'approver', 'rules', 'test_mode', 'tenders', 'receipt_issuer', 'people',
    ]);
    expect(checks.find((c) => c.code === 'test_mode')!.ok).toBe(true);
    expect(checks.find((c) => c.code === 'menu_items')!.ok).toBe(true);
    expect(checks.find((c) => c.code === 'tenders')!.ok).toBe(true);
  });

  it('terminal_link: passes with the active link, fails once it is revoked, passes again with a new link', async () => {
    const f = await ready();
    expect((await row(f, 'terminal_link')).ok).toBe(true);
    await sql`update pos_terminal_links set revoked_at = now(), revoked_by = ${f.adminId} where store_id = ${f.storeId}`;
    expect((await row(f, 'terminal_link')).ok).toBe(false);
    const [v1link] = await sql<{ id: string }[]>`select id from pos_v1_store_links where store_id = ${f.storeId} limit 1`;
    await sql`insert into pos_terminal_links (org_id, store_id, pos_v1_store_link_id, terminal_no, device_id, terminal_person_id, created_by)
              values (${f.orgId}, ${f.storeId}, ${v1link!.id}, 1, ${uuid()}, ${f.adminId}, ${f.adminId})`;
    expect((await row(f, 'terminal_link')).ok).toBe(true);
  });

  const grant = (f: Fx, personId: string) =>
    sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id)
        values (${personId}, 'approve_pos_correction', ${f.adminId}, 'grant', ${f.storeId})`;

  it('approver: a signed-in person with a PIN but no approve_pos_correction grant is not an approver; the grant makes it pass', async () => {
    const f = await ready();
    const who = await makeStaff(f, 'Pat Approver');
    await pinOf(f, who);
    expect((await row(f, 'approver')).ok).toBe(false);
    await grant(f, who);
    expect((await row(f, 'approver')).ok).toBe(true); // the cashier (a seller who is not the approver) can still ring up sales
  });

  it('approver: an approver without a live PIN does not count', async () => {
    const f = await ready();
    const who = await makeStaff(f, 'Pat NoPin');
    await grant(f, who);
    expect((await row(f, 'approver')).ok).toBe(false);
  });

  it('it writes nothing: no audit row', async () => {
    const f = await ready();
    const auditCount = async () => (await sql<{ n: number }[]>`select count(*)::int n from audit_log where org_id = ${f.orgId}`)[0]!.n;
    const before = await auditCount();
    await run(f);
    expect(await auditCount()).toBe(before);
  });
});
