/**
 * T-440 S3 (TESTER) - parity fixture for every S3 "people" rule set (staff, payroll, attendance, admin, setup, owners; sign-in has none).
 * Spec: docs/tasks/440-live-field-checks.md section 3 (mechanism), Audit A5 (non-money values never echo; Ian permits quoted money amounts), the
 * "one rule definition used by client and server" ruling. Node, no database.
 *
 * The rule sets are IMPORTED (never copied). For each rule the table below holds a passing value, failing values with the exact
 * sentence, and (for a required rule) the blank sentence. The test then proves, per rule:
 *   - checkField on the passing value is ok;  on each failing value it returns EXACTLY the sentence in the table;
 *   - the server half (assertFieldRules) throws a RefusalError whose userMessage === checkField(...).requirement (client === server);
 *   - the raw diagnostic is `<form>.<name>: <kind> check failed` and neither it nor the sentence contains the typed value.
 * Completeness: every rule of every set in the six files has a row, and every row names a live rule (a rule added or dropped
 * without a row goes red).
 *
 * MUTANTS: a server check that re-words a sentence (userMessage !== requirement); an edited kept-verbatim sentence (`requires`);
 * `optional` ignored (a blank optional field refused / a blank required field passed); a sentence interpolating the typed value;
 * a min/max off by one (the boundary pair); a rule dropped from a set (completeness); notAfterToday ignored on a leave record.
 */
import { describe, expect, it } from 'vitest';
import * as staff from '../../../packages/domain/src/field-rules/staff';
import * as payroll from '../../../packages/domain/src/field-rules/payroll';
import * as attendance from '../../../packages/domain/src/field-rules/attendance';
import * as admin from '../../../packages/domain/src/field-rules/admin';
import * as setup from '../../../packages/domain/src/field-rules/setup';
import * as owners from '../../../packages/domain/src/field-rules/owners';
import * as signIn from '../../../packages/domain/src/field-rules/sign-in';
import { checkField, rulesOf, type FieldRule, type FieldRuleSetLike } from '../../../packages/domain/src/field-rules/check';
import { assertFieldRules } from '../../../packages/domain/src/shared/field-rules-assert';
import { RefusalError } from '../../../packages/domain/src/shared/refusal';

type Row = {
  /** A passing value, and what the server stores for it (default: the same). */
  ok: string;
  stored?: string | null;
  /** Failing values with the exact sentence each must give. */
  bad: Array<[value: string, sentence: string]>;
  /** The sentence for a blank (required rules only). Default `${label} is required.` */
  blank?: string;
};

const REAL = (what: string) => `${what} must be a real date.`;
const EFFECTIVE = 'The effective date must be a date, like 2026-07-01.';
const REQ = (what: string) => `${what} is required.`;
const DATE = '2026-07-01';
const RATE_SAYS = 'A rate is a decimal from 0 to 1: enter 0.05 for 5%.';
const DASH = '—';

const ROWS: Record<string, Row> = {
  // ---- staff ----
  'staff.setGovernmentIds.sssNo': { ok: '34-1234567-8', stored: '3412345678', bad: [['123', 'The SSS number must be 10 digits.'], ['abc', 'The SSS number must be 10 digits.']] },
  'staff.setGovernmentIds.philhealthNo': { ok: '123456789012', bad: [['5555', 'The PhilHealth number must be 12 digits.']] },
  'staff.setGovernmentIds.pagibigNo': { ok: '123456789012', bad: [['5555', 'The Pag-IBIG number must be 12 digits.']] },
  'staff.setGovernmentIds.tin': { ok: '123-456-789', stored: '123456789', bad: [['1234', 'The TIN must be 9 to 12 digits.'], ['1234567890123', 'The TIN must be 9 to 12 digits.']] },
  'staff.hire.startedOn': { ok: DATE, bad: [['2026-13-45', REAL('The start date')], ['soon', REAL('The start date')]] },
  'staff.renamePerson.lastName': { ok: 'Reyes', bad: [['   ', REQ('The last name')]] },
  'staff.renamePerson.firstName': { ok: 'Ana', bad: [['   ', REQ('The first name')]] },
  'staff.issuePin.pin': { ok: '123456', bad: [['12ab', 'A PIN must be exactly 6 digits.'], ['12345', 'A PIN must be exactly 6 digits.'], ['1234567', 'A PIN must be exactly 6 digits.']], blank: 'A PIN must be exactly 6 digits.' },
  'staff.upsertStorePosition.name': { ok: 'Cashier', bad: [['  ', 'A position needs a name.']], blank: 'A position needs a name.' },
  'staff.endEmployment.endedOn': { ok: DATE, bad: [['nope', REAL('The end date')]] },
  'staff.endEmployment.employmentStatus': { ok: 'resigned', bad: [['  ', REQ('The status')]] },
  'staff.revokeCredential.reason': { ok: 'Lost card', bad: [['  ', REQ('The reason')]] },
  'staff.enrolCard.cardId': {
    ok: 'CARD-1',
    bad: [['  ', `A card needs an id ${DASH} that is the whole credential.`]],
    blank: `A card needs an id ${DASH} that is the whole credential.`,
  },

  // ---- payroll ----
  'payroll.setPayRate.amount': { ok: '350.00', bad: [['-7', 'The pay rate must be an amount of 0.01 or more.']] },
  'payroll.setPayRate.effectiveFrom': { ok: DATE, bad: [['soon', EFFECTIVE]], blank: EFFECTIVE },
  'payroll.addStatutoryRate.effectiveFrom': { ok: DATE, bad: [['soon', EFFECTIVE]], blank: EFFECTIVE },
  'payroll.addStatutoryRate.eeRate': { ok: '0.05', bad: [['abc', 'The employee rate must be a number from 0 to 1.'], ['-0.5', RATE_SAYS]] },
  'payroll.addStatutoryRate.erRate': { ok: '0.10', bad: [['abc', 'The employer rate must be a number from 0 to 1.']] },
  'payroll.addStatutoryRate.floor': { ok: '5000.00', bad: [['12x', `The floor ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.ceiling': { ok: '35000.00', bad: [['12x', `The ceiling ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.step': { ok: '500.00', bad: [['12x', `The step ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.lowThreshold': { ok: '1500.00', bad: [['12x', `The low-band threshold ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.lowEeRate': { ok: '0.01', bad: [['abc', 'The low-band employee rate must be a number from 0 to 1.']] },
  'payroll.addStatutoryRate.ecThreshold': { ok: '14750.00', bad: [['12x', `The EC threshold ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.ecLow': { ok: '10.00', bad: [['12x', `The lower EC amount ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.ecHigh': { ok: '30.00', bad: [['12x', `The higher EC amount ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] },
  'payroll.addStatutoryRate.sourceRef': {
    ok: 'SSS Circular 2025-001',
    bad: [['  ', 'Say where this rate comes from (the circular or law), so it can be checked.']],
    blank: 'Say where this rate comes from (the circular or law), so it can be checked.',
  },
  'payroll.addWithholdingBracketSet.effectiveFrom': { ok: DATE, bad: [['soon', EFFECTIVE]], blank: EFFECTIVE },
  'payroll.addWithholdingBracketSet.rows': { ok: '10417, 0, 0.15', bad: [['  ', 'Give the bracket rows, one per line.']], blank: 'Give the bracket rows, one per line.' },
  'payroll.addWithholdingBracketSet.sourceRef': { ok: 'BIR RR 11-2018', bad: [['  ', 'Say where the table comes from.']], blank: 'Say where the table comes from.' },
  'payroll.addMinimumWage.effectiveFrom': { ok: DATE, bad: [['soon', EFFECTIVE]], blank: EFFECTIVE },
  'payroll.addMinimumWage.dailyRate': { ok: '645.00', bad: [['-7', 'The minimum daily wage must be an amount of 0.01 or more.']] },
  'payroll.addMinimumWage.wageOrderRef': { ok: 'NCR-26', bad: [['  ', REQ('The wage order')]] },
  'payroll.postSeparation.separationPayAmount': { ok: '1500.00', bad: [['-7', 'The separation pay must be an amount of 0 or more.']] },
  // T-193 S5: record a statutory payment.
  'payroll.recordStatutoryPayment.month': { ok: DATE, bad: [['soon', 'Choose the month this payment is for.']], blank: 'Choose the month this payment is for.' },
  'payroll.recordStatutoryPayment.paidOn': { ok: DATE, bad: [['soon', 'The payment date must be a date, like 2026-11-10.']], blank: 'The payment date must be a date, like 2026-11-10.' },
  'payroll.recordStatutoryPayment.referenceNo': { ok: 'PRN-2026-10-0001', bad: [['  ', 'Enter the agency receipt or payment reference number.']], blank: 'Enter the agency receipt or payment reference number.' },
  'payroll.recordStatutoryPayment.penalty': { ok: '63.60', bad: [['-7', 'The penalty must be an amount of 0 or more.']] },
  'payroll.recordStatutoryPayment.notes': { ok: 'Paid at the SSS branch', bad: [] },

  // ---- attendance ----
  'attendance.approveOvertime.approvedOtMinutes': {
    ok: '30',
    bad: [
      ['1.5', 'The minutes to pay must be a whole number from 0 to 99999.'],
      ['100000', 'The minutes to pay must be a whole number from 0 to 99999.'],
      ['-5', 'The minutes to pay must be a whole number from 0 to 99999.'],
    ],
  },
  'attendance.setStartAnchor.chosenAnchorMinute': {
    ok: '480',
    bad: [['abc', 'The paid-from minute must be a whole number from 0 to 99999.'], ['100000', 'The paid-from minute must be a whole number from 0 to 99999.']],
  },
  'attendance.approveEarlyOut.effectiveOutMinute': {
    ok: '1020',
    bad: [['abc', 'The paid-until minute must be a whole number from 0 to 99999.'], ['100000', 'The paid-until minute must be a whole number from 0 to 99999.']],
  },
  'attendance.discardEvent.reason': { ok: 'Duplicate tap', bad: [['  ', REQ('The reason')]] },
  'attendance.revokeTerminal.reason': { ok: 'Device lost', bad: [['  ', REQ('The reason')]] },
  'attendance.requestLeave.from': { ok: DATE, bad: [['soon', REAL('The first day')]] },
  'attendance.requestLeave.to': { ok: DATE, bad: [['soon', REAL('The last day')]] },
  'attendance.requestLeave.birthDate': { ok: '2026-03-04', bad: [['soon', REAL('The date of the birth')]] },
  'attendance.recordLeave.from': { ok: '2020-01-02', bad: [['2999-01-01', "The first day can't be after today."], ['soon', REAL('The first day')]] },
  'attendance.recordLeave.to': { ok: '2020-01-02', bad: [['2999-01-01', "The last day can't be after today."], ['soon', REAL('The last day')]] },
  'attendance.recordLeave.birthDate': { ok: '2026-03-04', bad: [['soon', REAL('The date of the birth')]] },
  'attendance.voidLeave.reason': { ok: 'Entered twice', bad: [['  ', REQ('The reason')]] },

  // ---- admin ----
  'admin.copyDefaults.sourceStoreId': { ok: 'store-1', bad: [['  ', 'Choose a store to copy from.']], blank: 'Choose a store to copy from.' },
  'admin.createStore.code': { ok: 'LIPA', bad: [['  ', REQ('The code')], ['ABCDEFGHIJKLMNOPQ', 'The code must be at most 16 characters.']] },
  'admin.createStore.name': { ok: 'Lipa', bad: [['  ', REQ('The name')]] },
  'admin.createStore.openingDate': { ok: DATE, bad: [['soon', REAL('The opening date')]] },
  'admin.createStore.unremittedCeiling': { ok: '50000.00', bad: [['-7', 'The unremitted ceiling must be an amount of 0.01 or more.']] },
  'admin.updateStore.name': { ok: 'Lipa', bad: [['  ', REQ('The name')]] },
  'admin.updateStore.tinBranchCode': {
    ok: '0-0-1',
    stored: '001',
    bad: [['12', 'The TIN branch code must be 3 to 5 digits.'], ['123456', 'The TIN branch code must be 3 to 5 digits.'], ['abc', 'The TIN branch code must be 3 to 5 digits.']],
  },
  'admin.setStoreOpeningDate.openingDate': { ok: DATE, bad: [['soon', REAL('The opening date')]] },
  'admin.assignRole.role': { ok: 'manager', bad: [['  ', 'Pick a role.']], blank: 'Pick a role.' },
  'admin.revokeGrant.reason': {
    ok: 'No longer needed',
    bad: [['  ', `Revoking a grant needs a reason ${DASH} a revoked grant nobody can explain is not an audit trail.`]],
    blank: `Revoking a grant needs a reason ${DASH} a revoked grant nobody can explain is not an audit trail.`,
  },
  'admin.unlinkCredential.reason': {
    ok: 'Left the company',
    bad: [['  ', `Unlinking a sign-in account needs a reason ${DASH} a revoked credential nobody can explain is not an audit trail.`]],
    blank: `Unlinking a sign-in account needs a reason ${DASH} a revoked credential nobody can explain is not an audit trail.`,
  },
  'admin.linkFirebase.uid': { ok: 'abc123', bad: [['  ', REQ('The Firebase uid')]] },

  // ---- setup ----
  'setup.createFirstRun.code': { ok: 'SHAREAT', bad: [['  ', REQ('The organisation code')]] },
  'setup.createFirstRun.name': { ok: 'Shareat', bad: [['  ', REQ('The organisation name')]] },
  'setup.createFirstRun.adminDisplayName': { ok: 'Ian', bad: [['  ', REQ('Your name')]] },
  'setup.createFirstRun.storeCode': { ok: 'LIPA', bad: [['  ', REQ('The first store code')]] },
  'setup.createFirstRun.storeName': { ok: 'Lipa', bad: [['  ', REQ('The first store name')]] },
  'setup.createFirstRun.pin': { ok: '123456', bad: [['12ab', 'The PIN must be exactly 6 digits.'], ['12345', 'The PIN must be exactly 6 digits.']], blank: 'The PIN must be exactly 6 digits.' },

  // ---- owners ----
  'owners.createOwner.storeId': { ok: 'store-1', bad: [['  ', 'Choose a store.']], blank: 'Choose a store.' },
  'owners.createOwner.personId': { ok: 'person-1', bad: [['  ', 'Choose who this is.']], blank: 'Choose who this is.' },
  'owners.createOwner.ownershipPercentage': {
    ok: '25.5',
    bad: [
      ['abc', 'The ownership percentage must be a number from 0.001 to 100.'],
      ['150', 'The ownership percentage must be a number from 0.001 to 100.'],
      ['0.0005', 'The ownership percentage must be a number from 0.001 to 100.'],
    ],
  },
  'owners.createOwner.drawingLimit': { ok: '20000.00', bad: [['-7', 'A drawing limit has to be greater than zero.']] },
  'owners.settle.how': { ok: 'cash', bad: [['  ', 'Choose how this is being settled.']], blank: 'Choose how this is being settled.' },
  'owners.settle.amount': { ok: '500.00', bad: [['-7', 'The amount settled must be an amount of 0.01 or more.']] },
  'owners.settle.on': { ok: DATE, bad: [['soon', REAL('The date')]] },
  'owners.settle.adminPin': { ok: '123456', bad: [['12ab', 'A PIN must be exactly 6 digits.'], ['12345', 'A PIN must be exactly 6 digits.']], blank: 'A PIN must be exactly 6 digits.' },
  'owners.contribution.amount': { ok: '500.00', bad: [['-7', 'The contribution amount must be an amount of 0.01 or more.']] },
  'owners.contribution.intoMoneyAccountId': { ok: 'acct-1', bad: [['  ', REQ('The account')]] },
  'owners.contribution.on': { ok: DATE, bad: [['soon', REAL('The date')]] },
  'owners.drawing.amount': { ok: '500.00', bad: [['-7', 'A drawing has to be greater than zero.']] },
  'owners.drawing.fromMoneyAccountId': { ok: 'acct-1', bad: [['  ', REQ('The account')]] },
  'owners.drawing.on': { ok: DATE, bad: [['soon', REAL('The date')]] },
  'owners.closeMonth.acknowledgedAmount': { ok: '1200.00', bad: [['-7', 'The agreed amount must be an amount of 0 or more.']] },
  'owners.closeMonth.on': { ok: DATE, bad: [['soon', REAL('The date')]] },
};

/** Every set exported by the six area files, with its file. */
function setsOf(mod: Record<string, unknown>): FieldRuleSetLike[] {
  return Object.values(mod).filter(
    (v): v is FieldRuleSetLike => typeof v === 'object' && v !== null && typeof (v as { form?: unknown }).form === 'string',
  );
}
const FILES: Record<string, Record<string, unknown>> = { staff, payroll, attendance, admin, setup, owners };
const ALL_SETS = Object.values(FILES).flatMap(setsOf);
const keyOf = (set: FieldRuleSetLike, rule: FieldRule) => `${set.form}.${rule.name}`;
const ALL_RULES = ALL_SETS.flatMap((set) => rulesOf(set).map((rule) => ({ set, rule, key: keyOf(set, rule) })));

/** The set's every rule filled with its passing value, so one rule can be broken at a time. */
function goodInput(set: FieldRuleSetLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = ROWS[keyOf(set, r)]?.ok ?? '';
  return out;
}
const echoes = (text: string, typed: string) => typed.trim() !== '' && text.includes(typed);

describe('T-440 S3 people: the table covers exactly the rules that exist', () => {
  it('sign-in declares no rules (its forms are cross-field or have none)', () => {
    expect(setsOf(signIn as Record<string, unknown>)).toEqual([]);
  });
  it('every rule of every S3 set has a row (mutant: a rule added without a fixture)', () => {
    const missing = ALL_RULES.filter((r) => !ROWS[r.key]).map((r) => r.key);
    expect(missing).toEqual([]);
  });
  it('every row names a live rule (mutant: a rule dropped from a set while its fixture stays)', () => {
    const live = new Set(ALL_RULES.map((r) => r.key));
    expect(Object.keys(ROWS).filter((k) => !live.has(k))).toEqual([]);
  });
  it('set forms are unique, so a row key is unambiguous', () => {
    const forms = ALL_SETS.map((s) => s.form);
    expect(new Set(forms).size).toBe(forms.length);
  });
});

describe('T-440 S3 people: client rule === server refusal, exact sentences, money-only input quoting', () => {
  for (const { set, rule, key } of ALL_RULES) {
    const row = ROWS[key];
    if (!row) continue;
    describe(key, () => {
      it('passes its good value and stores the normalised form (mutant: strip removed / value not trimmed)', () => {
        const want = row.stored === undefined ? row.ok : row.stored;
        expect(checkField(rule, row.ok)).toEqual({ ok: true, value: want });
        expect(assertFieldRules(set, goodInput(set))[rule.name]).toBe(want);
      });

      for (const [value, sentence] of row.bad) {
        it(`refuses ${JSON.stringify(value)} with the exact sentence, same on the server (mutant: re-worded / edited server sentence)`, () => {
          const c = checkField(rule, value);
          expect(c.ok).toBe(false);
          if (c.ok) return;
          expect(c.requirement).toBe(sentence);
          // The server half, with every other field good so THIS rule is the first to fail.
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [rule.name]: value });
          } catch (e) {
            thrown = e;
          }
          expect(thrown, 'the server must refuse').toBeInstanceOf(RefusalError);
          const err = thrown as RefusalError;
          expect(err.userMessage).toBe(c.requirement);
          expect(err.message).toBe(`${set.form}.${rule.name}: ${rule.kind} check failed`);
          // A5: nothing the person typed comes back in a sentence, a progress line or the raw diagnostic.
          for (const text of (rule.kind === 'money' ? [c.progress, err.message] : [c.requirement, c.progress, err.message, err.userMessage])) {
            expect(echoes(text, value), `"${text}" must not contain the typed value`).toBe(false);
          }
        });
      }

      if (rule.optional) {
        it('a blank passes and is stored as null (mutant: optional ignored)', () => {
          expect(checkField(rule, '')).toEqual({ ok: true, value: null });
          expect(checkField(rule, '   ')).toEqual({ ok: true, value: null });
          expect(assertFieldRules(set, { ...goodInput(set), [rule.name]: '' })[rule.name]).toBeNull();
        });
      } else {
        it('a blank is refused with the blank sentence, same on the server (mutant: optional ignored the other way)', () => {
          const c = checkField(rule, '');
          expect(c.ok).toBe(false);
          if (c.ok) return;
          if (rule.kind === 'money') {
            // The money blank sentence is parseMoneyInput's own; pin that it names the field.
            expect(c.requirement.toLowerCase()).toContain(rule.label.toLowerCase().replace(/^the /, ''));
          } else {
            expect(c.requirement).toBe(row.blank ?? REQ(rule.label));
          }
          expect(c.progress).toBe('Required');
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [rule.name]: '' });
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(RefusalError);
          expect((thrown as RefusalError).userMessage).toBe(c.requirement);
        });
      }
    });
  }
});

describe('T-440 S3 people: boundaries and the Manila date', () => {
  const rule = (key: string): FieldRule => {
    const found = ALL_RULES.find((r) => r.key === key);
    if (!found) throw new Error(`no rule ${key}`);
    return found.rule;
  };
  it('the minute boxes accept 0 and 99999 and refuse 100000 (mutant: <= for < on max)', () => {
    const r = rule('attendance.approveOvertime.approvedOtMinutes');
    expect(checkField(r, '0').ok).toBe(true);
    expect(checkField(r, '99999').ok).toBe(true);
    expect(checkField(r, '100000').ok).toBe(false);
  });
  it('the ownership percentage accepts 100 and 0.001, refuses 100.001 and 0.0009 (mutant: boundary off by one)', () => {
    const r = rule('owners.createOwner.ownershipPercentage');
    expect(checkField(r, '100').ok).toBe(true);
    expect(checkField(r, '0.001').ok).toBe(true);
    expect(checkField(r, '100.001').ok).toBe(false);
    expect(checkField(r, '0.0009').ok).toBe(false);
  });
  it('the store code accepts exactly 16 characters and refuses 17 (mutant: <= for < on max)', () => {
    const r = rule('admin.createStore.code');
    expect(checkField(r, 'A'.repeat(16)).ok).toBe(true);
    expect(checkField(r, 'A'.repeat(17)).ok).toBe(false);
  });
  it('a money rule with min 0.01 refuses zero and accepts 0.01; min 0 accepts zero (mutant: Number(x) > 0 for the money parse)', () => {
    const wage = rule('payroll.addMinimumWage.dailyRate');
    expect(checkField(wage, '0').ok).toBe(false);
    expect(checkField(wage, '0.01').ok).toBe(true);
    expect(checkField(rule('payroll.postSeparation.separationPayAmount'), '0').ok).toBe(true);
  });
  it('a recorded absence refuses tomorrow and accepts today, on the Manila date (mutant: notAfterToday ignored / UTC date)', async () => {
    const { toBusinessDate } = await import('@shareat/core/datetime');
    const today = toBusinessDate();
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const r = rule('attendance.recordLeave.from');
    expect(checkField(r, today).ok).toBe(true);
    const tomorrow = checkField(r, next);
    expect(tomorrow.ok).toBe(false);
    if (!tomorrow.ok) expect(tomorrow.requirement).toBe("The first day can't be after today.");
    // A REQUESTED leave may start in the future.
    expect(checkField(rule('attendance.requestLeave.from'), next).ok).toBe(true);
  });
  it('digits strip dashes and spaces before the length check (mutant: strip removed)', () => {
    expect(checkField(rule('staff.setGovernmentIds.sssNo'), ' 34 1234567 8 ')).toEqual({ ok: true, value: '3412345678' });
  });
  it('the administrator PIN on the settle form is optional but a typed one must be 6 digits (Q4: required-only-for-write-off stays on the server)', () => {
    const pin = rule('owners.settle.adminPin');
    expect(checkField(pin, '').ok).toBe(true);
    expect(checkField(pin, '123').ok).toBe(false);
  });
});
