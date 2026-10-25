import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-475 S3 (TESTER) - verifyInvoice lets an ADMIN verify the invoice they logged themselves.
 * docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md 5.2 + R4 + R10 + "Ian's answers" Q2=B (a job-logged invoice in the admin's
 * name is verifiable, flagged, audited), Q3=A (role only; a person grant never confers it), Q4=A.
 *
 * What it pins, against real Postgres through the real domain functions:
 *  - the capability holder (admin / super_admin) who created the invoice: verified, `self_verified` true, `verified_by` = the creator,
 *    TWO audit rows (`ap_invoice.approved` then `ap_invoice.self_verified` with after.selfVerified = true);
 *  - everyone else is unchanged: a manager creator gets the V1 refusal (R16 sentence, verbatim) and the invoice stays pending;
 *    a non-creator verifies with the flag FALSE and no self row (mutant: flag set for everyone);
 *  - the exemption removes ONLY the "you logged it" refusal: ticks, inactive supplier, no photo, unmapped draft, LOCKED month each still
 *    refuse the admin creator (mutant: exemption skips the draft loop / the other checks), with nothing flagged and nothing posted;
 *  - Q2=B: the admin who is the template author verifies the invoice the recurring job logged in their name;
 *  - R4: the flag comes ONLY from `can()` inside verifyInvoice - extra request-shaped fields never set it.
 *
 * RED TODAY: HEAD refuses any creator with the V1 sentence and `self_verified` does not exist, so every leg fails - the admin-creator legs
 * on the refusal, the control/refusal legs on the missing column their assertions read. Each refusal leg also pins the sentence, so a
 * green run means the right refusal came from the right check.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { catalogueEntry, closeDb } from '@shareat/db';
import { verifyInvoice } from '@shareat/domain';
import { ap475Fixture, asOrg, uid, type Fixture } from './_fixtures/t475-ap';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ATTEST = { supplier: true, invoice: true, items: true, price: true };
const V1_SENTENCE = 'You logged this invoice, so you cannot also verify it. Verification is a second pair of eyes — ask a manager who did not enter it, or an admin.';
const APPROVED = 'ap_invoice.approved';
const SELF = 'ap_invoice.self_verified';

type Actor = Fixture['admin'];
const verify = (f: Fixture, who: Actor, id: string, attest: Record<string, unknown> = ATTEST, options?: Record<string, unknown>) =>
  asOrg(f.orgId, (tx) => verifyInvoice(tx, who, id, attest as typeof ATTEST, options as never));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage };
  }
  throw new Error(`NOT REFUSED - ${what} went through instead`);
}

const inv = async (id: string) =>
  (await sql<{ status: string; verified_by: string | null; created_by: string; self_verified: boolean }[]>`
    select status, verified_by, created_by, self_verified from supplier_invoices where id = ${id}`)[0]!;
const expenseStatus = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;
const audit = (orgId: string, action: string, entityId: string) =>
  sql<{ action: string; actor_person_id: string; store_id: string | null; entity_id: string; before: unknown; after: Record<string, unknown> }[]>`
    select action, actor_person_id, store_id, entity_id, before, after from audit_log
    where org_id = ${orgId} and action = ${action} and entity_id = ${entityId} order by recorded_at, id`;

/** Nothing happened: still pending, not flagged, no verifier, no audit row of either kind. */
async function expectUntouched(f: Fixture, id: string, drafts: string[] = []) {
  expect(await inv(id)).toMatchObject({ status: 'pending', verified_by: null, self_verified: false });
  for (const d of drafts) expect(await expenseStatus(d)).toBe('draft');
  expect(await audit(f.orgId, APPROVED, id)).toHaveLength(0);
  expect(await audit(f.orgId, SELF, id)).toHaveLength(0);
}

// ----------------------------------------------------------------------------------------------- the audit catalogue

describe('S3-A - the catalogue knows the new action', () => {
  it('ap_invoice.self_verified: money, high sensitivity, store scope, entity ap_invoices, owner T-475. Mutant: not catalogued / wrong class', () => {
    const e = catalogueEntry(SELF);
    expect(e, 'RED today: ap_invoice.self_verified is not in the audit catalogue').toBeDefined();
    expect(e).toMatchObject({ category: 'money', sensitivity: 'high', scope: 'store', entity: 'ap_invoices', owner: 'T-475', reserved: false });
  });
});

// ----------------------------------------------------------------------------------------------- the holder

describe('S3-B - the admin who logged it verifies it', () => {
  it('B1: verified; verified_by = creator; self_verified true; a draft against it is posted; TWO audit rows in order approved then self_verified. Mutants: flag not stamped; second row missing; wrong store/actor', async () => {
    const f = await ap475Fixture(sql, 'b1');
    const id = await f.invoice();
    const draftId = await f.draft(id, { amount: '1200.00' });
    await verify(f, f.admin, id);

    expect(await inv(id)).toMatchObject({ status: 'verified', verified_by: f.adminId, created_by: f.adminId, self_verified: true });
    expect(await expenseStatus(draftId), 'every remaining check ran, including the draft loop').toBe('posted');

    const approved = await audit(f.orgId, APPROVED, id);
    const self = await audit(f.orgId, SELF, id);
    expect(approved, 'the existing verification event still written once').toHaveLength(1);
    expect(approved[0]!.after).toMatchObject({ status: 'verified', draftsPosted: 1 });
    expect(self, 'RED today: no ap_invoice.self_verified row').toHaveLength(1);
    expect(self[0]).toMatchObject({ action: SELF, actor_person_id: f.adminId, store_id: f.storeId, entity_id: id });
    expect(self[0]!.after).toMatchObject({ selfVerified: true });

    const order = await sql<{ action: string }[]>`
      select action from audit_log where org_id = ${f.orgId} and entity_id = ${id} and action in (${APPROVED}, ${SELF}) order by recorded_at, id`;
    expect(order.map((r) => r.action), 'the self row follows the approved row').toEqual([APPROVED, SELF]);
  });

  it('B2: a super_admin who logged it verifies it too (positive control for the second holding role)', async () => {
    const f = await ap475Fixture(sql, 'b2');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Super') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'super_admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    const id = await f.invoice({ createdBy: p!.id });
    await verify(f, { orgId: f.orgId, personId: p!.id }, id);
    expect(await inv(id)).toMatchObject({ status: 'verified', verified_by: p!.id, self_verified: true });
    expect(await audit(f.orgId, SELF, id)).toHaveLength(1);
  });

  it('B3 (Q2=B): the admin who is the TEMPLATE AUTHOR verifies the invoice the recurring job logged in their name: verified, flagged, both audit rows. Mutant: job-logged invoices excluded', async () => {
    const f = await ap475Fixture(sql, 'b3');
    const id = await f.invoice({ createdBy: f.adminId });
    const [tpl] = await sql<{ id: string }[]>`
      insert into recurring_expenses (org_id, store_id, name, category_id, supplier_id, default_amount, interval, anchor_day, next_due_date, created_by)
      values (${f.orgId}, ${f.storeId}, 'Lipa rent', ${f.categoryId}, ${f.supplierId}, '5000.00', 'monthly', 10, '2026-02-10', ${f.adminId}) returning id`;
    await sql`insert into recurring_expense_drafts (org_id, recurring_expense_id, due_date, supplier_invoice_id) values (${f.orgId}, ${tpl!.id}, '2026-01-10', ${id})`;

    await verify(f, f.admin, id);

    expect(await inv(id)).toMatchObject({ status: 'verified', verified_by: f.adminId, self_verified: true });
    expect(await audit(f.orgId, APPROVED, id)).toHaveLength(1);
    expect(await audit(f.orgId, SELF, id), 'flagged and audited like any self-verify').toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------------------------- everyone else unchanged

describe('S3-C - everyone else is unchanged', () => {
  it('C1: a MANAGER who logged it gets the V1 refusal (R16 sentence, verbatim); pending, no flag, no audit row. Control: an admin other than the creator then verifies it. Mutant: exemption for anyone', async () => {
    const f = await ap475Fixture(sql, 'c1');
    const id = await f.invoice({ createdBy: f.managerId });
    const refused = await rejection(verify(f, f.manager, id), 'a manager verifying the invoice they logged');
    expect(refused.userMessage, `wrong refusal: ${refused.message}`).toBe(V1_SENTENCE);
    await expectUntouched(f, id);

    await verify(f, f.verifier, id);
    expect(await inv(id)).toMatchObject({ status: 'verified', verified_by: f.verifierId, self_verified: false });
  });

  it('C2: a STAFF member who logged it is refused (they cannot verify at all - the authorization refusal, not the flag path)', async () => {
    const f = await ap475Fixture(sql, 'c2');
    const id = await f.invoice({ createdBy: f.staffId });
    await rejection(verify(f, f.staff, id), 'staff verifying');
    await expectUntouched(f, id);
  });

  it('C3: a NON-creator (a second admin) verifies: verified, self_verified FALSE, NO ap_invoice.self_verified row, one approved row. Mutant: flag set for everyone', async () => {
    const f = await ap475Fixture(sql, 'c3');
    const id = await f.invoice();
    await verify(f, f.verifier, id);
    expect(await inv(id)).toMatchObject({ status: 'verified', verified_by: f.verifierId, created_by: f.adminId, self_verified: false });
    expect(await audit(f.orgId, APPROVED, id)).toHaveLength(1);
    expect(await audit(f.orgId, SELF, id), 'a second pair of eyes is not a self-verify').toHaveLength(0);
  });

  it('C4: a manager (non-creator) verifies: flag false, no self row (positive control for the manager path)', async () => {
    const f = await ap475Fixture(sql, 'c4');
    const id = await f.invoice();
    await verify(f, f.manager, id);
    expect(await inv(id)).toMatchObject({ status: 'verified', verified_by: f.managerId, self_verified: false });
    expect(await audit(f.orgId, SELF, id)).toHaveLength(0);
  });

  it('C5 (Q3=A): a manager who logged it and holds a PERSON GRANT of the capability still gets the V1 refusal. Mutant: grant honoured', async () => {
    const f = await ap475Fixture(sql, 'c5');
    await sql`insert into person_grants (person_id, grant_name, grant_source) values (${f.managerId}, 'verify_own_supplier_invoice', 'grant')`;
    const id = await f.invoice({ createdBy: f.managerId });
    const refused = await rejection(verify(f, f.manager, id), 'a manager with a person grant verifying their own invoice');
    expect(refused.userMessage, `wrong refusal: ${refused.message}`).toBe(V1_SENTENCE);
    await expectUntouched(f, id);
  });
});

// ----------------------------------------------------------------------------------------------- the exemption is narrow

describe('S3-D - the exemption removes ONLY the "you logged it" refusal; every other check still binds the admin creator', () => {
  it('D1: a draft in a LOCKED month: refused, invoice pending, draft still draft, no flag, no audit row. Control: an unlocked sibling verifies. Mutant: exemption skips the draft loop', async () => {
    const f = await ap475Fixture(sql, 'd1');
    const okInvoice = await f.invoice({ on: '2026-01-12' });
    const okDraft = await f.draft(okInvoice, { on: '2026-01-12', amount: '300.00' });
    const id = await f.invoice();
    const draftId = await f.draft(id, { amount: '1200.00' });

    await verify(f, f.admin, okInvoice);
    expect(await inv(okInvoice)).toMatchObject({ status: 'verified', self_verified: true });
    expect(await expenseStatus(okDraft)).toBe('posted');

    await f.setPeriod('2026-01-01', 'locked');
    const refused = await rejection(verify(f, f.admin, id), 'an admin self-verifying an invoice with a draft in a locked month');
    expect(refused.userMessage, 'a presentable sentence, no uuid').toBeTruthy();
    expect(refused.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(refused.userMessage, 'the locked-month sentence, not the V1 refusal').not.toBe(V1_SENTENCE);
    await expectUntouched(f, id, [draftId]);
  });

  it('D2: an UNMAPPED draft (no GL account): refused, pending, no flag. Mutant: exemption skips approveExpense', async () => {
    const f = await ap475Fixture(sql, 'd2');
    const id = await f.invoice();
    const draftId = await f.draft(id, { categoryId: await f.unmappedCategory(), amount: '400.00' });
    const refused = await rejection(verify(f, f.admin, id), 'an admin self-verifying an invoice with an unmapped draft');
    expect(refused.userMessage).not.toBe(V1_SENTENCE);
    await expectUntouched(f, id, [draftId]);
  });

  it('D3: an INACTIVE supplier: refused, pending, no flag', async () => {
    const f = await ap475Fixture(sql, 'd3');
    const supplierId = await f.supplier({ status: 'inactive' });
    const id = await f.invoice({ supplierId });
    const refused = await rejection(verify(f, f.admin, id), 'an admin self-verifying for an inactive supplier');
    expect(refused.userMessage).not.toBe(V1_SENTENCE);
    await expectUntouched(f, id);
  });

  it('D4: NO receipt photo: refused, pending, no flag', async () => {
    const f = await ap475Fixture(sql, 'd4');
    const id = await f.invoice({ receiptFileId: null });
    const refused = await rejection(verify(f, f.admin, id), 'an admin self-verifying with no photo');
    expect(refused.userMessage).not.toBe(V1_SENTENCE);
    await expectUntouched(f, id);
  });

  it('D5: an unticked box (price): refused, pending, no flag. Mutant: attestation skipped for the exempt path', async () => {
    const f = await ap475Fixture(sql, 'd5');
    const id = await f.invoice();
    const refused = await rejection(verify(f, f.admin, id, { ...ATTEST, price: false }), 'an admin self-verifying with a box unticked');
    expect(refused.userMessage).not.toBe(V1_SENTENCE);
    await expectUntouched(f, id);
  });

  it('D6: an already-verified invoice cannot be verified again by its creator (status check precedes): refused, flag unchanged', async () => {
    const f = await ap475Fixture(sql, 'd6');
    const id = await f.invoice();
    await verify(f, f.admin, id);
    await rejection(verify(f, f.admin, id), 'verifying twice');
    expect((await audit(f.orgId, SELF, id)).length, 'still exactly one self row').toBe(1);
  });
});

// ----------------------------------------------------------------------------------------------- R4: the flag is never request-supplied

describe('R4 - the flag comes ONLY from can() inside verifyInvoice', () => {
  it('extra request-shaped fields (selfVerified on the attestation and on the options) from a NON-creator manager and from a NON-creator admin leave the flag false and write no self row. Mutant: a caller argument sets it', async () => {
    const f = await ap475Fixture(sql, 'r4');
    const a = await f.invoice();
    await verify(f, f.manager, a, { ...ATTEST, selfVerified: true }, { selfVerified: true });
    expect(await inv(a)).toMatchObject({ status: 'verified', self_verified: false });
    const b = await f.invoice();
    await verify(f, f.verifier, b, { ...ATTEST, selfVerified: 'on' }, { selfVerified: true });
    expect(await inv(b)).toMatchObject({ status: 'verified', self_verified: false });
    expect(await audit(f.orgId, SELF, a)).toHaveLength(0);
    expect(await audit(f.orgId, SELF, b)).toHaveLength(0);
  });

  it('a MANAGER creator passing selfVerified: true is still refused with the V1 sentence (the argument does not open the door)', async () => {
    const f = await ap475Fixture(sql, 'r4b');
    const id = await f.invoice({ createdBy: f.managerId });
    const refused = await rejection(verify(f, f.manager, id, { ...ATTEST, selfVerified: true }, { selfVerified: true }), 'a manager forcing the flag');
    expect(refused.userMessage).toBe(V1_SENTENCE);
    await expectUntouched(f, id);
  });
});
