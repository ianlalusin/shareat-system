import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-385 S1 - `docs/tasks/385-verify-only-after-submit.md`, "S1 tests" V1-V7. Ian 2026-10-09: "verify and post must be
 * blocked until submitted". A sales day is verified only from `submitted`; the domain says so in a plain sentence and
 * `salesDaysRepo.markVerified` narrows its WHERE to match (defence in depth).
 *
 * ## State at HEAD (red first)
 * V1 (an open day verifies and posts), V6 (`markVerified` accepts an open row) and V7's first half are RED today:
 * `runVerify` refuses only `voided`. V2-V5 are controls and pass today (V4 and V5 are the ordering guards: the R1 check
 * must come after the voided refusal and after `authorize`).
 *
 * Mutants (spec): drop the R1 check -> V1, V7 red. R1 placed before the voided branch -> V4 red (sentence differs).
 * R1 moved above `authorize` -> V5 red (a refusal instead of AuthorizationError). `markVerified` WHERE back to
 * `UNVERIFIED_STATUSES` -> V6 red.
 *
 * The submitter and the verifier are different people throughout (S3 is in this task: a submitter may not verify their
 * own day), so V2/V3/V7 submit as the admin and verify as the manager.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, salesDaysRepo, RefusalError } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as D from '@shareat/domain';
import { importTestDay } from './_fixtures/pos-day';
import { asOrgOn, DAY, s6Fixture } from './_fixtures/pos-s6';
import { mkTypedDay, submitThenVerify } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const NOT_SUBMITTED = "This sales day hasn't been submitted yet. Submit it first; it can be verified and posted after that.";
const VOIDED = "This sales day has been voided, so it can't be posted.";

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
  const f = await s6Fixture(sql, `t385s1-${hint}`);
  const typed = await mkTypedDay(sql, f, [f.managerId, f.adminId, f.plainStaffId]);
  return { f, dayId: typed.id, storeId: typed.storeId };
}
const dayRow = async (id: string) =>
  (await sql<{ status: string; verified_by: string | null; journal_entry_id: string | null }[]>`
    select status, verified_by, journal_entry_id from sales_days where id = ${id}`)[0]!;
const entryCount = async (id: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where source_id = ${id}`)[0]!.n;

describe('T-385 S1 - verifySalesDay requires a submitted day', () => {
  it('V1: an OPEN day verified by a manager is refused with the plain sentence; the day stays open, nothing is posted', async () => {
    const { f, dayId } = await setup('v1');
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId)));
    expect(userMessage(err)).toBe(NOT_SUBMITTED);
    const row = await dayRow(dayId);
    expect(row.status).toBe('open');
    expect(row.verified_by).toBeNull();
    expect(await entryCount(dayId), 'no journal entry may exist for an unsubmitted day').toBe(0);
  });

  it('V2: a SUBMITTED day verifies and posts (control)', async () => {
    const { f, dayId } = await setup('v2');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.admin, dayId));
    const res = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
    expect(res.created).toBe(true);
    expect((await dayRow(dayId)).status).toBe('verified');
    expect(await entryCount(dayId)).toBe(1);
  });

  it('V3: re-verifying a VERIFIED day is a safe no-op: created false, the same entry, still one entry (control)', async () => {
    const { f, dayId } = await setup('v3');
    const first = await asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, dayId, f.admin));
    const again = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
    expect(again.created).toBe(false);
    expect(again.journalEntryId).toBe(first.journalEntryId);
    expect(await entryCount(dayId)).toBe(1);
  });

  it('V4: a VOIDED day keeps the existing voided sentence (the new check must not mask it)', async () => {
    const { f, dayId } = await setup('v4');
    await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, dayId, 'Entered wrong'));
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId)));
    expect(userMessage(err)).toBe(VOIDED);
  });

  it('V5: an OPEN day verified by someone WITHOUT verify_sales_day is an AuthorizationError (authorize still runs first)', async () => {
    const { f, dayId } = await setup('v5');
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.plainStaff, dayId)));
    expect(err).toBeInstanceOf(AuthorizationError);
  });

  it('V6: the repo refuses too - markVerified on an OPEN row finds no row to move and the row is unchanged', async () => {
    const { f, dayId } = await setup('v6');
    // a real entry id to hand over (any verified day's), so the only thing that can refuse the call is the status guard
    const other = await mkTypedDay(sql, f, [f.managerId, f.adminId], '2027-01-11');
    const posted = await asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, other.id, f.admin));
    const err = await rejection(
      asOrgOn(f.orgId, (tx) =>
        salesDaysRepo.markVerified(tx, f.orgId, dayId, { verifiedBy: f.managerId, journalEntryId: posted.journalEntryId }),
      ),
    );
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as Error).message).toMatch(/not submitted/);
    const row = await dayRow(dayId);
    expect(row.status).toBe('open');
    expect(row.verified_by).toBeNull();
    expect(row.journal_entry_id).toBeNull();
  });

  it('V7: a POS-feed day imported OPEN is refused; once submitted it posts', async () => {
    const f = await s6Fixture(sql, 't385s1-v7');
    const { id } = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: DAY }));
    expect((await dayRow(id)).status).toBe('open');
    const err = await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, id)));
    expect(userMessage(err)).toBe(NOT_SUBMITTED);
    expect(await entryCount(id)).toBe(0);

    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.admin, id));
    const res = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, id));
    expect(res.created).toBe(true);
    expect((await dayRow(id)).status).toBe('verified');
  });
});
