import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-475 S3 (TESTER) - the review list: `?selfVerified=1` on /ap returns ONLY the invoices verified by their own creator, of the actor's org.
 * docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md 5.4 + R16 (`apps/erp/src/app/ap/lib.ts` listInvoices passes the new filter).
 * Two layers, one fixture: `apRepo.listSupplierInvoices(tx, orgId, { selfVerified: true })` and the page helper `listInvoices(orgId, { selfVerified: true })`.
 * Flagged rows are made the REAL way (an admin verifying the invoice they logged, through verifyInvoice), so the legs also prove the write path.
 *
 * RED TODAY: the filter does not exist (the repo ignores it, so the list returns every row) and the flag cannot be written (HEAD refuses the self-verify).
 * Mutants: filter ignored -> L1 red; filter not org-scoped -> L2 red; filter returns verified rows regardless of the flag -> L1 red;
 * `selfVerified: undefined` must NOT filter (L3 control).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { apRepo, closeDb } from '@shareat/db';
import { verifyInvoice } from '@shareat/domain';
import { ap475Fixture, asOrg } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { listInvoices } from '../../src/app/ap/lib';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ATTEST = { supplier: true, invoice: true, items: true, price: true };

/** In one org: two self-verified (admin A), one verified by a second admin, one pending. */
async function seed(hint: string) {
  const f = await ap475Fixture(sql, hint);
  const selfA = await f.invoice();
  const selfB = await f.invoice({ on: '2026-01-11' });
  const other = await f.invoice({ on: '2026-01-12' });
  const pending = await f.invoice({ on: '2026-01-13' });
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.admin, selfA, ATTEST));
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.admin, selfB, ATTEST));
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, other, ATTEST));
  return { f, selfA, selfB, other, pending };
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('T-475 S3 - ?selfVerified=1 (the repo)', () => {
  it('L1: returns only flagged rows (the two self-verified), not the second-pair-of-eyes row, not the pending one. Mutant: filter ignored', async () => {
    const { f, selfA, selfB, other, pending } = await seed('l1');
    const rows = await asOrg(f.orgId, (tx) => apRepo.listSupplierInvoices(tx, f.orgId, { selfVerified: true }));
    expect(ids(rows), `got ${ids(rows).join(',')}`).toEqual([selfA, selfB].sort());
    expect(ids(rows)).not.toContain(other);
    expect(ids(rows)).not.toContain(pending);
  });

  it('L3 control: without the filter every row of the org comes back (4), and selfVerified: undefined filters nothing', async () => {
    const { f } = await seed('l3');
    const all = await asOrg(f.orgId, (tx) => apRepo.listSupplierInvoices(tx, f.orgId, {}));
    const undef = await asOrg(f.orgId, (tx) => apRepo.listSupplierInvoices(tx, f.orgId, { selfVerified: undefined }));
    expect(all).toHaveLength(4);
    expect(undef).toHaveLength(4);
  });

  it('L2: another org flagged rows never appear for this org (and vice versa). Mutant: filter not org-scoped', async () => {
    const a = await seed('l2a');
    const b = await seed('l2b');
    const rowsA = await asOrg(a.f.orgId, (tx) => apRepo.listSupplierInvoices(tx, a.f.orgId, { selfVerified: true }));
    const rowsB = await asOrg(b.f.orgId, (tx) => apRepo.listSupplierInvoices(tx, b.f.orgId, { selfVerified: true }));
    expect(ids(rowsA)).toEqual([a.selfA, a.selfB].sort());
    expect(ids(rowsB)).toEqual([b.selfA, b.selfB].sort());
    // asked for the wrong org id under A principal, RLS plus the org filter return nothing of B
    const cross = await asOrg(a.f.orgId, (tx) => apRepo.listSupplierInvoices(tx, b.f.orgId, { selfVerified: true }));
    expect(cross).toEqual([]);
  });

  it('L4: composes with the other filters - status verified + selfVerified, and status pending + selfVerified gives none', async () => {
    const { f, selfA, selfB } = await seed('l4');
    const verified = await asOrg(f.orgId, (tx) => apRepo.listSupplierInvoices(tx, f.orgId, { selfVerified: true, status: 'verified' }));
    expect(ids(verified)).toEqual([selfA, selfB].sort());
    const none = await asOrg(f.orgId, (tx) => apRepo.listSupplierInvoices(tx, f.orgId, { selfVerified: true, status: 'pending' }));
    expect(none).toEqual([]);
  });

  it('L5: the rows carry the flag (the badge reads it) - flagged rows true, the other verified row false. Mutant: column not on SupplierInvoiceRow', async () => {
    const { f, selfA, other } = await seed('l5');
    const all = await asOrg(f.orgId, (tx) => apRepo.listSupplierInvoices(tx, f.orgId, {}));
    const flag = (id: string) => (all.find((r) => r.id === id) as unknown as { selfVerified?: boolean } | undefined)?.selfVerified;
    expect(flag(selfA)).toBe(true);
    expect(flag(other)).toBe(false);
  });
});

describe('T-475 S3 - ?selfVerified=1 (the page helper, R16)', () => {
  it('L6: listInvoices(orgId, { selfVerified: true }) passes the filter through. Mutant: lib drops the new field', async () => {
    const { f, selfA, selfB } = await seed('l6');
    const rows = await listInvoices(f.orgId, { selfVerified: true } as never);
    expect(ids(rows)).toEqual([selfA, selfB].sort());
    expect(await listInvoices(f.orgId, {})).toHaveLength(4);
  });
});
