/**
 * distributeServiceCharge — the discharge path DEF-082 needs. T-187 slice 1.
 * docs/tasks/187-service-charge-distribution.md §7 (contract) and §2 (the five rulings).
 *
 * ```
 * Dr 2160 (that store)   <amount>   store_id = storeId
 * Cr <moneyAccount>      <amount>   store_id = storeId
 * ```
 *
 * ⛔ **The cap is that store's OWN 2160 balance, derived from the ledger, never a stored
 * column** (§7 invariant 1) — a store may not spend another store's float. Exceeding it REFUSES,
 * it does not clamp (§2 Q5), and the refusal happens strictly BEFORE any write
 * (createRemittance's discipline, DEF-358/T-319).
 *
 * ⛔ **No per-employee, eligibility or rounding logic in any form** (§2 Q1–Q3). ERP records only
 * that the float was discharged and by how much; the split is processed and documented by hand.
 */
import { advisoryLocksRepo, moneyAccountsRepo, serviceChargeRepo, storesRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { compare, money, subtract, ZERO } from '@shareat/core/money';
import { postEntry } from '../ledger/post-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { parseMoneyInput } from '../shared/money-input';
// ⭐ Shared spelling of these codes, not a fourth copy — same constant `expenses/routing.ts`
// already uses for the identical decision.
import { EXPENSE_FUNDING_ACCOUNTS } from '../expenses/routing';

interface DistributeServiceChargeInput {
  /** The ONE store being paid out. There is no org-wide form (§7). */
  storeId: string;
  /** The account the cash leaves. Must belong to `storeId`. */
  moneyAccountId: string;
  /** The aggregate handed to staff. */
  amount: string;
  /** The payday date carried onto the entry. */
  paidOn: string;
}

export async function distributeServiceCharge(
  tx: Tx | null,
  actor: Actor,
  input: DistributeServiceChargeInput,
): Promise<{ entryId: string; created: boolean; warning?: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_expense', { storeId: input.storeId });
    // ⛔ T-366 S1 / DEF-374 — serialise per store before the float cap is read.
    await advisoryLocksRepo.lockServiceChargeFloat(trx, input.storeId);

    // ⛔ DEF-272's own guard — `Number(x) > 0` accepts "10.005", and posting that raw string to a
    // numeric(14,2) column lets Postgres round it AFTER the cap and checkDraw already compared
    // against the un-rounded figure. `parsedAmount` is what every check below runs against AND
    // what actually gets posted, so the value validated and the value written are the same value.
    const parsedAmount = parseMoneyInput(input.amount, 'distributeServiceCharge: the amount', 'The amount to distribute');
    // ⛔ T-371 C4 — ordered in scaled bigint on the brand, never as a float.
    if (compare(parsedAmount, ZERO) <= 0) {
      throw new Error('distributeServiceCharge: a distribution has to be greater than zero.');
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw new Error('distributeServiceCharge: that money account does not exist.');
    // ⛔ §7 invariant 4 — mirrors payLiability's exact check against its liability's store.
    if (account.storeId !== input.storeId) {
      throw new Error('distributeServiceCharge: that money account belongs to another store.');
    }
    // ⛔ `1120 Cash on hand — staff custodian` requires a party too, but its party is a SPECIFIC
    // cash_request — whose float this is (expenses/routing.ts:165-195, T-266 §7.1). A service
    // charge distribution has no cash request to attach: it is not one person's held float being
    // spent down, it is a fresh statutory payout. Refusing by name here, like routing.ts already
    // does for the identical account, is the correct fix — carrying a party would mean inventing
    // one, which corrupts `floatPositionOf` for whatever cash request it borrowed.
    if (account.glAccountCode === EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF) {
      throw new Error(
        'distributeServiceCharge: that account is a staff cash float, which belongs to a ' +
          'specific person via a cash request — a service charge distribution has no cash ' +
          'request to attach, so it cannot post from here. Choose an office or e-wallet account.',
      );
    }

    const store = await storesRepo.getById(trx, actor.orgId, input.storeId);
    if (!store) throw new Error(`distributeServiceCharge: store ${input.storeId} does not exist.`);

    // ⛔⛔ §7 invariants 1–3 — THE CAP, derived from the ledger, checked and thrown on strictly
    // BEFORE `postEntry` below. Nothing above this point writes anything, so every throw in this
    // function is a refusal before any write.
    // ⛔ T-371 R4/C4 — the ledger's sum re-minted as Money and compared exactly; the old
    // `+ 0.005` float tolerance is unnecessary once both sides are two-place decimals.
    const balance = money(await serviceChargeRepo.floatBalance(trx, actor.orgId, input.storeId));
    if (compare(parsedAmount, balance) > 0) {
      throw new Error(
        `distributeServiceCharge: ${store.name}'s service charge float only holds ` +
          `₱${balance} — ₱${subtract(parsedAmount, balance)} more than that was ` +
          'requested. Pay only what is available; it is never negative.',
      );
    }

    // ⛔ A different ceiling from the cap above: that one asks "does the store owe this to
    // staff" (2160); this one asks "is the cash actually there" (the money account itself). Both
    // must pass — mirrors every other outflow in this codebase (payLiability, ap, expenses,
    // money-transfers, ...), all nine now, through the one shared answer in `money-accounts/overdraft.ts`.
    const warning = await checkDraw(trx, actor.orgId, account, parsedAmount, 'distributeServiceCharge');

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.paidOn,
      sourceType: 'service_charge_distribution',
      sourceId: `${input.storeId}:${input.paidOn}`,
      // ⛔ AMENDMENT 2 — derived from the store and the payday, NEVER a timestamp or a random
      // value, so a double-submitted payday posts once, not twice.
      idempotencyKey: `service-charge:${input.storeId}:${input.paidOn}`,
      memo: `Service charge distribution — ${input.paidOn}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: serviceChargeRepo.SERVICE_CHARGE_FLOAT_CODE,
          storeId: input.storeId,
          debit: parsedAmount,
        },
        {
          accountCode: account.glAccountCode,
          storeId: input.storeId,
          credit: parsedAmount,
          // ⛔ Mirrors payLiability:199-201 exactly. `1140 E-wallet / online channels` is seeded
          // `requiresParty: true` (chart-of-accounts.ts:139) — a credit line naming it with no
          // party is refused at the database (migration 0007), and every OTHER money account in
          // this codebase that lands on 1140 carries this same conditional.
          ...(account.glAccountCode === EXPENSE_FUNDING_ACCOUNTS.ONLINE
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
      ],
    });
    // ⛔ **Propagated, never swallowed** (bible row 204, `verifySalesDay`'s same idiom). Amendment
    // 2's key correctly makes a replay a no-op on the LEDGER — but a caller that ignores `created`
    // reports "Distributed" for a call that posted nothing, which is DEF-082's own failure mode
    // wearing a different hat: the float reads discharged while the ledger says otherwise.
    return { entryId: result.entryId, created: result.created, ...(warning ? { warning } : {}) };
  };
  if (tx) return run(tx);
  return transaction(run);
}
