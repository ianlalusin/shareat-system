import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-390 S3 - the opening tie-out. `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R6 (2120/1340 half), R9, R15, R16,
 * s5.3 (T2-T10; T1 lands with S2 and is NOT tested here), s6 I6, s8 tests 15 (S3 part), 16, 17, 18, 18a, 18b.
 * Written TESTER-FIRST: red until `openingTieOut`, step `C3P`, the C4/C5 changes and the R15 refusals land.
 *
 * Every register has a PASSING case and a FAILING case. A failing case asserts ONE sentence that holds the store name, the
 * register word and the difference in pesos (or the party name) - test 16. A passing case asserts `holds`, so a register query
 * that was dropped (M17) turns its failing case green and is caught, and a register that always refuses is caught by the passing
 * case. Fixtures leave each store's 3900 cleared (`settle3900`) wherever another register is the subject, so T10 stays quiet.
 */
import { closeDb, RefusalError } from '@shareat/db';
import {
  CONVERSION, asOrg, attestC3P, cutoverRepo, domain, errorOf, figure, fixture, mkAsset, mkCustomer, mkLoan, mkPerson, mkPrepaid,
  mkShell, mkSupplier, moneyAccountOf, need, peso, rawOpeningDraft, reachC3, sentenceWith, sentences, settle3900, sql, tieOut, uid,
  type Fixture, type TieOut,
} from './t390-s3-common';
import { testItemCode } from '../../packages/domain/tests/integration/_fixtures/item-code';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const reason = (e: unknown) => (e instanceof RefusalError ? e.userMessage : String(e));

async function expectHolds(f: Fixture): Promise<TieOut> {
  const t = await tieOut(f);
  expect(t.holds, `the tie-out should hold but said:\n${sentences(t)}`).toBe(true);
  return t;
}
async function expectFails(f: Fixture, what: string, ...parts: (string | RegExp)[]): Promise<TieOut> {
  const t = await tieOut(f);
  expect(t.holds, `${what}: the tie-out should NOT hold (a register query is missing or blind)`).toBe(false);
  const s = sentenceWith(t, ...parts);
  expect(
    s,
    `${what}: no single sentence has all of [${parts.map(String).join(' | ')}]. Sentences were:\n${sentences(t) || '(none)'}`,
  ).toBeDefined();
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T2 - fixed assets, per store x 1510 (kills M17, M18)', () => {
  it('PASS: an active asset acquired on the conversion date and a 1510 figure of the same amount', async () => {
    const f = await fixture('t2pass');
    await mkAsset(f, f.storeA, '312400.00');
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '312400.00' });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: assets come to 312,400.00 but 1510 says 300,000.00 - the sentence names the store, the register and 12,400.00', async () => {
    const f = await fixture('t2fail');
    await mkAsset(f, f.storeA, '312400.00');
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '300000.00' });
    await settle3900(f);
    await expectFails(f, 'T2 mismatch', f.nameA, /fixed assets/i, peso('12400.00'));
  });

  it('FAIL: a pending_valuation shell is listed BY NAME (a shell left pending blocks the opening)', async () => {
    const f = await fixture('t2shell');
    const shell = await mkShell(f, f.storeA);
    await expectFails(f, 'T2 shell', f.nameA, shell.name);
  });

  it('FAIL: any 1590 opening line is refused (assets open at net book value, so accumulated depreciation opens at zero)', async () => {
    const f = await fixture('t21590');
    await rawOpeningDraft(f, { accountCode: '1590', storeId: f.storeA, direction: 'credit', amount: '40000.00', key: '1590a' });
    await settle3900(f);
    await expectFails(f, 'T2 1590', f.nameA, /1590|accumulated depreciation/i);
  });

  it('NEGATIVE LEG: an asset acquired on ANY OTHER date is not in the opening register', async () => {
    const f = await fixture('t2other');
    await mkAsset(f, f.storeA, '99999.00', '2026-03-01');
    await expectHolds(f); // no 1510 figure, none needed: it is not an opening asset
  });

  it('NEGATIVE LEG: a disposed asset is not in the register', async () => {
    const f = await fixture('t2disposed');
    const id = await mkAsset(f, f.storeA, '5000.00', '2026-01-01');
    await sql`update fixed_assets set status = 'disposed', disposed_on = '2026-06-01', disposal_reason = 'scrapped', disposed_by = ${f.adminId} where id = ${id}`;
    await expectHolds(f);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T3 - prepaids, per store x 1400 (kills M17, M18)', () => {
  it('PASS: active prepaids and a 1400 figure of the same total', async () => {
    const f = await fixture('t3pass');
    await mkPrepaid(f, f.storeA, '12000.00');
    await figure(f, { accountCode: '1400', storeId: f.storeA, direction: 'debit', amount: '12000.00' });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: prepaids 12,000.00 against a 1400 figure of 11,500.00 - store, register, 500.00', async () => {
    const f = await fixture('t3fail');
    await mkPrepaid(f, f.storeA, '12000.00');
    await figure(f, { accountCode: '1400', storeId: f.storeA, direction: 'debit', amount: '11500.00' });
    await settle3900(f);
    await expectFails(f, 'T3 mismatch', f.nameA, /prepaid/i, peso('500.00'));
  });

  it('M18 (floats): 0.10 + 0.20 of prepaids against a 1400 figure of 0.30 TIES (a float sum reads 0.30000000000000004)', async () => {
    const f = await fixture('t3float');
    await mkPrepaid(f, f.storeA, '0.10');
    await mkPrepaid(f, f.storeA, '0.20');
    await figure(f, { accountCode: '1400', storeId: f.storeA, direction: 'debit', amount: '0.30' });
    await settle3900(f);
    await expectHolds(f);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T4 - loans, per loan x 2400 (kills M17)', () => {
  it('PASS: every active loan has a 2400 opening figure naming it', async () => {
    const f = await fixture('t4pass');
    const loan = await mkLoan(f, f.storeA, 'Grab Capital');
    await figure(f, { accountCode: '2400', storeId: f.storeA, direction: 'credit', amount: '30000.00', partyType: 'loan', partyId: loan.id });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: an active loan with no opening balance is named, with its store', async () => {
    const f = await fixture('t4missing');
    const loan = await mkLoan(f, f.storeA, 'Grab Capital 2');
    await expectFails(f, 'T4 missing balance', f.nameA, loan.name, /no opening balance/i);
  });

  it('FAIL: a 2400 figure that names a loan which is not in the register for THAT store', async () => {
    const f = await fixture('t4orphan');
    const otherStoreLoan = await mkLoan(f, f.storeB, 'Malvar Loan');
    await figure(f, { accountCode: '2400', storeId: f.storeA, direction: 'credit', amount: '1000.00', partyType: 'loan', partyId: otherStoreLoan.id });
    await settle3900(f);
    await expectFails(f, 'T4 wrong store', f.nameA, /2400/);
  });

  it('NEGATIVE LEG: a loan that is paid off needs no opening balance', async () => {
    const f = await fixture('t4paidoff');
    await mkLoan(f, f.storeA, 'Old Loan', 'paid_off');
    await expectHolds(f);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T5 - advances to employees, 1230 (kills M17)', () => {
  it('PASS: the advance names someone employed at that store', async () => {
    const f = await fixture('t5pass');
    const p = await mkPerson(f, 'Juan', f.storeB);
    await figure(f, { accountCode: '1230', storeId: f.storeB, direction: 'debit', amount: '2500.00', partyType: 'employee', partyId: p.id });
    await settle3900(f);
    await expectHolds(f);
  });

  it('PASS: an employment of ANY status counts (resigned staff can still owe an advance)', async () => {
    const f = await fixture('t5status');
    const p = await mkPerson(f, 'Maria', f.storeB);
    await sql`update employments set employment_status = 'resigned', ended_on = '2026-11-30' where person_id = ${p.id}`;
    await figure(f, { accountCode: '1230', storeId: f.storeB, direction: 'debit', amount: '100.00', partyType: 'employee', partyId: p.id });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: the advance names someone who has never been employed at the line\'s store', async () => {
    const f = await fixture('t5fail');
    const p = await mkPerson(f, 'Pedro', f.storeA); // employed at A only
    await figure(f, { accountCode: '1230', storeId: f.storeB, direction: 'debit', amount: '2500.00', partyType: 'employee', partyId: p.id });
    await settle3900(f);
    await expectFails(f, 'T5 never employed', f.nameB, /1230|advance/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T6 - AR 1210 and AP 2110 per party (kills M17)', () => {
  it('PASS: a customer on 1210 and a supplier on 2110', async () => {
    const f = await fixture('t6pass');
    const c = await mkCustomer(f, 'Acme Catering');
    const s = await mkSupplier(f, 'Acme Meats');
    await figure(f, { accountCode: '1210', storeId: f.storeA, direction: 'debit', amount: '4000.00', partyType: 'customer', partyId: c.id });
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '9000.00', partyType: 'supplier', partyId: s.id });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: a 2110 figure that names a CUSTOMER (wrong party type) - the sentence names the party', async () => {
    const f = await fixture('t6wrongtype');
    const c = await mkCustomer(f, 'Wrong Type Customer');
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '900.00', partyType: 'customer', partyId: c.id });
    await settle3900(f);
    await expectFails(f, 'T6 wrong party type', c.name);
  });

  it('FAIL: a 1210 figure whose party is not a customer of the organisation (orphan) - the sentence names the account and store', async () => {
    const f = await fixture('t6orphan');
    await figure(f, {
      accountCode: '1210', storeId: f.storeA, direction: 'debit', amount: '900.00', partyType: 'customer',
      partyId: '00000000-0000-4000-8000-000000000bad',
    });
    await settle3900(f);
    await expectFails(f, 'T6 orphan', f.nameA, /1210|receivable/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T7 - money accounts 1110-1140 (kills M17)', () => {
  it('PASS: a 1140 figure naming an active e-wallet of the same store', async () => {
    const f = await fixture('t7pass');
    const m = await moneyAccountOf(f, f.storeA, '1140');
    await figure(f, { accountCode: '1140', storeId: f.storeA, direction: 'debit', amount: '700.00', partyType: 'money_account', partyId: m });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: a 1140 figure naming ANOTHER store\'s wallet', async () => {
    const f = await fixture('t7other');
    const mB = await moneyAccountOf(f, f.storeB, '1140');
    await figure(f, { accountCode: '1140', storeId: f.storeA, direction: 'debit', amount: '700.00', partyType: 'money_account', partyId: mB });
    await settle3900(f);
    await expectFails(f, 'T7 other store', f.nameA, /1140|wallet|money/i);
  });

  it('FAIL: a 1140 figure naming a RETIRED wallet', async () => {
    const f = await fixture('t7retired');
    const m = await moneyAccountOf(f, f.storeA, '1140', false);
    await figure(f, { accountCode: '1140', storeId: f.storeA, direction: 'debit', amount: '700.00', partyType: 'money_account', partyId: m });
    await settle3900(f);
    await expectFails(f, 'T7 retired', f.nameA, /1140|wallet|money/i);
  });

  it('NEGATIVE LEG: active money accounts with NO figure do not refuse (a zero balance cannot be entered as a figure)', async () => {
    const f = await fixture('t7nofigure');
    await moneyAccountOf(f, f.storeA, '1140');
    await moneyAccountOf(f, f.storeB, '1140');
    await expectHolds(f);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T8 - every opening figure is dated 2027-01-01 (kills M17)', () => {
  it('PASS: every figure dated the conversion date', async () => {
    const f = await fixture('t8pass');
    const s = await mkSupplier(f, 'Dated Right');
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '100.00', partyType: 'supplier', partyId: s.id, entryDate: CONVERSION });
    await settle3900(f);
    await expectHolds(f);
  });

  it('FAIL: a figure dated 2026-12-31 - the sentence names the account, the party and the date', async () => {
    const f = await fixture('t8fail');
    const s = await mkSupplier(f, 'Supplier X');
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '100.00', partyType: 'supplier', partyId: s.id, entryDate: '2026-12-31' });
    await settle3900(f);
    await expectFails(f, 'T8 date', '2110', s.name, '2026-12-31');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T9 and test 18a - inter-store 1250 / 2150 (kills M17, M29-adjacent)', () => {
  const pair = async (f: Fixture, aOwed: string | null, bOwes: string | null) => {
    if (aOwed) await figure(f, { accountCode: '1250', storeId: f.storeA, direction: 'debit', amount: aOwed, partyType: 'store', partyId: f.storeB });
    if (bOwes) await figure(f, { accountCode: '2150', storeId: f.storeB, direction: 'credit', amount: bOwes, partyType: 'store', partyId: f.storeA });
    await settle3900(f);
  };

  it('PASS: A says B owes 8,000.00 and B says it owes A 8,000.00', async () => {
    const f = await fixture('t9pass');
    await pair(f, '8000.00', '8000.00');
    await expectHolds(f);
  });

  it('FAIL (18a): a pair 500.00 apart - the sentence names both stores and 500.00', async () => {
    const f = await fixture('t9fail');
    await pair(f, '8000.00', '7500.00');
    await expectFails(f, 'T9 apart', f.nameA, f.nameB, peso('500.00'));
  });

  it('FAIL: one side missing altogether (the classic missing transfer) - names both stores and the whole 8,000.00', async () => {
    const f = await fixture('t9oneside');
    await pair(f, '8000.00', null);
    await expectFails(f, 'T9 one side', f.nameA, f.nameB, peso('8000.00'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 16 / T10 and test 18a - 3900 per store (kills M17, M30)', () => {
  it('PASS: each store clears on its own (figure plus its 3900 -> 3300 reconcile)', async () => {
    const f = await fixture('t10pass');
    const sup = await mkSupplier(f, 'T10 Supplier');
    await figure(f, { accountCode: '1240', storeId: f.storeB, direction: 'debit', amount: '1240.00', partyType: 'supplier', partyId: sup.id });
    await settle3900(f);
    await expectHolds(f);
  });

  it("FAIL (18a, M30): store B's 3900 carries 1,240.00 while the ORG total is zero - names the store and 1,240.00", async () => {
    const f = await fixture('t10fail');
    // B: Dr 1240 1240 / Cr 3900 1240 (no reconcile at B).
    const sup = await mkSupplier(f, 'T10 Supplier');
    await figure(f, { accountCode: '1240', storeId: f.storeB, direction: 'debit', amount: '1240.00', partyType: 'supplier', partyId: sup.id });
    // A: the reconcile alone, Dr 3900 1240 / Cr 3300 1240. The ORG-WIDE 3900 is now exactly zero.
    await figure(f, { accountCode: '3300', storeId: f.storeA, direction: 'credit', amount: '1240.00' });
    const org = await asOrg(f.orgId, (tx) => cutoverRepo.openingEquityResidual(tx, f.orgId));
    expect(Number(org), 'fixture: the org-wide 3900 must be zero for this case to mean anything').toBe(0);
    const t = await expectFails(f, 'T10 per store', f.nameB, /3900/, peso('1240.00'));
    // The line is B's, not a store-less org line.
    expect(t.lines.some((l) => l.storeId === f.storeB && /3900/.test(l.sentence))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 18a / R15 - accounts with no register: listed "not checked here", never green, never a refusal', () => {
  it('a 1240 figure is neither a tie nor a refusal, and is listed as not checked here WITH its figure', async () => {
    const f = await fixture('r15nochk');
    const s = await mkSupplier(f, 'Advance Supplier');
    await figure(f, { accountCode: '1240', storeId: f.storeA, direction: 'debit', amount: '3333.00', partyType: 'supplier', partyId: s.id });
    await settle3900(f);
    const t = await expectHolds(f); // never a refusal
    // Never shown as a tie: no register line is about 1240.
    expect(t.lines.filter((l) => l.account === '1240' && l.difference !== undefined && /tie/i.test(l.register))).toEqual([]);
    const nc = (t as { notChecked?: { account: string; amount: string; reason: string }[] }).notChecked;
    expect(Array.isArray(nc), 'result.notChecked is missing').toBe(true);
    const row = nc!.find((r) => r.account === '1240');
    expect(row, 'the 1240 balance is not listed under notChecked').toBeDefined();
    expect(row!.amount).toMatch(/3,?333[.]00/);
    expect(row!.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('R6 (2120 / 1340 half) and test 15 S3 part - typing a figure on a register-less v2-only account is refused (kills M16)', () => {
  const draftCount = async (f: Fixture) => {
    const [r] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'opening_balance'`;
    return Number(r!.n);
  };

  it('2120 (GRNI) is refused at entry, in words, and nothing is written', async () => {
    const f = await fixture('r6grni');
    const err = await errorOf(figure(f, { accountCode: '2120', storeId: f.storeA, direction: 'credit', amount: '500.00' }));
    expect(err, 'addOpeningFigure accepted 2120').toBeInstanceOf(RefusalError);
    expect(reason(err)).toMatch(/2120|received not invoiced|goods received/i);
    expect(await draftCount(f)).toBe(0);
  });

  it('1340 (inventory in transit) is refused at entry, in words, and nothing is written', async () => {
    const f = await fixture('r6transit');
    const err = await errorOf(figure(f, { accountCode: '1340', storeId: f.storeA, direction: 'debit', amount: '500.00' }));
    expect(err, 'addOpeningFigure accepted 1340').toBeInstanceOf(RefusalError);
    expect(reason(err)).toMatch(/1340|in transit/i);
    expect(await draftCount(f)).toBe(0);
  });

  it('POSITIVE CONTROL: 1240 (allowed, listed "not checked here") is accepted', async () => {
    const f = await fixture('r6ok');
    const s = await mkSupplier(f, 'Fine Supplier');
    const r = await figure(f, { accountCode: '1240', storeId: f.storeA, direction: 'debit', amount: '500.00', partyType: 'supplier', partyId: s.id });
    expect(r.entryId).toBeTruthy();
    expect(await draftCount(f)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('R16 - step C3P and the C3P -> C5 gate (kills M29)', () => {
  it('C3P is an org-wide ATTESTED step in phase C, and the gate C3P -> C5 is declared', () => {
    const def = domain.stepDef('C3P');
    expect(def, 'step C3P is not declared in CUTOVER_STEPS').toBeDefined();
    expect(def!.phase).toBe('C');
    expect(def!.kind).toBe('attested');
    expect(def!.perStore).toBe(false);
    expect(def!.title).toMatch(/party balances agree with v1/i);
    expect(domain.CUTOVER_GATES.some((g) => g.after === 'C3P' && g.before === 'C5')).toBe(true);
  });

  it('C4 is retitled "3900 nets to zero and every register ties"', () => {
    expect(domain.stepDef('C4')!.title).toMatch(/every register ties/i);
  });

  it('C5 waits on C3P until it is attested, and not afterwards (C4 itself being satisfied)', async () => {
    const f = await fixture('c3pgate');
    await reachC3(f);
    const prog = () => asOrg(f.orgId, (tx) => domain.cutoverProgress(tx, f.orgId, [f.storeA, f.storeB]));
    const before = await prog();
    expect(before.steps.find((s) => s.def.code === 'C4')!.done, 'fixture: C4 should hold on an empty, tied ledger').toBe(true);
    const c5 = before.steps.find((s) => s.def.code === 'C5')!;
    expect(c5.blockedBy ?? '(not blocked)', 'C5 is not blocked while C3P is unattested').toMatch(/C3P/);
    await attestC3P(f);
    const after = await prog();
    expect(after.steps.find((s) => s.def.code === 'C3P')!.done).toBe(true);
    expect(after.steps.find((s) => s.def.code === 'C5')!.blockedBy).toBeNull();
  });

  it('attestStep refuses nothing it should accept: C3P is attestable, and it records an ATTESTED row (not verified)', async () => {
    const f = await fixture('c3pattest');
    await asOrg(f.orgId, (tx) => domain.attestStep(tx, f.admin, { stepCode: 'C3P', note: 'agreed with v1 aged lists' }));
    const [row] = await sql<{ completion: string; store_id: string | null }[]>`
      select completion, store_id from cutover_steps where org_id = ${f.orgId} and step_code = 'C3P'`;
    expect(row!.completion).toBe('attested');
    expect(row!.store_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 17 - C4 is decided by the tie-out QUERY, not by a row (kills M19)', () => {
  const c4 = async (f: Fixture) => {
    const p = await asOrg(f.orgId, (tx) => domain.cutoverProgress(tx, f.orgId, [f.storeA, f.storeB]));
    return p.steps.find((s) => s.def.code === 'C4')!;
  };
  const recordC4Row = (f: Fixture) =>
    asOrg(f.orgId, (tx) =>
      cutoverRepo.recordStep(tx, { orgId: f.orgId, storeId: null, stepCode: 'C4', completion: 'verified', note: 'forged', completedBy: f.adminId }),
    );

  it('NOT DONE while a register fails - with a recorded C4 row, C3 done and a ZERO residual - and detail says what', async () => {
    const f = await fixture('c4fail');
    await reachC3(f);
    const shell = await mkShell(f, f.storeA); // T2: a shell left pending. No figures at all, so 3900 is exactly zero.
    await recordC4Row(f);
    const residual = await asOrg(f.orgId, (tx) => cutoverRepo.openingEquityResidual(tx, f.orgId));
    expect(Number(residual)).toBe(0);
    const s = await c4(f);
    expect(s.blockedBy, 'fixture: C3 is recorded, so C4 is not gate-blocked').toBeNull();
    expect(s.done, 'C4 read the recorded row, not the query').toBe(false);
    expect(s.detail ?? '', 'C4 detail should carry the first refusal sentence').toContain(shell.name);
  });

  it('NOT DONE on a 1510 mismatch either (a different register), row recorded, residual zero', async () => {
    const f = await fixture('c4fail2');
    await reachC3(f);
    await mkAsset(f, f.storeA, '312400.00'); // the register says 312,400.00 and there is no 1510 figure
    await recordC4Row(f);
    const s = await c4(f);
    expect(s.done).toBe(false);
    expect(s.detail ?? '').toMatch(/fixed assets/i);
  });

  it('POSITIVE CONTROL: DONE when every register ties (and 3900 is zero)', async () => {
    const f = await fixture('c4pass');
    await reachC3(f);
    await mkAsset(f, f.storeA, '312400.00');
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '312400.00' });
    await settle3900(f);
    expect((await c4(f)).done).toBe(true);
  });

  it('with several failures the detail is the FIRST sentence plus "and N more"', async () => {
    const f = await fixture('c4many');
    await reachC3(f);
    await mkShell(f, f.storeA, 'Shell One');
    await mkShell(f, f.storeA, 'Shell Two');
    await mkShell(f, f.storeB, 'Shell Three');
    const s = await c4(f);
    expect(s.done).toBe(false);
    expect(s.detail ?? '').toMatch(/and 2 more/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('C5 refuses in words, from the same tie-out (I6, I7) and test 18 - double counting is now a REFUSAL (kills M20)', () => {
  const postC5 = (f: Fixture) => asOrg(f.orgId, (tx) => domain.postOpeningBalances(tx, f.admin));
  const entryStates = async (f: Fixture) => {
    const rows = await sql<{ status: string; n: string }[]>`
      select status, count(*)::text as n from journal_entries
      where org_id = ${f.orgId} and source_type = 'opening_balance' group by status`;
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
  };
  const c5Rows = async (f: Fixture) => {
    const [r] = await sql<{ n: string }[]>`
      select count(*)::text as n from cutover_steps where org_id = ${f.orgId} and step_code = 'C5'`;
    return Number(r!.n);
  };

  it('test 18 FAIL: a party with an opening figure AND a re-entered pre-cutover document refuses C5, naming the party; nothing posts', async () => {
    const f = await fixture('c5double');
    const c = await mkCustomer(f, 'Double Counted Customer');
    await figure(f, { accountCode: '1210', storeId: f.storeA, direction: 'debit', amount: '800.00', partyType: 'customer', partyId: c.id });
    await settle3900(f);
    // A real pre-cutover document for the same customer: a payment received on 2026-12-15 (Dr 1110 / Cr 1210, party = the customer).
    await asOrg(f.orgId, (tx) =>
      domain.postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-12-15', sourceType: 'manual', sourceId: uid('pre'), idempotencyKey: uid('pre'),
        memo: 'pre-cutover payment', postedBy: f.adminId,
        lines: [
          { accountCode: '1110', storeId: f.storeA, debit: '100.00' },
          { accountCode: '1210', storeId: f.storeA, credit: '100.00', partyType: 'customer', partyId: c.id },
        ],
      } as Parameters<typeof domain.postEntry>[1]),
    );
    await attestC3P(f);
    const before = await entryStates(f);
    const err = await errorOf(postC5(f));
    expect(err, 'C5 posted although a party is double counted').toBeInstanceOf(RefusalError);
    expect(reason(err)).toContain(c.name);
    expect(await entryStates(f)).toEqual(before); // I7: every opening entry is still a draft
    expect(await c5Rows(f)).toBe(0);
  });

  it('test 18 POSITIVE CONTROL: the same figure with NO pre-cutover document posts', async () => {
    const f = await fixture('c5single');
    const c = await mkCustomer(f, 'Single Counted Customer');
    await figure(f, { accountCode: '1210', storeId: f.storeA, direction: 'debit', amount: '800.00', partyType: 'customer', partyId: c.id });
    await settle3900(f);
    await attestC3P(f);
    const r = await postC5(f);
    expect(r.posted).toBe(2); // the figure and the 3900 -> 3300 reconcile
    expect(await c5Rows(f)).toBe(1);
  });

  it('test 18a (M29): C5 is REFUSED without an attested C3P even when every register ties; attesting it lets the same post through', async () => {
    const f = await fixture('c5nothree');
    const s = await mkSupplier(f, 'Tied Supplier');
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '1000.00', partyType: 'supplier', partyId: s.id });
    await settle3900(f);
    const err = await errorOf(postC5(f));
    expect(err, 'C5 posted without C3P').toBeInstanceOf(RefusalError);
    expect(reason(err)).toMatch(/C3P/);
    expect(reason(err)).toMatch(/customer, supplier, loan and advance balances/i);
    expect(await entryStates(f)).toEqual({ draft: 2 });
    await expectHolds(f); // the refusal above was about C3P alone: every register ties
    await attestC3P(f);
    const r = await postC5(f);
    expect(r.posted).toBe(2);
    expect(await entryStates(f)).toEqual({ posted: 2 });
  });

  it('a register failure refuses C5 with the sentence (store, register, pesos); nothing posts and no C5 row is written', async () => {
    const f = await fixture('c5t2');
    await mkAsset(f, f.storeA, '312400.00');
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '300000.00' });
    await settle3900(f);
    await attestC3P(f);
    const before = await entryStates(f);
    const err = await errorOf(postC5(f));
    expect(err).toBeInstanceOf(RefusalError);
    expect(reason(err)).toContain(f.nameA);
    expect(reason(err)).toMatch(/fixed assets/i);
    expect(reason(err)).toMatch(peso('12400.00'));
    expect(await entryStates(f)).toEqual(before);
    expect(await c5Rows(f)).toBe(0);
  });

  it('with seven failures C5 shows the first FIVE sentences and a count of the rest ("and 2 more")', async () => {
    const f = await fixture('c5many');
    for (let i = 0; i < 7; i += 1) {
      const s = await mkSupplier(f, `Late Supplier ${i}`);
      await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '10.00', partyType: 'supplier', partyId: s.id, entryDate: '2026-12-31' });
    }
    await settle3900(f);
    await attestC3P(f);
    const err = await errorOf(postC5(f));
    expect(err).toBeInstanceOf(RefusalError);
    const msg = reason(err);
    expect(msg).toMatch(/and 2 more/i);
    expect((msg.match(/2026-12-31/g) ?? []).length, 'exactly five sentences are shown').toBe(5);
  });

  it('a shell left pending refuses C5 BY NAME (test 19, second half)', async () => {
    const f = await fixture('c5shell');
    const shell = await mkShell(f, f.storeA);
    const s = await mkSupplier(f, 'Some Supplier');
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '10.00', partyType: 'supplier', partyId: s.id });
    await settle3900(f);
    await attestC3P(f);
    const err = await errorOf(postC5(f));
    expect(err).toBeInstanceOf(RefusalError);
    expect(reason(err)).toContain(shell.name);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('test 18b - F1 verdict: a return of OPENING stock credits 1240, never 2120 (kills M31)', () => {
  /**
   * CHARACTERISATION TEST: it is GREEN today. F1 (DEF-624) is already unreachable because `deriveLineCreditBasis` returns
   * `supplier_advance` for a return with no delivery and `findByDeliveryItem` only reads `source = 'delivery'` layers. This pins
   * it so a later change to either function cannot reopen it silently. The layer is seeded in the exact shape S2's
   * `writeOpeningStock` writes (movement kind opening / source_type opening_count, layer source opening, provisional).
   * Movement and layer carry a date in the past so FIFO can consume them today; the real ones carry 2027-01-01.
   */
  it('receive nothing, hold an opening layer, return some to a supplier with no delivery: no 2120 line; the credit is 1240', async () => {
    const f = await fixture('f1');
    const supplier = await mkSupplier(f, 'Return Supplier');
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${uid('Pork')}, 'raw_material', 'kg', ${f.adminId}) returning id`;
    const sourceId = (await sql<{ id: string }[]>`select gen_random_uuid()::text as id`)[0]!.id;
    const [mv] = await sql<{ id: string }[]>`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${f.orgId}, ${f.storeA}, ${f.roomA}, ${item!.id}, '2026-06-01T00:00:00Z', 10, 'opening', 'opening_count', ${sourceId}, ${f.adminId})
      returning id`;
    await sql`
      insert into stock_layers (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id,
                                movement_id, is_provisional)
      values (${f.orgId}, ${f.storeA}, ${item!.id}, '2026-06-01T00:00:00Z', 10, 12.5, 10, 'opening', ${sourceId}, ${mv!.id}, true)`;

    const today = new Date().toISOString().slice(0, 10);
    const out = await asOrg(f.orgId, (tx) =>
      need<(tx: unknown, input: unknown) => Promise<{ ok: boolean; returnId?: string; reason?: string }>>('recordReturn')(tx, {
        storeId: f.storeA, supplierId: supplier.id, deliveryId: null, returnedOn: today, reason: 'wrong grade', actor: f.manager,
        lines: [{ itemId: item!.id, itemKind: 'raw_material', locationId: f.roomA, quantity: '4', deliveryLineId: null }],
      }),
    );
    expect(out.ok, `fixture: the return was refused (${out.reason})`).toBe(true);

    const legs = await sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
      select a.code, jl.debit::text, jl.credit::text, jl.party_id
      from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.source_type = 'supplier_return' and je.source_id = ${out.returnId!}`;
    expect(legs.map((l) => l.code), 'a return of opening stock wrote a 2120 line (F1 reopened)').not.toContain('2120');
    const adv = legs.find((l) => l.code === '1240');
    expect(adv, 'the credit should sit on 1240 (supplier advance)').toBeDefined();
    expect(Number(adv!.debit)).toBe(50); // 4 kg at 12.5 relieved at cost
    expect(adv!.party_id).toBe(supplier.id);
    expect(legs.find((l) => l.code === '1310')!.credit).toBe('50.00');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// AUDIT LEGS (coordinator, after the first green)
// ---------------------------------------------------------------------------------------------------------------------------
describe('audit 1 - a STALE C3P: party balances changed after the attestation', () => {
  it('attest C3P, then add a party figure: C5 refuses in words (changed since C3P, confirm again); re-attest posts', async () => {
    const f = await fixture('stale');
    const s = await mkSupplier(f, 'Stale Supplier');
    await figure(f, { accountCode: '2110', storeId: f.storeA, direction: 'credit', amount: '1000.00', partyType: 'supplier', partyId: s.id });
    await settle3900(f);
    await attestC3P(f);
    const p = await mkPerson(f, 'Late Advance', f.storeA);
    await figure(f, { accountCode: '1230', storeId: f.storeA, direction: 'debit', amount: '250.00', partyType: 'employee', partyId: p.id });
    await settle3900(f);
    const post = () => asOrg(f.orgId, (tx) => domain.postOpeningBalances(tx, f.admin));
    const err = await errorOf(post());
    expect(err, 'C5 posted on a C3P that predates a party figure').toBeInstanceOf(RefusalError);
    expect(reason(err)).toMatch(/changed/i);
    expect(reason(err)).toMatch(/C3P/);
    expect(reason(err)).toMatch(/confirm/i);
    await attestC3P(f);
    const r = await post();
    // Three entries, not four: the 2110 figure, the 1230 figure, and ONE 3900 -> 3300 reconcile for the single store (settle3900 removes
    // the first reconcile draft before re-adding it, so it is not counted twice). Same shape as the 'posted 2' cases elsewhere.
    expect(r.posted).toBe(3);
  });
});

describe('audit 2 - T7: a party-less cash/bank opening figure is listed as not checked, with a reason; T7 still holds', () => {
  it('a 1110 figure (cannot carry a party) appears in notChecked with account, amount and a reason naming the missing money account', async () => {
    const f = await fixture('t7noparty');
    await figure(f, { accountCode: '1110', storeId: f.storeA, direction: 'debit', amount: '900.00' });
    await settle3900(f);
    const t = await expectHolds(f);
    const row = t.notChecked?.find((r) => r.account === '1110');
    expect(row, 'a party-less 1110 figure is not listed under notChecked').toBeDefined();
    expect(row!.amount).toMatch(/900[.]00/);
    expect(row!.reason).toMatch(/money account/i);
  });
});

describe('audit 3 - T2/T3: a 1510 or 1400 opening line with a NULL store is compared, not skipped', () => {
  it('1510 with store_id NULL (the register has nothing for it) fails, naming the account', async () => {
    const f = await fixture('t2null');
    await rawOpeningDraft(f, { accountCode: '1510', storeId: null, direction: 'debit', amount: '5000.00', key: '1510null' });
    await expectFails(f, 'T2 null store', '1510');
  });
  it('1400 with store_id NULL fails, naming the account', async () => {
    const f = await fixture('t3null');
    await rawOpeningDraft(f, { accountCode: '1400', storeId: null, direction: 'debit', amount: '5000.00', key: '1400null' });
    await expectFails(f, 'T3 null store', '1400');
  });
});

describe('audit 5 - the double-counting guard only counts LIVE documents on the SAME control account', () => {
  const preDoc = (f: Fixture, lines: unknown[]) =>
    asOrg(f.orgId, (tx) =>
      domain.postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-12-15', sourceType: 'manual', sourceId: uid('pre'), idempotencyKey: uid('pre'),
        memo: 'pre-cutover', postedBy: f.adminId, lines,
      } as Parameters<typeof domain.postEntry>[1]),
    );
  const c5 = (f: Fixture) => asOrg(f.orgId, (tx) => domain.postOpeningBalances(tx, f.admin));
  const ready = async (f: Fixture) => {
    await settle3900(f);
    await attestC3P(f);
  };
  const custLines = (f: Fixture, c: { id: string }) => [
    { accountCode: '1110', storeId: f.storeA, debit: '100.00' },
    { accountCode: '1210', storeId: f.storeA, credit: '100.00', partyType: 'customer', partyId: c.id },
  ];

  it('a REVERSED pre-cutover document (original + its reversal) does not refuse C5', async () => {
    const f = await fixture('g5rev');
    const c = await mkCustomer(f, 'Reversed Doc Customer');
    await figure(f, { accountCode: '1210', storeId: f.storeA, direction: 'debit', amount: '800.00', partyType: 'customer', partyId: c.id });
    const { entryId } = await preDoc(f, custLines(f, c));
    await asOrg(f.orgId, (tx) => domain.reverseEntry(tx, { entryId, reason: 'entered in error', reversedBy: f.adminId }));
    await ready(f);
    const r = await c5(f);
    expect(r.posted, 'a reversed document was counted as double counting').toBe(2);
  });

  it('a REVERSED opening entry for the party is not an opening figure for the guard', async () => {
    const f = await fixture('g5revopen');
    const c = await mkCustomer(f, 'Old Opening Customer');
    // An opening entry for this customer that was posted and then reversed, plus a live pre-cutover document.
    const old = await asOrg(f.orgId, (tx) =>
      domain.postEntry(tx, {
        orgId: f.orgId, entryDate: '2026-12-10', sourceType: 'opening_balance', sourceId: uid('old'), idempotencyKey: uid('old'),
        memo: 'old opening', postedBy: f.adminId,
        lines: [
          { accountCode: '1210', storeId: f.storeA, debit: '50.00', partyType: 'customer', partyId: c.id },
          { accountCode: '3900', storeId: f.storeA, credit: '50.00' },
        ],
      } as Parameters<typeof domain.postEntry>[1]),
    );
    await asOrg(f.orgId, (tx) => domain.reverseEntry(tx, { entryId: old.entryId, reason: 'redo', reversedBy: f.adminId }));
    await preDoc(f, custLines(f, c));
    const sup = await mkSupplier(f, 'Plain Supplier');
    await figure(f, { accountCode: '1240', storeId: f.storeA, direction: 'debit', amount: '10.00', partyType: 'supplier', partyId: sup.id });
    await ready(f);
    const err = await errorOf(c5(f));
    expect(reason(err), 'a reversed opening line refused C5 as double counting').not.toContain(c.name);
  });

  it('POSITIVE CONTROL: a still-posted pre-cutover document for the same party and account refuses', async () => {
    const f = await fixture('g5live');
    const c = await mkCustomer(f, 'Live Doc Customer');
    await figure(f, { accountCode: '1210', storeId: f.storeA, direction: 'debit', amount: '800.00', partyType: 'customer', partyId: c.id });
    await preDoc(f, custLines(f, c));
    await ready(f);
    const err = await errorOf(c5(f));
    expect(err).toBeInstanceOf(RefusalError);
    expect(reason(err)).toContain(c.name);
  });

  it('a party whose old line is on a DIFFERENT party account (2130 reimbursements) does not refuse an opening on 1230', async () => {
    const f = await fixture('g5other');
    const p = await mkPerson(f, 'Reimbursed Person', f.storeA);
    await figure(f, { accountCode: '1230', storeId: f.storeA, direction: 'debit', amount: '300.00', partyType: 'employee', partyId: p.id });
    await preDoc(f, [
      { accountCode: '1110', storeId: f.storeA, debit: '100.00' },
      { accountCode: '2130', storeId: f.storeA, credit: '100.00', partyType: 'employee', partyId: p.id },
    ]);
    await ready(f);
    const r = await c5(f);
    expect(r.posted, 'an old line on another account was counted as double counting').toBe(2);
  });
});
