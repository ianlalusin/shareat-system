/**
 * T-440 S5 (TESTER) - parity fixture for every S5 rule set (inventory, items, commissary, wastage, cutover, menu). Spec:
 * docs/tasks/440-live-field-checks.md section 3, Audit A5 (non-money values never echo; Ian permits quoted money amounts), "one rule definition used
 * by client and server". Node, no database.
 *
 * The rule sets are IMPORTED, never copied. For each rule the table holds a passing value, failing values with the exact
 * sentence, and (for a required rule) the blank sentence. The test then proves, per rule:
 *   - checkField on the passing value is ok (and trimmed); on each failing value it returns EXACTLY the table's sentence;
 *   - the server half (assertFieldRules) throws a RefusalError whose userMessage === checkField(...).requirement (client === server);
 *   - the raw diagnostic is `<form>.<name>: <kind> check failed`, and no sentence or diagnostic contains the typed value.
 * Completeness: every rule of every set has a row and every row names a live rule.
 *
 * MUTANTS: a server check that re-words a sentence (userMessage !== requirement); an edited kept-verbatim sentence; `optional`
 * ignored (a blank optional field refused / a blank required field passed); a sentence interpolating the typed value; a
 * min/max off by one (the boundary pairs); a rule dropped from a set (completeness); `integer` dropped.
 */
import { describe, expect, it } from 'vitest';
import * as inventory from '../../../packages/domain/src/field-rules/inventory';
import * as items from '../../../packages/domain/src/field-rules/items';
import * as commissary from '../../../packages/domain/src/field-rules/commissary';
import * as wastage from '../../../packages/domain/src/field-rules/wastage';
import * as cutover from '../../../packages/domain/src/field-rules/cutover';
import * as menu from '../../../packages/domain/src/field-rules/menu';
import { checkField, rulesOf, type FieldRule, type FieldRuleSetLike } from '../../../packages/domain/src/field-rules/check';
import { assertFieldRules } from '../../../packages/domain/src/shared/field-rules-assert';
import { RefusalError } from '../../../packages/domain/src/shared/refusal';

type Row = {
  ok: string;
  stored?: string | null;
  bad: Array<[value: string, sentence: string]>;
  /** The sentence for a blank (required rules only). */
  blank?: string;
};

const BLANK = '   ';
const MONEY_BAD = (label: string): [string, string] => ['abc', `${label} — "abc" is not a valid amount. Use at most two decimal places.`];
const MONEY_BLANK = (label: string) => `${label} — can't be left blank. Enter an amount.`;
const REAL_DATE = (label: string): [string, string] => ['soon', `${label} must be a real date.`];
/** A required text rule that carries its own sentence: blank and whitespace both give it. */
const req = (sentence: string): Row => ({ ok: 'abc', bad: [[BLANK, sentence]], blank: sentence });
const opt = (): Row => ({ ok: 'abc', bad: [] });
const date = (label: string): Row => ({ ok: '2026-10-01', bad: [REAL_DATE(label)], blank: `${label} is required.` });
const optDate = (label: string): Row => ({ ok: '2026-10-01', bad: [REAL_DATE(label)] });
/** number, min 0 */
const num0 = (label: string): Row => ({
  ok: '3.5',
  bad: [['abc', `${label} must be a number of 0 or more.`], ['-1', `${label} must be a number of 0 or more.`]],
  blank: `${label} is required.`,
});
const optNum0 = (label: string): Row => ({ ok: '3.5', bad: [['abc', `${label} must be a number of 0 or more.`], ['-1', `${label} must be a number of 0 or more.`]] });
const optInt = (label: string): Row => ({ ok: '4', bad: [['1.5', `${label} must be a whole number.`], ['abc', `${label} must be a whole number.`]] });

const QTY_LINE = 'That is not a valid quantity: use a number of 0 or more, with at most three decimal places.';
const QTY_ORDER = 'The quantity cannot be negative: use a number of 0 or more, with at most three decimal places.';
const QTY_COUNT = 'A count cannot be negative: use a number of 0 or more, with at most three decimal places.';
const ITEM_SHAPE = 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.';
const LIFE = 'The remaining life has to be a whole number of months, from 1 to 600.';

const ROWS: Record<string, Row> = {
  // ---- inventory
  'inventory.openCountSession.countedOn': date('The count date'),
  'inventory.recordCount.itemId': req('Choose the item that was counted.'),
  'inventory.recordCount.locationId': req('Choose the room it was counted in.'),
  'inventory.recordCount.countedQuantity': { ok: '12.345', bad: [['abc', QTY_LINE], ['-1', QTY_LINE]], blank: QTY_LINE },
  'inventory.createDeliveryDocument.kind': req('Choose whether this is a supplier delivery or a cash purchase.'),
  'inventory.createDeliveryDocument.supplierId': opt(),
  'inventory.createDeliveryDocument.deliveredOn': date('The delivery date'),
  'inventory.createLocation.code': req('A room needs a code.'),
  'inventory.createLocation.name': req('A room needs a name.'),
  'inventory.createLocation.typeId': req('Choose a room type.'),
  'inventory.setThreshold.threshold': optNum0('Low-stock threshold'),
  'inventory.upsertPosItemMap.posItemKey': req('A map needs the POS item key.'),
  'inventory.upsertPosItemMap.posItemName': req('A map needs the POS item name.'),
  'inventory.voidPosUsagePull.reason': req('Say why this pull is being voided.'),
  'inventory.createProductionDraft.producedOn': date('The production date'),
  'inventory.voidProduction.reason': req('A void needs a reason.'),
  'inventory.refundSupplierCredit.amount': {
    ok: '10.5', stored: '10.50',
    bad: [MONEY_BAD('The refund amount'), ['0', 'The refund amount must be an amount of 0.01 or more.'], ['-5', 'The refund amount must be an amount of 0.01 or more.']],
    blank: MONEY_BLANK('The refund amount'),
  },
  'inventory.recordReturn.quantity': num0('The quantity'),
  'inventory.recordReturn.reason': req('A return needs a reason.'),
  'inventory.voidReturn.reason': req('A void needs a reason.'),
  'inventory.createTransfer.itemId': req('Choose the item to transfer.'),
  'inventory.createTransfer.quantity': num0('The quantity'),
  'inventory.voidTransfer.reason': req('A void needs a reason.'),
  'inventory.voidUsage.reason': req('Say why this usage record is being voided.'),
  // ---- items
  'items.requestItem.name': req('Give the item a name people will recognise.'),
  'items.requestItem.kind': req('Choose what kind of item this is.'),
  'items.requestItem.baseUnit': req('Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.'),
  'items.requestItem.code': { ok: 'CHWN-001', bad: [['CHWN-000', ITEM_SHAPE], ['CH-001', ITEM_SHAPE], ['CHWN001', ITEM_SHAPE], ['CHWN-0011', ITEM_SHAPE]] },
  'items.approveItemRequest.code': { ok: 'CHWN-001', bad: [['CHWN-000', ITEM_SHAPE], ['CH-001', ITEM_SHAPE]] },
  'items.approveItemRequest.baseUnit': opt(),
  'items.rejectItemRequest.note': req('Say why, so the requester knows what to do instead.'),
  'items.renameItem.name': req('Give the item a name people will recognise.'),
  'items.renameItem.code': req('Give the item a code.'),
  'items.changeItemUnit.baseUnit': req('Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.'),
  // ---- commissary
  'commissary.upsertCommissaryLink.branchStoreId': req('Choose the branch to link.'),
  'commissary.upsertOffering.itemId': req('Choose the item to offer.'),
  'commissary.upsertOffering.manualCost': optNum0('The manual cost'),
  'commissary.upsertMap.commissaryItemId': req('Choose the commissary item.'),
  'commissary.upsertMap.branchItemId': req('Choose the branch item it becomes.'),
  'commissary.deferDiscrepancy.deferredTo': date('The date to decide by'),
  'commissary.returnDiscrepancy.note': req('A return must say what happened — who carried the extra back and when, or that the branch recounted.'),
  'commissary.saveBranchOrderDraft.orderDate': date('The order date'),
  'commissary.orderLine.itemId': req('Choose the item.'),
  'commissary.orderLine.quantity': { ok: '2', bad: [['abc', QTY_ORDER], ['-1', QTY_ORDER]], blank: QTY_ORDER },
  'commissary.orderLine.rate': optNum0('The rate'),
  'commissary.orderLineEdit.quantity': { ok: '2', bad: [['abc', QTY_ORDER], ['-1', QTY_ORDER]], blank: QTY_ORDER },
  'commissary.orderLineEdit.rate': optNum0('The rate'),
  'commissary.voidTradeOrder.reason': req('Say why this order is being withdrawn.'),
  'commissary.rejectOrder.reason': req('Say why — the branch reads this.'),
  'commissary.receiveTradeOrder.receivedOn': optDate('The received date'),
  // ---- wastage
  'wastage.record.channel': req('Choose the channel the wastage happened on.'),
  'wastage.record.businessDate': date('The business date'),
  'wastage.record.amount': {
    ok: '99', stored: '99.00',
    bad: [MONEY_BAD('The wastage amount'), ['0', 'The wastage amount must be an amount of 0.01 or more.']],
    blank: MONEY_BLANK('The wastage amount'),
  },
  'wastage.record.reason': req('Say why this wastage happened.'),
  'wastage.reverseAutoCharge.reason': req('Say why this auto-charge is being reversed.'),
  // ---- cutover
  'cutover.addOpeningFigure.accountCode': req('Choose the account.'),
  'cutover.addOpeningFigure.storeId': req('Choose the store.'),
  // T-453 / DEF-727: only debit or credit passes; anything else is refused, never coerced.
  'cutover.addOpeningFigure.direction': {
    ok: 'debit',
    bad: [['abc', 'Choose whether the business has this or owes it.'], [BLANK, 'Choose whether the business has this or owes it.']],
    blank: 'Choose whether the business has this or owes it.',
  },
  'cutover.addOpeningFigure.amount': {
    ok: '500', stored: '500.00',
    bad: [MONEY_BAD('This amount'), ['0', 'This amount must be an amount of 0.01 or more.']],
    blank: MONEY_BLANK('This amount'),
  },
  'cutover.valueOpeningAsset.bookValue': {
    ok: '1200.5', stored: '1200.50',
    bad: [MONEY_BAD('The book value'), ['0', 'The book value must be an amount of 0.01 or more.']],
    blank: MONEY_BLANK('The book value'),
  },
  'cutover.valueOpeningAsset.remainingLifeMonths': { ok: '36', bad: [['0', LIFE], ['601', LIFE], ['1.5', LIFE], ['abc', LIFE]], blank: LIFE },
  'cutover.valueOpeningAsset.salvageValue': { ok: '0', stored: '0.00', bad: [MONEY_BAD('The salvage value'), ['-1', 'The salvage value must be an amount of 0 or more.']] },
  'cutover.recordOpeningCount.quantity': { ok: '0', bad: [['abc', QTY_COUNT], ['-1', 'A count cannot be negative.']], blank: QTY_COUNT },
  'cutover.recordOpeningCount.unitCost': {
    ok: '.5', bad: [['abc', 'The cost per unit must be a non-negative number with up to four decimal places.'],
      ['-1', 'The cost per unit must be a non-negative number with up to four decimal places.']],
  },
  // ---- menu
  'menu.category.name': req('A category needs a name.'),
  'menu.category.sortOrder': optInt('The sort order'),
  'menu.createItem.categoryId': req('Choose a category for the item.'),
  'menu.createItem.name': req('An item needs a name.'),
  'menu.item.name': req('An item needs a name.'),
  'menu.item.sortOrder': optInt('The sort order'),
  'menu.setDepletionRule.quantityPerSale': optNum0('The quantity per sale'),
  'menu.addVariant.label': req('A variant needs a name.'),
  'menu.optionValue.name': req('An option needs a name.'),
  'menu.optionGroup.name': req('An option group needs a name.'),
  'menu.optionGroup.minSelections': optInt('The minimum'),
  'menu.optionGroup.maxSelections': optInt('The maximum'),
  'menu.setPrice.amount': { ok: '120', stored: '120.00', bad: [MONEY_BAD('The price'), ['-1', 'The price must be an amount of 0 or more.']] },
  'menu.setPrice.markupPercent': { ok: '12.5', bad: [['abc', 'The percent over must be a number.']] },
  'menu.setPrice.fixedMarkupAmount': { ok: '-5', stored: '-5.00', bad: [MONEY_BAD('The pesos over')] },
  'menu.setPrice.bundleHeads': { ok: '3', bad: [['0', 'The number of guests in a bundle must be a whole number of 1 or more.'], ['1.5', 'The number of guests in a bundle must be a whole number of 1 or more.']] },
  'menu.setPrice.extraHeadAmount': { ok: '50', stored: '50.00', bad: [MONEY_BAD('The price for each extra guest'), ['-1', 'The price for each extra guest must be an amount of 0 or more.']] },
  'menu.setOptionPrice.priceDelta': { ok: '-10', stored: '-10.00', bad: [MONEY_BAD('The price change')] },
  'menu.requestMenuItem.name': req('The item needs a name.'),
  'menu.rejectMenuItemRequest.note': req('Say why the request is rejected, so the requester knows.'),
};

function setsOf(mod: Record<string, unknown>): FieldRuleSetLike[] {
  return Object.values(mod).filter(
    (v): v is FieldRuleSetLike => typeof v === 'object' && v !== null && typeof (v as { form?: unknown }).form === 'string',
  );
}
const FILES: Record<string, Record<string, unknown>> = { inventory, items, commissary, wastage, cutover, menu };
const ALL_SETS = Object.values(FILES).flatMap(setsOf);
const keyOf = (set: FieldRuleSetLike, r: FieldRule) => `${set.form}.${r.name}`;
const ALL_RULES = ALL_SETS.flatMap((set) => rulesOf(set).map((r) => ({ set, rule: r, key: keyOf(set, r) })));

function goodInput(set: FieldRuleSetLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = ROWS[keyOf(set, r)]?.ok ?? '';
  return out;
}
/** A short value ("0", "-1") can sit inside a sentence by accident; only a value of 3+ characters can be an echo. */
const echoes = (text: string, typed: string) => typed.trim().length >= 3 && text.includes(typed);
const ruleOf = (key: string): FieldRule => {
  const found = ALL_RULES.find((r) => r.key === key);
  if (!found) throw new Error(`no rule ${key}`);
  return found.rule;
};

describe('T-440 S5 stock and menu: the table covers exactly the rules that exist', () => {
  it('every file holds sets', () => {
    for (const [name, mod] of Object.entries(FILES)) expect(setsOf(mod).length, name).toBeGreaterThan(0);
  });
  it('every rule of every S5 set has a row (mutant: a rule added without a fixture)', () => {
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

describe('T-440 S5 stock and menu: client rule === server refusal, exact sentences, money-only input quoting', () => {
  for (const { set, rule: r, key } of ALL_RULES) {
    const row = ROWS[key];
    if (!row) continue;
    describe(key, () => {
      it('passes its good value (padded too) and stores the normalised form (mutant: value not trimmed / money not normalised)', () => {
        const want = row.stored === undefined ? row.ok : row.stored;
        expect(checkField(r, row.ok)).toEqual({ ok: true, value: want });
        expect(checkField(r, `  ${row.ok} `)).toEqual({ ok: true, value: want });
        expect(assertFieldRules(set, goodInput(set))[r.name]).toBe(want);
      });

      for (const [value, sentence] of row.bad) {
        it(`refuses ${JSON.stringify(value)} with the exact sentence, same on the server (mutant: re-worded / edited server sentence)`, () => {
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
          for (const text of (r.kind === 'money' ? [c.progress, err.message] : [c.requirement, c.progress, err.message, err.userMessage])) {
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
        it('a blank (and spaces) is refused with the blank sentence, same on the server (mutant: optional ignored the other way)', () => {
          const want = row.blank;
          expect(want, `${key} needs a blank sentence in the table`).toBeTruthy();
          for (const blank of ['', BLANK]) {
            const c = checkField(r, blank);
            expect(c.ok).toBe(false);
            if (c.ok) return;
            expect(c.requirement).toBe(want);
            expect(c.progress).toBe('Required');
            let thrown: unknown;
            try {
              assertFieldRules(set, { ...goodInput(set), [r.name]: blank });
            } catch (e) {
              thrown = e;
            }
            expect(thrown).toBeInstanceOf(RefusalError);
            expect((thrown as RefusalError).userMessage).toBe(c.requirement);
          }
        });
      }
    });
  }
});

describe('T-440 S5 stock and menu: boundaries and shape', () => {
  it('a quantity of 0 or more: 0 and 0.001 pass, -0.001 and -0 are refused (mutant: min off by one)', () => {
    for (const k of ['inventory.recordCount.countedQuantity', 'cutover.recordOpeningCount.quantity', 'commissary.orderLine.quantity', 'inventory.createTransfer.quantity', 'inventory.recordReturn.quantity']) {
      const r = ruleOf(k);
      expect(checkField(r, '0').ok, `${k} 0`).toBe(true);
      expect(checkField(r, '0.001').ok, `${k} 0.001`).toBe(true);
      expect(checkField(r, '-0.001').ok, `${k} -0.001`).toBe(false);
      expect(checkField(r, '-0').ok, `${k} -0`).toBe(false);
    }
  });
  it('a positive amount accepts 0.01 and refuses 0.00 (mutant: min 0 for 0.01)', () => {
    for (const k of ['inventory.refundSupplierCredit.amount', 'wastage.record.amount', 'cutover.addOpeningFigure.amount', 'cutover.valueOpeningAsset.bookValue']) {
      expect(checkField(ruleOf(k), '0.01').ok, k).toBe(true);
      expect(checkField(ruleOf(k), '0.00').ok, k).toBe(false);
    }
  });
  it('the remaining life accepts 1 and 600 and refuses 0 and 601 (mutant: boundary off by one / integer dropped)', () => {
    const r = ruleOf('cutover.valueOpeningAsset.remainingLifeMonths');
    expect(checkField(r, '1').ok).toBe(true);
    expect(checkField(r, '600').ok).toBe(true);
    expect(checkField(r, '0').ok).toBe(false);
    expect(checkField(r, '601').ok).toBe(false);
    expect(checkField(r, '12.5').ok).toBe(false);
  });
  it('bundle heads accept 1 and refuse 0 (mutant: min dropped)', () => {
    const r = ruleOf('menu.setPrice.bundleHeads');
    expect(checkField(r, '1').ok).toBe(true);
    expect(checkField(r, '0').ok).toBe(false);
  });
  it('the item code shape: 000, a short number and a long number fail (mutant: pattern loosened)', () => {
    for (const k of ['items.requestItem.code', 'items.approveItemRequest.code']) {
      const r = ruleOf(k);
      expect(checkField(r, 'CHWN-999').ok, k).toBe(true);
      expect(checkField(r, 'CHWN-000').ok, k).toBe(false);
      expect(checkField(r, 'CHWN-01').ok, k).toBe(false);
      expect(checkField(r, 'CHWN-0010').ok, k).toBe(false);
    }
  });
  it('the item-rename code is required while the request/approve code may be blank (mutant: optional swapped)', () => {
    expect(checkField(ruleOf('items.renameItem.code'), '').ok).toBe(false);
    expect(checkField(ruleOf('items.requestItem.code'), '')).toEqual({ ok: true, value: null });
    expect(checkField(ruleOf('items.approveItemRequest.code'), '')).toEqual({ ok: true, value: null });
  });
  it('the cutover count and the threshold accept a real zero (mutant: zero treated as blank)', () => {
    expect(checkField(ruleOf('cutover.recordOpeningCount.quantity'), '0')).toEqual({ ok: true, value: '0' });
    expect(checkField(ruleOf('inventory.setThreshold.threshold'), '0')).toEqual({ ok: true, value: '0' });
  });
  it('a date refuses 2026-02-30 (mutant: shape-only date check)', () => {
    expect(checkField(ruleOf('inventory.openCountSession.countedOn'), '2026-02-30').ok).toBe(false);
  });
});

describe('T440 existing manual cost shapes', () => {
  it('accepts leading/trailing-dot four-decimal costs and refuses negative, excess-precision and non-number values', () => {
    for (const value of ['.5', '1.', '005', '0.1234']) expect(checkField(cutover.CUTOVER_COUNT_RULES.unitCost, value).ok, value).toBe(true);
    for (const value of ['-1', '1.12345', '.', 'abc', '1e3']) expect(checkField(cutover.CUTOVER_COUNT_RULES.unitCost, value).ok, value).toBe(false);
  });
});
