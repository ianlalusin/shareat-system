import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-385 S3 - `docs/tasks/385-verify-only-after-submit.md` S3, answered by Ian 2026-10-09 (t385-q1 = a): the person who
 * SUBMITTED a sales day is refused when they try to VERIFY it, with a plain sentence - EXCEPT a super-admin, who may
 * verify their own submission (capability `verify_own_sales_day`, super-admin only, decided by `authorize()`).
 *
 * ## State at HEAD (red first)
 * W1 and W1b are RED today (`runVerify` has no segregation rule, so a submitter verifies their own day). W2 and W3 are
 * controls and must stay green: a different person verifies; a super-admin verifies their own. W3b (an admin holding all
 * the owner grants) is green today and pins the equivalence once the capability exists. W5 pins the ORDER of checks
 * (I4): authorize first, then the voided/submitted rules, then R3.
 *
 * Mutants (spec): drop R3 -> W1, W1b red. Exemption dropped -> W3 red. R3 placed above `authorize` -> W5 red.
 *
 * The refusal happens in the same transaction as the verify, so a refused verify leaves the day SUBMITTED (it is not
 * rolled back to open): the submit was committed by its own transaction.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as D from '@shareat/domain';
import { actorOf, asOrgOn, s6Fixture } from './_fixtures/pos-s6';
import { mkTypedDay } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const OWN_DAY = 'You submitted this day, so someone else has to verify it.';
const OWNER_GRANTS = [
  'approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos', 'verify_own_sales_day',
];

const userMessage = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
const rejection = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('NOT REFUSED - the call succeeded (the defect this leg targets)');
};

async function setup(hint: string) {
  const f = await s6Fixture(sql, `t385s3-${hint}`);
  const mk = async (name: string, role: string, grants: string[] = []) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, ${role})`;
    for (const g of grants) await sql`insert into person_grants (person_id, grant_name, grant_source) values (${p!.id}, ${g}, 'owner')`;
    return p!.id;
  };
  const superId = await mk('Owner', 'super_admin');
  const ownerAdminId = await mk('Owner-equivalent admin', 'admin', OWNER_GRANTS);
  const typed = await mkTypedDay(sql, f, [f.managerId, f.adminId, f.plainStaffId, superId, ownerAdminId]);
  return { f, dayId: typed.id, superAdmin: actorOf(f.orgId, superId), ownerAdmin: actorOf(f.orgId, ownerAdminId) };
}
const dayRow = async (id: string) =>
  (await sql<{ status: string; submitted_by: string | null; verified_by: string | null }[]>`
    select status, submitted_by, verified_by from sales_days where id = ${id}`)[0]!;
const entryCount = async (id: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where source_id = ${id}`)[0]!.n;

describe('T-385 S3 - the submitter may not verify their own day (except a super-admin)', () => {
  it('W1: a manager submits a day, then tries to verify it -> refused with the plain sentence; no entry; the day stays submitted', async () => {
    const { f, dayId } = await setup('w1');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, dayId));
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId)));
    expect(userMessage(err)).toBe(OWN_DAY);
    const row = await dayRow(dayId);
    expect(row.status).toBe('submitted');
    expect(row.submitted_by).toBe(f.managerId);
    expect(row.verified_by).toBeNull();
    expect(await entryCount(dayId), 'a refused verify posts nothing').toBe(0);
  });

  it('W1b: an ADMIN who submitted a day is refused too - being an admin is not the exemption', async () => {
    const { f, dayId } = await setup('w1b');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.admin, dayId));
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.admin, dayId)));
    expect(userMessage(err)).toBe(OWN_DAY);
    expect((await dayRow(dayId)).status).toBe('submitted');
    expect(await entryCount(dayId)).toBe(0);
  });

  it('W2: a DIFFERENT person with verify rights verifies the same day and it posts (control)', async () => {
    const { f, dayId } = await setup('w2');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, dayId));
    const res = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.admin, dayId));
    expect(res.created).toBe(true);
    const row = await dayRow(dayId);
    expect(row.status).toBe('verified');
    expect(row.submitted_by).toBe(f.managerId);
    expect(row.verified_by).toBe(f.adminId);
    expect(await entryCount(dayId)).toBe(1);
  });

  it('W3: a SUPER-ADMIN may verify their own submission (the exemption; control that must stay green)', async () => {
    const { f, dayId, superAdmin } = await setup('w3');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, superAdmin, dayId));
    const res = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, superAdmin, dayId));
    expect(res.created).toBe(true);
    const row = await dayRow(dayId);
    expect(row.status).toBe('verified');
    expect(row.submitted_by).toBe(superAdmin.personId);
    expect(row.verified_by).toBe(superAdmin.personId);
  });

  it('W3b: an admin holding the full owner grant set (the super-admin equivalence, incl. verify_own_sales_day) may too', async () => {
    const { f, dayId, ownerAdmin } = await setup('w3b');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, ownerAdmin, dayId));
    const res = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, ownerAdmin, dayId));
    expect(res.created).toBe(true);
    expect((await dayRow(dayId)).status).toBe('verified');
  });

  it('W5: the submitter WITHOUT verify_sales_day gets an AuthorizationError, not the own-day sentence (authorize runs first)', async () => {
    const { f, dayId } = await setup('w5');
    // a manager-submitted day; a plain staff member never submitted it, but the point is the error CLASS for someone who
    // may not verify at all: authorize decides before any day-specific rule
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, dayId));
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.plainStaff, dayId)));
    expect(err).toBeInstanceOf(AuthorizationError);
  });

  it('W6: re-verifying a day you submitted AND that is already verified (by a super-admin) is still the safe no-op', async () => {
    const { f, dayId, superAdmin } = await setup('w6');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, dayId));
    const first = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, superAdmin, dayId));
    // the original submitter asks again: the no-op branch comes before the own-day rule (I4), so nothing is refused
    const again = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
    expect(again.created).toBe(false);
    expect(again.journalEntryId).toBe(first.journalEntryId);
  });
});
