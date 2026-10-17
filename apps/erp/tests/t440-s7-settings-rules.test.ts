/**
 * T-440 S7 (TESTER) - parity fixture for every S7 rule set (settings, findings, reports; clock has none). Spec:
 * docs/tasks/440-live-field-checks.md section 3 (mechanism), Audit A5 (a sentence never echoes the typed value), the
 * "one rule definition used by client and server" ruling. Node, no database.
 *
 * The rule sets are IMPORTED (never copied). For each rule the table holds a passing value, failing values with the exact
 * sentence, and (for a required rule) the blank sentence. The test then proves, per rule:
 *   - checkField on the passing value is ok;  on each failing value it returns EXACTLY the sentence in the table;
 *   - the server half (assertFieldRules) throws a RefusalError whose userMessage === checkField(...).requirement (client === server);
 *   - the raw diagnostic is `<form>.<name>: <kind> check failed` and neither it nor the sentence contains the typed value.
 * Completeness: every rule of every set in the files has a row, and every row names a live rule.
 *
 * MUTANTS: a server check that re-words a sentence (userMessage !== requirement); an edited kept-verbatim sentence (`requires`);
 * `optional` ignored (a blank optional field refused / a blank required field passed); a sentence interpolating the typed value;
 * a min/max off by one (the boundary pairs); a rule dropped from a set (completeness); the tolerance pattern loosened.
 */
import { describe, expect, it } from 'vitest';
import * as settings from '../../../packages/domain/src/field-rules/settings';
import * as findings from '../../../packages/domain/src/field-rules/findings';
import * as reports from '../../../packages/domain/src/field-rules/reports';
import * as clock from '../../../packages/domain/src/field-rules/clock';
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

const TOL = 'A tolerance is a number from 0 to 1 with at most four decimals, for example 0.10 for 10%.';
const CAP = 'A cap is a whole number of days (0 or more), or empty for no limit.';
const KIND = 'A leave kind needs a short code (letters, digits and underscores) and a name.';
const TIN = 'A TIN must be 9-12 digits. Dashes and spaces are fine and are removed.';
const UNLINK = 'Say why this store is being unlinked, in under 500 characters.';
const NOTE = 'The note is required and may be at most 500 characters.';
const REF = 'The defect reference must look like DEF-123.';
const POS_ID = 'Choose or enter the POS store this store sells under.';
const POS_NAME = 'Give the POS store a name so people can recognise it.';
const POS_CHANNEL = "Choose the sales channel POS's sales land in.";
const POS_TAX = "Choose the tax type shown in the POS store's settings.";
const BLANK = '   ';

const ROWS: Record<string, Row> = {
  'settings.setOrganizationIdentity.tin': { ok: '123-456-789', stored: '123456789', bad: [['1234', TIN], ['abcdefghijk', TIN], ['1234567890123', TIN]] },
  'settings.setOrgUsageTolerance.tolerance': { ok: '0.10', bad: [['abc', TOL], ['1.5', TOL], ['-0.2', TOL], ['0.12345', TOL]], blank: TOL },
  'settings.setItemUsageTolerance.tolerance': { ok: '0.25', bad: [['abc', TOL], ['1.5', TOL], ['-0.2', TOL], ['0.12345', TOL]] },
  'settings.updateAttendanceConfig.effectiveFrom': { ok: '2026-07-01', bad: [['soon', 'The effective date must be a real date.']] },
  'settings.saveLeaveCap.monthlyCap': { ok: '30', bad: [['-1', CAP], ['1.5', CAP], ['367', CAP], ['abc', CAP]] },
  'settings.saveLeaveCap.yearlyCap': { ok: '30', bad: [['-1', CAP], ['1.5', CAP], ['367', CAP], ['abc', CAP]] },
  'settings.addLeaveType.label': { ok: 'Study leave', bad: [[BLANK, KIND]], blank: KIND },
  'settings.addLeaveType.code': { ok: 'study_2', bad: [['x', KIND], ['1abc', KIND], ['a-b', KIND]], blank: KIND },
  'settings.expenseCategory.category': { ok: 'Scooter rental', bad: [[BLANK, 'A category needs a name.']], blank: 'A category needs a name.' },
  'settings.salesChannel.name': { ok: 'Grab', bad: [[BLANK, 'A sales channel needs a name.']], blank: 'A sales channel needs a name.' },
  'settings.linkStoreToPos.posStoreId': { ok: 'POS-7', bad: [[BLANK, POS_ID]], blank: POS_ID },
  'settings.linkStoreToPos.posStoreName': { ok: 'Lipa POS', bad: [[BLANK, POS_NAME]], blank: POS_NAME },
  'settings.linkStoreToPos.salesChannelId': { ok: 'chan-1', bad: [[BLANK, POS_CHANNEL]], blank: POS_CHANNEL },
  'settings.linkStoreToPos.posTaxType': { ok: 'vat', bad: [[BLANK, POS_TAX]], blank: POS_TAX },
  'settings.unlinkStoreFromPos.reason': { ok: 'Moved to a new POS', bad: [[BLANK, UNLINK], ['q'.repeat(501), UNLINK]], blank: UNLINK },
  'settings.tender.name': { ok: 'GCash', bad: [[BLANK, 'Give the tender a name.']], blank: 'Give the tender a name.' },
  'settings.tender.kind': { ok: 'wallet', bad: [[BLANK, 'Choose whether this tender is cash or a wallet.']], blank: 'Choose whether this tender is cash or a wallet.' },
  'findings.createMissingClosedPeriod.reason': { ok: 'Books were never opened', bad: [[BLANK, 'Say why this month is being created now.']], blank: 'Say why this month is being created now.' },
  'findings.bookMissedMonth.reason': { ok: 'Charge was missed', bad: [[BLANK, 'Say why this month is being booked now.']], blank: 'Say why this month is being booked now.' },
  'reports.recordDualRunDisposition.ref': { ok: 'DEF-123', bad: [['def-1', REF], ['BUG-9', REF], ['321', REF], ['DEF-12x', REF]], blank: REF },
  'reports.recordDualRunDisposition.note': { ok: 'Old system rounds up', bad: [['z'.repeat(501), NOTE]], blank: NOTE },
};

function setsOf(mod: Record<string, unknown>): FieldRuleSetLike[] {
  return Object.values(mod).filter(
    (v): v is FieldRuleSetLike => typeof v === 'object' && v !== null && typeof (v as { form?: unknown }).form === 'string',
  );
}
const FILES: Record<string, Record<string, unknown>> = { settings, findings, reports };
const ALL_SETS = Object.values(FILES).flatMap(setsOf);
const keyOf = (set: FieldRuleSetLike, r: FieldRule) => `${set.form}.${r.name}`;
const ALL_RULES = ALL_SETS.flatMap((set) => rulesOf(set).map((r) => ({ set, rule: r, key: keyOf(set, r) })));

/** The set's every rule filled with its passing value, so one rule can be broken at a time. */
function goodInput(set: FieldRuleSetLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = ROWS[keyOf(set, r)]?.ok ?? '';
  return out;
}
const echoes = (text: string, typed: string) => typed.trim() !== '' && text.includes(typed);
const ruleOf = (key: string): FieldRule => {
  const found = ALL_RULES.find((r) => r.key === key);
  if (!found) throw new Error(`no rule ${key}`);
  return found.rule;
};

describe('T-440 S7 settings: the table covers exactly the rules that exist', () => {
  it('clock declares no rules (its forms had no ruled field)', () => {
    expect(setsOf(clock as Record<string, unknown>)).toEqual([]);
  });
  it('every rule of every S7 set has a row (mutant: a rule added without a fixture)', () => {
    expect(ALL_RULES.filter((r) => !ROWS[r.key]).map((r) => r.key)).toEqual([]);
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

describe('T-440 S7 settings: client rule === server refusal, exact sentences, never the typed value', () => {
  for (const { set, rule: r, key } of ALL_RULES) {
    const row = ROWS[key];
    if (!row) continue;
    describe(key, () => {
      it('passes its good value and stores the normalised form (mutant: strip removed / value not trimmed)', () => {
        const want = row.stored === undefined ? row.ok : row.stored;
        expect(checkField(r, row.ok)).toEqual({ ok: true, value: want });
        expect(assertFieldRules(set, goodInput(set))[r.name]).toBe(want);
      });

      for (const [value, sentence] of row.bad) {
        const shown = value.length > 20 ? `${value.slice(0, 3)}... (${value.length} chars)` : JSON.stringify(value);
        it(`refuses ${shown} with the exact sentence, same on the server (mutant: re-worded / edited server sentence)`, () => {
          const c = checkField(r, value);
          expect(c.ok).toBe(false);
          if (c.ok) return;
          expect(c.requirement).toBe(sentence);
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [r.name]: value });
          } catch (e) {
            thrown = e;
          }
          expect(thrown, 'the server must refuse').toBeInstanceOf(RefusalError);
          const err = thrown as RefusalError;
          expect(err.userMessage).toBe(c.requirement);
          expect(err.message).toBe(`${set.form}.${r.name}: ${r.kind} check failed`);
          // A5: nothing the person typed comes back in a sentence, a progress line or the raw diagnostic.
          for (const text of [c.requirement, c.progress, err.message, err.userMessage]) {
            expect(echoes(text, value), 'a sentence must not contain the typed value').toBe(false);
          }
        });
      }

      if (r.optional) {
        it('a blank passes and is stored as null (mutant: optional ignored)', () => {
          expect(checkField(r, '')).toEqual({ ok: true, value: null });
          expect(checkField(r, BLANK)).toEqual({ ok: true, value: null });
          expect(assertFieldRules(set, { ...goodInput(set), [r.name]: '' })[r.name]).toBeNull();
        });
      } else {
        it('a blank is refused with the blank sentence, same on the server (mutant: optional ignored the other way)', () => {
          const c = checkField(r, '');
          expect(c.ok).toBe(false);
          if (c.ok) return;
          expect(c.requirement).toBe(row.blank ?? `${r.label} is required.`);
          expect(c.progress).toBe('Required');
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [r.name]: '' });
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

describe('T-440 S7 settings: boundaries', () => {
  it('a tolerance accepts 0, 1, 1.0000 and 0.0001, refuses 1.0001 and 0.00001 (mutant: pattern loosened / <= for <)', () => {
    for (const r of [ruleOf('settings.setOrgUsageTolerance.tolerance'), ruleOf('settings.setItemUsageTolerance.tolerance')]) {
      for (const good of ['0', '1', '1.0000', '0.0001', '0.9999']) expect(checkField(r, good).ok, good).toBe(true);
      for (const bad of ['1.0001', '0.00001', '2', '.5']) expect(checkField(r, bad).ok, bad).toBe(false);
    }
  });
  it('the org tolerance is required and the item tolerance may be blank (mutant: optional swapped)', () => {
    expect(checkField(ruleOf('settings.setOrgUsageTolerance.tolerance'), '').ok).toBe(false);
    expect(checkField(ruleOf('settings.setItemUsageTolerance.tolerance'), '')).toEqual({ ok: true, value: null });
  });
  it('a leave cap accepts 0 and 366, refuses 367 and -1 (mutant: off by one on max / min)', () => {
    for (const k of ['settings.saveLeaveCap.monthlyCap', 'settings.saveLeaveCap.yearlyCap']) {
      expect(checkField(ruleOf(k), '0').ok).toBe(true);
      expect(checkField(ruleOf(k), '366').ok).toBe(true);
      expect(checkField(ruleOf(k), '367').ok).toBe(false);
      expect(checkField(ruleOf(k), '-1').ok).toBe(false);
    }
  });
  it('the unlink reason and the disposition note accept exactly 500 characters and refuse 501 (mutant: <= for < on max)', () => {
    for (const k of ['settings.unlinkStoreFromPos.reason', 'reports.recordDualRunDisposition.note']) {
      expect(checkField(ruleOf(k), 'a'.repeat(500)).ok).toBe(true);
      expect(checkField(ruleOf(k), 'a'.repeat(501)).ok).toBe(false);
    }
  });
  it('the TIN accepts 9 and 12 digits and refuses 8 and 13 (mutant: boundary off by one)', () => {
    const r = ruleOf('settings.setOrganizationIdentity.tin');
    expect(checkField(r, '1'.repeat(9)).ok).toBe(true);
    expect(checkField(r, '1'.repeat(12)).ok).toBe(true);
    expect(checkField(r, '1'.repeat(8)).ok).toBe(false);
    expect(checkField(r, '1'.repeat(13)).ok).toBe(false);
  });
  it('the leave code accepts 2 and 40 characters, refuses 1 and 41 (mutant: length bound dropped from the pattern)', () => {
    const r = ruleOf('settings.addLeaveType.code');
    expect(checkField(r, 'ab').ok).toBe(true);
    expect(checkField(r, `a${'b'.repeat(39)}`).ok).toBe(true);
    expect(checkField(r, 'a').ok).toBe(false);
    expect(checkField(r, `a${'b'.repeat(40)}`).ok).toBe(false);
  });
});
