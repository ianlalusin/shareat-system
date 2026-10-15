import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-387 S4 (TESTER) - stamp wiring, one row of the `t387-q5-stamp-words` table per action. Spec: S4, L8, L9.
 *
 * SOURCE PINS, not flash-jar: every one of these actions needs an actor session and a database to reach its success
 * path (`requireActor` + `withOrgPrincipal`), so a unit test cannot drive it and an integration test per action is out
 * of proportion for "one line per action" (the spec's own words). Each pin reads the action's body and asserts that
 * the success-path `redirectWithFlash` carries `stamp: '<WORD>'` AND an `ok` message. The word-vs-vocabulary check is
 * proven for real, through the jar, in t387-s4-flash-keys.test.ts (an unknown word throws).
 *
 * Mutants: wrong word on any row; stamp without ok; APPROVED on the expense approve (L8); a stamp on a transfer (L9).
 */

const APP = resolve(__dirname, '../src/app');

/** The text of `export async function NAME ...` up to the next top-level export (or end of file). */
function body(file: string, fn: string): string {
  const src = readFileSync(resolve(APP, file), 'utf8');
  const start = src.search(new RegExp(`export async function ${fn}\\b`));
  if (start < 0) throw new Error(`${file}: no export async function ${fn}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport (async )?(function|const)\b/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** [file, function, WORD, q5 row] */
const WIRED: ReadonlyArray<readonly [string, string, string, string]> = [
  // VERIFIED: a sales day, an AP invoice, an attendance day
  ['sales-days/actions.ts', 'verifySalesDayAction', 'VERIFIED', 'verify a sales day'],
  ['ap/actions.ts', 'verifyInvoiceAction', 'VERIFIED', 'verify an AP invoice'],
  ['attendance/[dayId]/actions.ts', 'verifyDayAction', 'VERIFIED', 'verify an attendance day'],
  // POSTED: approve an expense (it posts), post payroll, post usage or production
  ['expenses/actions.ts', 'approveExpenseAction', 'POSTED', 'approve an expense (it posts)'],
  ['payroll/actions.ts', 'postPayRunAction', 'POSTED', 'post payroll'],
  ['inventory/usage/actions.ts', 'postUsageAction', 'POSTED', 'post usage'],
  ['inventory/production/actions.ts', 'postProductionAction', 'POSTED', 'post production'],
  // APPROVED / RELEASED: a cash request
  ['cash-requests/actions.ts', 'decideAction', 'APPROVED', 'approve a cash request'],
  ['cash-requests/actions.ts', 'releaseAction', 'RELEASED', 'release a cash request'],
  // RECEIVED: an order or a delivery
  ['commissary/orders/[id]/actions.ts', 'receiveOrderAction', 'RECEIVED', 'receive a commissary order'],
  ['trade/orders/actions.ts', 'receiveOrderAction', 'RECEIVED', 'receive a trade order'],
  ['inventory/deliveries/actions.ts', 'receiveDeliveryAction', 'RECEIVED', 'receive a delivery'],
  // REVERSED: a remittance, a loan entry, a prepaid month
  ['remittance/actions.ts', 'reverseRemittanceAction', 'REVERSED', 'reverse a remittance'],
  ['loans/actions.ts', 'reverseEntryAction', 'REVERSED', 'reverse a loan entry'],
  ['prepaid/actions.ts', 'reverseMonthAction', 'REVERSED', 'reverse a prepaid month'],
  // VOID: any void (every void action that goes through redirectWithFlash today or is converted; NOT inventory transfers, L9)
  ['expenses/actions.ts', 'voidExpenseAction', 'VOID', 'void an expense'],
  ['sales-days/actions.ts', 'voidSalesDayAction', 'VOID', 'void a sales day'],
  ['ap/actions.ts', 'voidInvoiceAction', 'VOID', 'void an AP invoice'],
  ['ap/actions.ts', 'voidPaymentAction', 'VOID', 'void an AP payment'],
  ['attendance/[dayId]/actions.ts', 'voidDayAction', 'VOID', 'void an attendance day'],
  ['payroll/actions.ts', 'voidPayRunAction', 'VOID', 'void a pay run'],
  ['payroll/separations/actions.ts', 'voidSeparationAction', 'VOID', 'void a separation'],
  ['inventory/usage/actions.ts', 'voidUsageAction', 'VOID', 'void usage'],
  ['inventory/production/actions.ts', 'voidProductionAction', 'VOID', 'void production'],
  ['inventory/pos-usage/actions.ts', 'voidPullAction', 'VOID', 'void a POS pull'],
  ['inventory/returns/actions.ts', 'voidReturnAction', 'VOID', 'void a return'],
  ['trade/orders/actions.ts', 'voidOrderAction', 'VOID', 'void a trade order'],
  ['trade/returns/actions.ts', 'voidReturnAction', 'VOID', 'void a trade return'],
  ['channel-settlements/actions.ts', 'voidSettlementAction', 'VOID', 'void a channel settlement'],
  ['customers/actions.ts', 'voidCollectionAction', 'VOID', 'void a collection'],
  ['customers/actions.ts', 'voidChargeAction', 'VOID', 'void a charge'],
  ['money-transfers/actions.ts', 'voidMoneyTransferAction', 'VOID', 'void a money transfer (a ledger movement, not an inventory transfer)'],
  ['statutory-discounts/actions.ts', 'voidStatutoryDiscountAction', 'VOID', 'void a statutory discount'],
];

describe('S4 every wired action sends its q5 stamp word and an ok message', () => {
  it.each(WIRED)('%s %s -> %s (%s)', (file, fn, word) => {
    const b = body(file, fn);
    expect(b, `${fn} must carry stamp: '${word}'`).toMatch(new RegExp(`stamp:\\s*'${word}'`));
    // The one-word stamp is not the message: the ok toast says what happened, in a sentence.
    expect(b, `${fn} must carry an ok message beside the stamp`).toMatch(/\bok:/);
    // It goes through the flash helper, not a hand-rolled redirect.
    expect(b).toMatch(/redirectWithFlash\(/);
  });

  it('no wired action carries a second, different q5 word on its success path', () => {
    const q5 = ['VERIFIED', 'POSTED', 'APPROVED', 'RELEASED', 'RECEIVED', 'VOID', 'REVERSED'];
    for (const [file, fn, word] of WIRED) {
      const b = body(file, fn);
      for (const other of q5.filter((w) => w !== word)) {
        // decideAction may name APPROVED only; a reject has no q5 word (the table has none), so none other may appear
        expect(b, `${fn} must not stamp ${other}`).not.toMatch(new RegExp(`stamp:\\s*'${other}'`));
      }
    }
  });
});

describe('S4 L8: status words differ by entity', () => {
  it('approving an expense POSTS it: the stamp is POSTED and never APPROVED', () => {
    const b = body('expenses/actions.ts', 'approveExpenseAction');
    expect(b).toMatch(/stamp:\s*'POSTED'/);
    expect(b).not.toMatch(/APPROVED/);
  });

  it('a cash request is APPROVED then RELEASED: two different words, two actions', () => {
    expect(body('cash-requests/actions.ts', 'decideAction')).toMatch(/stamp:\s*'APPROVED'/);
    expect(body('cash-requests/actions.ts', 'releaseAction')).toMatch(/stamp:\s*'RELEASED'/);
    expect(body('cash-requests/actions.ts', 'releaseAction')).not.toMatch(/stamp:\s*'APPROVED'/);
  });

  it('refusing a cash request stamps nothing: the q5 table has no word for it', () => {
    const b = body('cash-requests/actions.ts', 'decideAction');
    expect(b).not.toMatch(/REJECTED|REFUSED|DECLINED/);
    // S4 audit (mutant 6 survived): the reject branch's flash object must carry no stamp at all,
    // not merely no other word. The success redirect picks its flash on `decision === 'reject'`.
    const rejectFlash = b.match(/decision === 'reject'\s*\?\s*(\{[^}]*\})/)?.[1];
    expect(rejectFlash, 'the reject branch flash object').toBeDefined();
    expect(rejectFlash).toMatch(/\bok:/);
    expect(rejectFlash).not.toMatch(/stamp/);
  });

  it('a stamp is only ever on the success path: the error redirect carries none', () => {
    for (const [file, fn] of WIRED) {
      const b = body(file, fn);
      const errorRedirects = b.match(/redirectWithFlash\([^;]*\{\s*error:[^;]*\);/g) ?? [];
      for (const r of errorRedirects) expect(r, `${fn}: an error redirect must not stamp`).not.toMatch(/stamp:/);
    }
  });
});

describe('S4 L9: transfers are NOT wired', () => {
  it('inventory/transfers/actions.ts carries no stamp at all (they throw; the detail page does not exist yet)', () => {
    const src = readFileSync(resolve(APP, 'inventory/transfers/actions.ts'), 'utf8');
    expect(src).not.toMatch(/stamp:/);
    // T-412: voidTransferAction (only) now redirects with a plain error/ok banner - a wrong administrator PIN has to be SHOWN, and a
    // thrown server-action error reaches the person as a digest. Still no stamp. dispatch/receive keep throwing.
    expect(body('inventory/transfers/actions.ts', 'dispatchTransferAction')).not.toMatch(/redirectWithFlash/);
    expect(body('inventory/transfers/actions.ts', 'receiveTransferAction')).not.toMatch(/redirectWithFlash/);
    for (const fn of ['dispatchTransferAction', 'receiveTransferAction', 'voidTransferAction']) {
      expect(body('inventory/transfers/actions.ts', fn)).not.toMatch(/stamp/);
    }
  });
});

describe('S4 the action files wired are a finite list (guard against stamp creeping onto dispatch/post-message and the like)', () => {
  it('no stamp word appears in an action that the q5 table does not name', () => {
    const NOT_IN_TABLE: ReadonlyArray<readonly [string, string]> = [
      ['commissary/orders/[id]/actions.ts', 'dispatchOrderAction'],
      ['commissary/orders/[id]/actions.ts', 'postMessageAction'],
      ['trade/orders/actions.ts', 'dispatchOrderAction'],
      ['cash-requests/actions.ts', 'createRequestAction'],
      ['cash-requests/actions.ts', 'cancelAction'],
      ['expenses/actions.ts', 'createExpenseAction'],
      ['sales-days/actions.ts', 'createSalesDayAction'],
    ];
    for (const [file, fn] of NOT_IN_TABLE) expect(body(file, fn), `${fn} is not a q5 row`).not.toMatch(/stamp:/);
  });
});
