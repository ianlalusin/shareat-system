/**
 * T-475 S3 - migration 0217, the database half of "an admin may verify the invoice they logged themselves".
 * docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md section 5.3 + amendments R1-R3, R7 + "Ian's answers" Q3=A (role only, no grant branch).
 * TESTER file: asserts what the spec says the DATABASE enforces; writes NO production code. Real Postgres via TEST_DATABASE_URL (`_test` guard).
 * Every probe is ONE statement as the owner connection (a refused statement changes nothing); state legs build their row through the legal path first.
 *
 * RED TODAY, for one reason: 0217 does not exist - no `self_verified` column, no trigger, no extra checks. Positive controls fail on 42703
 * (undefined column); every refusal leg asserts an EXACT SQLSTATE (23514 for the CHECKs and the capability trigger) so a missing column can
 * never be mistaken for a refusal. The trigger's SQLSTATE is the spec's: "else 23514 naming the constraint" (5.3 step 4a).
 *
 * ASSUMPTIONS for the builder (flagged in the tester report):
 *  - the capability trigger raises 23514 with the constraint/trigger name in `constraint_name` OR in the message; the immutable trigger's
 *    SQLSTATE is not fixed by the spec, so D4 accepts any refusal that is not 42703/42P01 and names `supplier_invoices_self_verified_immutable`.
 *  - "role-only": the trigger has NO grant branch (Q3=A) - a person_grants row never lets a flagged row through.
 *
 * MUTANTS (named per leg):
 *  flag walks around two-person with no trigger          -> D2, D5       trigger judges only the flag-setting writes -> D6 (void after demotion)
 *  self-means-self check missing                          -> D3          flag clearable                              -> D4 (also under replica)
 *  trigger keyed on created_by instead of verified_by     -> D2, D8      grant branch kept (Q3 ignored)             -> D8c
 *  no active-role requirement (R1)                        -> D8d, D8e    verifier/creator swap not re-judged (R2)   -> D7
 *  registry entry or ALWAYS flip missing                  -> G1, G2      lock_timeout/RESET missing                 -> L1
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TRIGGER_REGISTRY } from '../../src/triggers/registry';
import { MIGRATIONS_FOLDER } from './t398-s3-fixture';
import { CAPABILITY_MATRIX } from '../../../auth/src/capabilities';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type PgErr = { code?: string; message: string; constraint_name?: string };
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const CAP = 'verify_own_supplier_invoice';
const TRG_CAP = 'supplier_invoices_self_verify_requires_capability';
const TRG_IMM = 'supplier_invoices_self_verified_immutable';
const CK_TWO = 'supplier_invoices_two_person_verification_check';
const CK_SELF = 'supplier_invoices_self_verified_means_self_check';

/** What the statement raised, or undefined if it was accepted. */
async function attempt(fn: () => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}
const names = (e: PgErr | undefined, n: string) => (e?.constraint_name ?? '') === n || (e?.message ?? '').includes(n);
/** The refusal is a real refusal, not a missing column / table. */
const isRealRefusal = (e: PgErr | undefined) => e !== undefined && e.code !== '42703' && e.code !== '42P01';

async function fixture(hint: string) {
  const code = uid(`t475s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const person = async (name: string, role: 'super_admin' | 'admin' | 'manager' | 'staff' | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminA = await person('Admin A', 'admin');
  const adminB = await person('Admin B', 'admin');
  const superId = await person('Super', 'super_admin');
  const manager = await person('Manager', 'manager');
  const manager2 = await person('Manager 2', 'manager');
  const staff = await person('Staff', 'staff');
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Pork Co', ${adminA}) returning id`;
  const supplierId = sup!.id;

  /** A raw invoice. Defaults: pending, created by Admin A. `verified` status stamps the four ticks. */
  const invoice = async (o: { createdBy?: string; status?: 'pending' | 'verified'; verifiedBy?: string | null; selfVerified?: boolean } = {}) => {
    const status = o.status ?? 'pending';
    const v = status === 'verified';
    const [r] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, created_by,
                                     verified_by, verified_at, attested_supplier, attested_invoice, attested_items, attested_price, self_verified)
      values (${orgId}, ${storeId}, ${supplierId}, '2026-01-10', '5000.00', ${status}, ${o.createdBy ?? adminA},
              ${v ? (o.verifiedBy === undefined ? adminB : o.verifiedBy) : null}, ${v ? sql`now()` : null}, ${v}, ${v}, ${v}, ${v}, ${o.selfVerified ?? false})
      returning id`;
    return r!.id;
  };
  /** The legal path: one UPDATE that flips a pending invoice to verified by `by` with the flag. */
  const verifyAs = (id: string, by: string, flag: boolean) => sql`
    update supplier_invoices set status = 'verified', verified_by = ${by}, verified_at = now(), self_verified = ${flag},
           attested_supplier = true, attested_invoice = true, attested_items = true, attested_price = true where id = ${id}`;
  const row = async (id: string) =>
    (await sql<{ status: string; verified_by: string | null; created_by: string; self_verified: boolean }[]>`
      select status, verified_by, created_by, self_verified from supplier_invoices where id = ${id}`)[0]!;
  return { orgId, storeId, supplierId, adminA, adminB, superId, manager, manager2, staff, person, invoice, verifyAs, row };
}

// ------------------------------------------------------------------------------------------------ the column and the constraints

describe('D0 - 0217 shape: the column, the two checks, the index, the two triggers', () => {
  it('self_verified is boolean NOT NULL DEFAULT false. Mutant: nullable or default true', async () => {
    const [c] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns where table_name = 'supplier_invoices' and column_name = 'self_verified'`;
    expect(c, 'RED today: no self_verified column (0217 missing)').toBeDefined();
    expect(c).toMatchObject({ data_type: 'boolean', is_nullable: 'NO' });
    expect(c!.column_default).toBe('false');
  });

  it('two-person check keeps its name and now reads "... OR self_verified"; the new self-means-self check exists and is VALIDATED', async () => {
    const cons = await sql<{ conname: string; def: string; convalidated: boolean }[]>`
      select conname, pg_get_constraintdef(oid) as def, convalidated from pg_constraint where conrelid = 'supplier_invoices'::regclass and conname in (${CK_TWO}, ${CK_SELF})`;
    const two = cons.find((c) => c.conname === CK_TWO);
    const self = cons.find((c) => c.conname === CK_SELF);
    expect(two, 'two-person check present').toBeDefined();
    expect(two!.def, 'mutant: the OR self_verified escape not added').toMatch(/self_verified/);
    expect(self, 'RED today: self-means-self check absent').toBeDefined();
    expect(self!.def).toMatch(/self_verified/);
    expect(self!.def).toMatch(/verified_by\s*=\s*created_by/);
    expect(self!.convalidated, 'added NOT VALID then VALIDATEd (every old row is false)').toBe(true);
  });

  it('a partial index (org_id, verified_at) WHERE self_verified exists', async () => {
    const [i] = await sql<{ def: string }[]>`select indexdef as def from pg_indexes where tablename = 'supplier_invoices' and indexname = 'supplier_invoices_self_verified_idx'`;
    expect(i, 'RED today: index absent').toBeDefined();
    expect(i!.def).toMatch(/\(org_id, verified_at\)/);
    expect(i!.def).toMatch(/WHERE.*self_verified/i);
  });

  it('G1: the capability trigger is BEFORE INSERT OR UPDATE, SECURITY INVOKER, live "O"; the immutable trigger is BEFORE UPDATE, live "A" (ENABLE ALWAYS)', async () => {
    const trg = await sql<{ tgname: string; tgenabled: string; tgtype: number }[]>`
      select tgname, tgenabled, tgtype from pg_trigger where tgrelid = 'supplier_invoices'::regclass and tgname in (${TRG_CAP}, ${TRG_IMM})`;
    const cap = trg.find((t) => t.tgname === TRG_CAP);
    const imm = trg.find((t) => t.tgname === TRG_IMM);
    expect(cap, 'RED today: capability trigger absent').toBeDefined();
    expect(imm, 'RED today: immutable trigger absent').toBeDefined();
    expect(cap!.tgenabled, 'mutant: capability trigger flipped to ALWAYS').toBe('O');
    expect(imm!.tgenabled, 'mutant: ENABLE ALWAYS missing on the history guard').toBe('A');
    const BEFORE = 2, INSERT = 4, UPDATE = 16;
    expect(cap!.tgtype & BEFORE).toBe(BEFORE);
    expect(cap!.tgtype & INSERT).toBe(INSERT);
    expect(cap!.tgtype & UPDATE).toBe(UPDATE);
    expect(imm!.tgtype & BEFORE).toBe(BEFORE);
    expect(imm!.tgtype & UPDATE).toBe(UPDATE);
    const [fn] = await sql<{ prosecdef: boolean }[]>`
      select p.prosecdef from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'supplier_invoices'::regclass and t.tgname = ${TRG_CAP}`;
    expect(fn!.prosecdef, 'SECURITY INVOKER (a definer function would read every org past RLS)').toBe(false);
  });

  it('G2: TRIGGER_REGISTRY classifies them - capability = validator/origin, immutable = history_guard/always, both on supplier_invoices', () => {
    const cap = TRIGGER_REGISTRY[TRG_CAP];
    const imm = TRIGGER_REGISTRY[TRG_IMM];
    expect(cap, 'RED today: no registry entry').toBeDefined();
    expect(imm, 'RED today: no registry entry').toBeDefined();
    expect(cap).toMatchObject({ table: 'supplier_invoices', kind: 'validator', mode: 'origin' });
    expect(imm).toMatchObject({ table: 'supplier_invoices', kind: 'history_guard', mode: 'always' });
    expect(cap!.reason.length).toBeGreaterThan(20);
    expect(imm!.reason.length).toBeGreaterThan(20);
  });
});

// ------------------------------------------------------------------------------------------------ plain UPDATE

describe('D1-D3 - the checks, as plain UPDATEs', () => {
  it('D1: verified_by = created_by WITHOUT the flag -> 23514 two-person. Controls: a different verifier is accepted; the flagged admin path is accepted. Mutant: check relaxed without the flag', async () => {
    const f = await fixture('d1');
    const id = await f.invoice();
    const err = await attempt(() => f.verifyAs(id, f.adminA, false));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, CK_TWO), err?.message).toBe(true);
    expect((await f.row(id)).status).toBe('pending');

    expect(await attempt(() => f.verifyAs(id, f.adminB, false)), 'control: a second pair of eyes').toBeUndefined();
    const id2 = await f.invoice();
    expect(await attempt(() => f.verifyAs(id2, f.adminA, true)), 'control: the admin self-verify with the flag').toBeUndefined();
    expect(await f.row(id2)).toMatchObject({ status: 'verified', verified_by: f.adminA, self_verified: true });
  });

  it('D2: the flag with a MANAGER as verifier (verified_by = created_by = manager) -> the capability trigger refuses, 23514 naming it. Mutant: no trigger (the OR escape alone)', async () => {
    const f = await fixture('d2');
    const id = await f.invoice({ createdBy: f.manager });
    const err = await attempt(() => f.verifyAs(id, f.manager, true));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), `must name ${TRG_CAP}: ${err?.message}`).toBe(true);
    expect((await f.row(id)).self_verified).toBe(false);
    expect((await f.row(id)).status).toBe('pending');
  });

  it('D2b: the flag with a STAFF verifier and with a manager verifying a row an ADMIN logged is also refused (the verifier is what is judged). Mutant: trigger judges created_by', async () => {
    const f = await fixture('d2b');
    const staffRow = await f.invoice({ createdBy: f.staff });
    const e1 = await attempt(() => f.verifyAs(staffRow, f.staff, true));
    expect(e1?.code).toBe('23514');
    expect(names(e1, TRG_CAP), e1?.message).toBe(true);
    // created_by = admin A (a holder), verified_by = manager, flag: the self-means-self check is the second line; the trigger must refuse first or either way 23514
    const adminRow = await f.invoice({ createdBy: f.adminA });
    const e2 = await attempt(() => f.verifyAs(adminRow, f.manager, true));
    expect(e2?.code).toBe('23514');
    expect((await f.row(adminRow)).status).toBe('pending');
  });

  it('D3: the flag with verified_by <> created_by (a holder verifying someone elses row WITH the flag) -> 23514 self-means-self. Control: same verifier, no flag, accepted. Mutant: self-means-self check missing', async () => {
    const f = await fixture('d3');
    const id = await f.invoice({ createdBy: f.adminA });
    const err = await attempt(() => f.verifyAs(id, f.adminB, true));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, CK_SELF), err?.message).toBe(true);
    expect(await attempt(() => f.verifyAs(id, f.adminB, false)), 'control: no flag, different verifier').toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ immutable flag (R3)

describe('D4 - the flag is history (R3): supplier_invoices_self_verified_immutable', () => {
  const clear = (id: string, newVerifier: string) => sql`update supplier_invoices set self_verified = false, verified_by = ${newVerifier} where id = ${id}`;

  it('clearing the flag on a verified row is refused even when every CHECK would pass (verified_by moved to a second person) - the TRIGGER refuses. Mutant: flag clearable', async () => {
    const f = await fixture('d4');
    const id = await f.invoice();
    await f.verifyAs(id, f.adminA, true);
    const err = await attempt(() => clear(id, f.adminB));
    expect(isRealRefusal(err), `RED reason: ${err?.code} ${err?.message}`).toBe(true);
    expect(names(err, TRG_IMM), `must name ${TRG_IMM}: ${err?.message}`).toBe(true);
    expect(await f.row(id)).toMatchObject({ self_verified: true, verified_by: f.adminA });
  });

  it('same refusal under session_replication_role = replica (ENABLE ALWAYS, the 0168 pattern). Mutant: origin-mode trigger', async () => {
    const f = await fixture('d4r');
    const id = await f.invoice();
    await f.verifyAs(id, f.adminA, true);
    const err = await attempt(() =>
      sql.begin(async (tx) => {
        await tx.unsafe(`set local session_replication_role = 'replica'`);
        await tx`update supplier_invoices set self_verified = false, verified_by = ${f.adminB} where id = ${id}`;
      }),
    );
    expect(isRealRefusal(err), `replica-mode clear was ACCEPTED or hit a missing column: ${err?.code} ${err?.message}`).toBe(true);
    expect(names(err, TRG_IMM), err?.message).toBe(true);
    expect((await f.row(id)).self_verified).toBe(true);
  });

  it('control: setting the flag false -> true is the legal direction (D1 path), and an UNflagged verified row can still take any ordinary update', async () => {
    const f = await fixture('d4c');
    const id = await f.invoice({ status: 'verified', verifiedBy: f.adminB });
    expect(await attempt(() => sql`update supplier_invoices set notes = 'x', updated_at = now() where id = ${id}`)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ INSERT

describe('D5 - INSERT with the flag', () => {
  const insertFlagged = (f: Awaited<ReturnType<typeof fixture>>, by: string | null) => f.invoice({ createdBy: by ?? f.adminA, status: 'verified', verifiedBy: by, selfVerified: true });

  it('by a non-holder (manager) -> 23514 naming the trigger. Control: by an admin, accepted. Mutant: INSERT not covered by the trigger', async () => {
    const f = await fixture('d5');
    const err = await attempt(() => insertFlagged(f, f.manager));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), err?.message).toBe(true);
    expect(await attempt(() => insertFlagged(f, f.adminA)), 'control: admin holder').toBeUndefined();
    expect(await attempt(() => insertFlagged(f, f.superId)), 'control: super_admin holder').toBeUndefined();
  });

  it('with verified_by NULL (the self-means-self CHECK passes on NULL) -> still refused: the trigger needs a named, role-holding verifier (R1)', async () => {
    const f = await fixture('d5n');
    const err = await attempt(
      () => sql`insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, created_by, self_verified)
                values (${f.orgId}, ${f.storeId}, ${f.supplierId}, '2026-01-10', '100.00', 'pending', ${f.adminA}, true)`,
    );
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), err?.message).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ void after demotion; swap (R2)

describe('D6 - a later demotion never blocks voiding (the trigger judges only flag-setting writes)', () => {
  it('admin self-verifies, is demoted to staff (role revoked + staff role), then the invoice is VOIDED and a payment-status style update works. Mutant: trigger re-judges every UPDATE', async () => {
    const f = await fixture('d6');
    const id = await f.invoice();
    await f.verifyAs(id, f.adminA, true);
    await sql`update person_roles set revoked_at = now() where person_id = ${f.adminA} and org_id = ${f.orgId} and revoked_at is null`;
    await sql`insert into person_roles (person_id, org_id, role) values (${f.adminA}, ${f.orgId}, 'staff')`;
    const err = await attempt(
      () => sql`update supplier_invoices set status = 'voided', voided_by = ${f.manager}, voided_at = now(), void_reason = 'wrong supplier', updated_at = now() where id = ${id}`,
    );
    expect(err, `voiding was refused: ${err?.code} ${err?.message}`).toBeUndefined();
    expect(await f.row(id)).toMatchObject({ status: 'voided', self_verified: true });
  });

  it('even with NO active role at all for the verifier, an ordinary update on a flagged row is accepted', async () => {
    const f = await fixture('d6b');
    const id = await f.invoice();
    await f.verifyAs(id, f.adminA, true);
    await sql`update person_roles set revoked_at = now() where person_id = ${f.adminA} and org_id = ${f.orgId} and revoked_at is null`;
    expect(await attempt(() => sql`update supplier_invoices set notes = 'later note', updated_at = now() where id = ${id}`)).toBeUndefined();
  });
});

describe('D7 - R2: a flagged row is re-judged when verified_by or created_by changes', () => {
  it('swap both to a manager on a self-verified row -> refused; swap both to another admin -> accepted (control). Mutant: only flag-setting writes judged', async () => {
    const f = await fixture('d7');
    const id = await f.invoice();
    await f.verifyAs(id, f.adminA, true);
    const err = await attempt(() => sql`update supplier_invoices set created_by = ${f.manager}, verified_by = ${f.manager} where id = ${id}`);
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), err?.message).toBe(true);
    expect(await f.row(id)).toMatchObject({ created_by: f.adminA, verified_by: f.adminA });

    expect(await attempt(() => sql`update supplier_invoices set created_by = ${f.adminB}, verified_by = ${f.adminB} where id = ${id}`), 'control: another holder').toBeUndefined();
  });

  it('swap only the verifier on a flagged row to a non-holder -> refused (by the trigger or the self-means-self CHECK; 23514 either way)', async () => {
    const f = await fixture('d7b');
    const id = await f.invoice();
    await f.verifyAs(id, f.adminA, true);
    const err = await attempt(() => sql`update supplier_invoices set verified_by = ${f.manager} where id = ${id}`);
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
  });
});

// ------------------------------------------------------------------------------------------------ drift guard

describe('D8 - role-drift: the trigger agrees with the capability matrix for all four roles, and with Q3 (role only)', () => {
  const ROLES = ['super_admin', 'admin', 'manager', 'staff'] as const;
  const flagged = (f: Awaited<ReturnType<typeof fixture>>, personId: string) =>
    f.invoice({ createdBy: personId, status: 'verified', verifiedBy: personId, selfVerified: true });

  for (const role of ROLES) {
    it(`D8a (${role}): a flagged INSERT with verified_by = created_by = a ${role} is ${(CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[CAP]?.[role] ? 'accepted' : 'refused 23514'} - exactly as CAPABILITY_MATRIX says. Mutant: trigger and matrix drift`, async () => {
      const f = await fixture(`d8-${role}`);
      const p = await f.person(`P ${role}`, role);
      const cell = (CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[CAP]?.[role];
      expect(cell, `${CAP} is not in CAPABILITY_MATRIX (RED today)`).toBeDefined();
      const err = await attempt(() => flagged(f, p));
      if (cell) {
        expect(err, `${role} holds the capability but the trigger refused: ${err?.code} ${err?.message}`).toBeUndefined();
      } else {
        expect(err?.code, `${role} lacks the capability but the flagged row went in (or: ${err?.message})`).toBe('23514');
        expect(names(err, TRG_CAP), err?.message).toBe(true);
      }
    });
  }

  it('D8b: the matrix itself is the expected shape the trigger mirrors: super OK, admin OK, manager NO, staff NO', () => {
    expect((CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[CAP]).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
  });

  it('D8c (Q3=A): a manager holding a live PERSON GRANT of the capability is REFUSED by the trigger - no grant branch. Mutant: grant branch kept', async () => {
    const f = await fixture('d8c');
    await sql`insert into person_grants (person_id, grant_name, grant_source) values (${f.manager}, ${CAP}, 'grant')`;
    const err = await attempt(() => flagged(f, f.manager));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), err?.message).toBe(true);
  });

  it('D8d (R1): a person_grants row but NO active role -> refused (no role = refused, as authorize() refuses). Mutant: role requirement dropped', async () => {
    const f = await fixture('d8d');
    const p = await f.person('No role', null);
    await sql`insert into person_grants (person_id, grant_name, grant_source) values (${p}, ${CAP}, 'grant')`;
    const err = await attempt(() => flagged(f, p));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), err?.message).toBe(true);
  });

  it('D8e (R1): an admin whose role was REVOKED (revoked_at set) is refused; the same admin with an active role is accepted (control). Mutant: revoked roles counted', async () => {
    const f = await fixture('d8e');
    const p = await f.person('Ex admin', 'admin');
    expect(await attempt(() => flagged(f, p)), 'control: active admin').toBeUndefined();
    await sql`update person_roles set revoked_at = now() where person_id = ${p} and org_id = ${f.orgId} and revoked_at is null`;
    const err = await attempt(() => flagged(f, p));
    expect(err?.code, `got ${err?.code}: ${err?.message}`).toBe('23514');
    expect(names(err, TRG_CAP), err?.message).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ the migration text (ADR-012 s5)

describe('L1 - the 0217 migration text (ADR-012 s5, R7)', () => {
  type J = { idx: number; tag: string; when: number };
  const journal = () => (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: J[] }).entries;
  const entry = () => journal().find((x) => x.tag.startsWith('0217_'));
  const text = (): string => {
    const e = entry();
    expect(e, 'no journal entry numbered 0217: the S3 migration does not exist yet (RED today)').toBeDefined();
    const f = join(MIGRATIONS_FOLDER, `${e!.tag}.sql`);
    expect(existsSync(f)).toBe(true);
    return readFileSync(f, 'utf8');
  };
  const statements = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '');

  it('exactly one 0217 entry (tag names t475 and self-verified), when = 1804822307084, LF-only, no BOM, no 0x08 byte', () => {
    expect(journal().filter((e) => e.tag.startsWith('0217_')).length, 'RED today: no 0217 entry').toBe(1);
    expect(entry()!.tag).toMatch(/t475/);
    expect(entry()!.tag).toMatch(/self_verified/);
    expect(entry()!.when, '0216 (POS T-472) when + 86400000').toBe(1804822307084);
    const t = text();
    expect(t.includes('\r'), 'CRLF').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
    expect(t.includes(String.fromCharCode(8)), 'a backspace byte (a broken regex)').toBe(false);
  });

  it("first statement SET LOCAL lock_timeout = '5s', last statement RESET lock_timeout; header names T-475", () => {
    const t = text();
    expect(t).toMatch(/T-475/);
    const s = statements(t);
    expect(s[0] ?? '', 'mutant: lock_timeout missing or not first').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
    expect(s[s.length - 1] ?? '', 'mutant: RESET missing (SET LOCAL lasts to the end of the whole migrate transaction)').toMatch(/^RESET lock_timeout/i);
  });

  it('adds the self-means-self CHECK NOT VALID then VALIDATEs it; creates both triggers; ENABLE ALWAYS on the immutable one; no grant lookup in the trigger body (Q3=A)', () => {
    const t = text();
    expect(t).toMatch(/ADD COLUMN\s+"?self_verified"?\s+boolean\s+NOT NULL\s+DEFAULT\s+false/i);
    expect(t).toMatch(new RegExp(`${CK_SELF}[\\s\\S]*NOT VALID`, 'i'));
    expect(t).toMatch(new RegExp(`VALIDATE CONSTRAINT\\s+"?${CK_SELF}"?`, 'i'));
    expect(t).toMatch(new RegExp(`CREATE TRIGGER\\s+"?${TRG_CAP}"?[\\s\\S]*BEFORE INSERT OR UPDATE`, 'i'));
    expect(t).toMatch(new RegExp(`CREATE TRIGGER\\s+"?${TRG_IMM}"?`, 'i'));
    expect(t).toMatch(new RegExp(`ENABLE ALWAYS TRIGGER\\s+"?${TRG_IMM}"?`, 'i'));
    expect(t, 'Q3=A: the trigger has no person_grants branch').not.toMatch(/person_grants/i);
  });
});
