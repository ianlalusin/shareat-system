import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-264 slice 3 (DEF-284) — the fiscal-period override. `docs/tasks/264-def-284-fiscal-period-lock.md`
 * (the SLICE 3 BUILD NOTE governs), `docs/plans/264-slice3-plan.md` (this lane's APPROVED spec).
 *
 * Every case calls `postEntry` directly, the same `withOrgPrincipal` harness `post-entry.test.ts`
 * already uses — never `confirmReceipt`/`runProductionPosting`/`recordInternalReturn`. Per DEF-302
 * (system32-85, 2026-09-12), those three insert into `stock_movements` before calling `postEntry`
 * on the same `tx`, and `stock_movements_check_period_open` has no override mechanism at all — a
 * test written against one of those three would fail for a reason that has nothing to do with
 * this task and would misreport as "the override doesn't work."
 *
 * Observation 1 (the pre-0143 baseline) was captured by hand against `shareat_test_lanea` while it
 * was still at migration 0142, BEFORE this migration touched it — see docs/plans/264-slice3-plan.md
 * for the quoted output. It cannot be reproduced here: this file runs against the fully-migrated
 * schema, and the whole point of observation 1 is that it happened before 0143 existed.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal, type Tx } from '@shareat/db';
import { assignRole, AuthorizationError, type Actor } from '@shareat/auth';
import { postEntry, type PeriodOverride } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

function postEntryAsOrg(orgId: string, input: Omit<Parameters<typeof postEntry>[1], 'orgId'>) {
  return withOrgPrincipal(orgId, (tx: Tx) => postEntry(tx, { orgId, ...input }));
}

async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the promise to reject, but it resolved');
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`period-override-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  return row!.id;
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  status: 'open' | 'closed' | 'locked',
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, ${status})
    returning id
  `;
  return row!.id;
}

/** Raw-SQL role insert — for fixtures where the elevation mechanism (`assignRole`) is not what's
 *  under test. Test 6 uses `assignRole` itself, deliberately, to prove the real mechanism. */
async function insertPerson(orgId: string, name: string, role: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  return p!.id;
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function overrideRowsFor(orgId: string): Promise<
  { entryId: string; actorPersonId: string; reason: string; periodStatusAtPost: string }[]
> {
  const rows = await sql<
    { entry_id: string; actor_person_id: string; reason: string; period_status_at_post: string }[]
  >`
    select entry_id, actor_person_id, reason, period_status_at_post
    from period_overrides where org_id = ${orgId}
  `;
  return rows.map((r) => ({
    entryId: r.entry_id,
    actorPersonId: r.actor_person_id,
    reason: r.reason,
    periodStatusAtPost: r.period_status_at_post,
  }));
}

function lines() {
  return [
    { accountCode: '6900', debit: '10.00' },
    { accountCode: '1110', credit: '10.00' },
  ];
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-264 slice 3 — observation 2: exemption exists, NO flag set, still refused identically', () => {
  it('throws the same message as the pre-0143 baseline', async () => {
    const orgId = await insertOrg('obs2');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');

    const msg = await rejectionMessage(
      postEntryAsOrg(orgId, {
        entryDate: '2026-02-15',
        sourceType: 'test',
        sourceId: uid('obs2'),
        idempotencyKey: uid('obs2-key'),
        lines: lines(),
      }),
    );

    expect(msg).toContain(periodId);
    expect(msg).toMatch(/is closed/i);
    expect(msg).not.toMatch(/locked/i);
  });
});

describe('T-264 slice 3 — observation 3: a manager attempting the override is refused by authorize(), not the database', () => {
  it('throws AuthorizationError and writes no period_overrides row', async () => {
    const orgId = await insertOrg('obs3');
    await seedChartOfAccounts(sql, orgId);
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');
    // An active admin exists so the manager below is NOT elevated by the adminless fallback —
    // this test must prove an ORDINARY manager is refused, not accidentally exercise row 196.
    await insertPerson(orgId, 'Admin', 'admin');
    const managerId = await insertPerson(orgId, 'Manager', 'manager');

    const periodOverride: PeriodOverride = {
      actor: actor(orgId, managerId),
      reason: 'data_entry_error',
    };

    await expect(
      postEntryAsOrg(orgId, {
        entryDate: '2026-02-15',
        sourceType: 'test',
        sourceId: uid('obs3'),
        idempotencyKey: uid('obs3-key'),
        lines: lines(),
        periodOverride,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    expect(await overrideRowsFor(orgId)).toEqual([]);
  });
});

describe('T-264 slice 3 — admin override succeeds', () => {
  it('posts the entry and writes exactly one period_overrides row', async () => {
    const orgId = await insertOrg('admin-ok');
    await seedChartOfAccounts(sql, orgId);
    const periodId = await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');
    const adminId = await insertPerson(orgId, 'Admin', 'admin');

    const result = await postEntryAsOrg(orgId, {
      entryDate: '2026-02-15',
      sourceType: 'test',
      sourceId: uid('admin-ok'),
      idempotencyKey: uid('admin-ok-key'),
      lines: lines(),
      periodOverride: { actor: actor(orgId, adminId), reason: 'late_supplier_invoice' },
    });

    expect(result.created).toBe(true);
    const [entryRow] = await sql<{ period_id: string; status: string }[]>`
      select period_id, status from journal_entries where id = ${result.entryId}
    `;
    expect(entryRow!.period_id).toBe(periodId);
    expect(entryRow!.status).toBe('posted');

    const rows = await overrideRowsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: result.entryId,
      actorPersonId: adminId,
      reason: 'late_supplier_invoice',
      periodStatusAtPost: 'closed',
    });
  });
});

describe('T-264 slice 3 — super_admin override succeeds (the matrix cell, not just the derived set)', () => {
  it('posts the entry and writes the audit row', async () => {
    const orgId = await insertOrg('superadmin-ok');
    await seedChartOfAccounts(sql, orgId);
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');
    const superAdminId = await insertPerson(orgId, 'Super Admin', 'super_admin');

    const result = await postEntryAsOrg(orgId, {
      entryDate: '2026-02-15',
      sourceType: 'test',
      sourceId: uid('superadmin-ok'),
      idempotencyKey: uid('superadmin-ok-key'),
      lines: lines(),
      periodOverride: { actor: actor(orgId, superAdminId), reason: 'regulatory_correction' },
    });

    expect(result.created).toBe(true);
    const rows = await overrideRowsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('regulatory_correction');
  });
});

describe('T-264 slice 3 — bible row 196: an elevated manager in an adminless org DOES pass', () => {
  it('proves the ruling live through postEntry, not only through the capability-matrix test', async () => {
    const orgId = await insertOrg('elevated-mgr');
    await seedChartOfAccounts(sql, orgId);
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Adminless-org Manager') returning id
    `;
    const managerId = person!.id;
    // The REAL mechanism, not a hand-simulated grant row — this org has no admin or super_admin
    // at all, so assignRole's own hasActiveAdmin check fires the ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER
    // fallback, which includes override_period_lock (tests/unit/capability-matrix.test.ts).
    await withOrgPrincipal(orgId, (tx) =>
      assignRole(tx, { personId: managerId, orgId, role: 'manager', grantedBy: null }),
    );

    const result = await postEntryAsOrg(orgId, {
      entryDate: '2026-02-15',
      sourceType: 'test',
      sourceId: uid('elevated-mgr'),
      idempotencyKey: uid('elevated-mgr-key'),
      lines: lines(),
      periodOverride: { actor: actor(orgId, managerId), reason: 'data_entry_error' },
    });

    expect(result.created).toBe(true);
    expect(await overrideRowsFor(orgId)).toHaveLength(1);
  });
});

describe('T-264 slice 3 — locked periods are refused with a DISTINCT message, override or not', () => {
  it('throws a message naming "locked" and that the override does not apply, never the generic "not open" text', async () => {
    const orgId = await insertOrg('locked');
    await seedChartOfAccounts(sql, orgId);
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'locked');
    const superAdminId = await insertPerson(orgId, 'Super Admin', 'super_admin');

    const msg = await rejectionMessage(
      postEntryAsOrg(orgId, {
        entryDate: '2026-02-15',
        sourceType: 'test',
        sourceId: uid('locked'),
        idempotencyKey: uid('locked-key'),
        lines: lines(),
        periodOverride: { actor: actor(orgId, superAdminId), reason: 'regulatory_correction' },
      }),
    );

    expect(msg).toMatch(/locked/i);
    expect(msg).toMatch(/does not apply to locked periods/i);
    // Distinct from the plain "is closed"/"is <status>" refusal in observation 2/test 10 — this
    // is what makes the two failure modes tell-apart-able from the message alone.
    expect(msg).not.toMatch(/\(status = /i);
    expect(await overrideRowsFor(orgId)).toEqual([]);
  });
});

describe('T-264 slice 3 — what a row MEANS: periodOverride on an ALREADY-OPEN period', () => {
  it('still authorizes and still writes a row, with period_status_at_post = open', async () => {
    const orgId = await insertOrg('already-open');
    await seedChartOfAccounts(sql, orgId);
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'open');
    const adminId = await insertPerson(orgId, 'Admin', 'admin');

    const result = await postEntryAsOrg(orgId, {
      entryDate: '2026-02-15',
      sourceType: 'test',
      sourceId: uid('already-open'),
      idempotencyKey: uid('already-open-key'),
      lines: lines(),
      periodOverride: { actor: actor(orgId, adminId), reason: 'late_supplier_invoice' },
    });

    expect(result.created).toBe(true);
    const rows = await overrideRowsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.periodStatusAtPost).toBe('open');

    // And an unauthorized actor is STILL refused even though the period was never going to be
    // bypassed — the capability is checked whenever periodOverride is invoked, full stop.
    const staffId = await insertPerson(orgId, 'Staff', 'staff');
    await expect(
      postEntryAsOrg(orgId, {
        entryDate: '2026-02-16',
        sourceType: 'test',
        sourceId: uid('already-open-staff'),
        idempotencyKey: uid('already-open-staff-key'),
        lines: lines(),
        periodOverride: { actor: actor(orgId, staffId), reason: 'late_supplier_invoice' },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("T-264 slice 3 — reason = 'other' with no note is rejected at the database", () => {
  it('names the CHECK constraint, and the whole transaction (entry included) rolls back', async () => {
    const orgId = await insertOrg('other-no-note');
    await seedChartOfAccounts(sql, orgId);
    await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'closed');
    const adminId = await insertPerson(orgId, 'Admin', 'admin');
    const sourceId = uid('other-no-note');

    const msg = await rejectionMessage(
      postEntryAsOrg(orgId, {
        entryDate: '2026-02-15',
        sourceType: 'test',
        sourceId,
        idempotencyKey: uid('other-no-note-key'),
        lines: lines(),
        // 'other' with no note type-checks fine (TypeScript can't express "note required only
        // when reason = 'other'" without a discriminated union) — the refusal is a runtime CHECK
        // constraint, deliberately, per docs/plans/264-slice3-plan.md's schema section.
        periodOverride: { actor: actor(orgId, adminId), reason: 'other' },
      }),
    );

    expect(msg).toMatch(/period_overrides_other_needs_note_check/);
    const entries = await sql`select id from journal_entries where source_type = 'test' and source_id = ${sourceId}`;
    expect(entries).toHaveLength(0);
  });
});
