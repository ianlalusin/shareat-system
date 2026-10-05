/**
 * Money accounts — the places money sits. ADR-010, bible rows 142–148.
 *
 * A thin service over `moneyAccountsRepo`: the repo owns the SQL, this owns the gate and the
 * rules that are about intent rather than shape.
 *
 * ## ⛔ Only an ADMIN may add an account to the books
 *
 * > **Ian, 2026-08-26:** *"only admin can add accounts to the books — that must be the rule."*
 *
 * So the gate is `manage_chart_of_accounts` (org-scoped, admin and super-admin only), not
 * `manage_store_settings`.
 *
 * ⚠️ **I had this wrong first, and the reasoning is worth keeping.** I gated it as manager-level
 * store configuration, on the grounds that a branch manager adding the store's GCash account is
 * ordinary admin. It is not: a money account **is an account in the books**. Every peso that
 * enters it lands on the balance sheet under a GL code this service assigns, and creating one
 * creates a place money can be attributed to. That is the same act as adding a chart-of-accounts
 * row, and it belongs at the same level.
 *
 * ⭐ **A wallet is per-store but the capability is per-ORG, and that is correct rather than
 * sloppy.** The store says where the money sits; the authority to open a new place for money to
 * sit is the org's. An admin already holds org-wide scope, so nothing is widened by it.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  moneyAccountsRepo,
  storesRepo,
  transaction,
  type Custodian,
  type MoneyInstrument,
  type Tx,
} from '@shareat/db';
import { compare, isZero, money, ZERO } from '@shareat/core/money';
import { parseDecimalInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

export interface CreateMoneyAccountInput {
  storeId: string;
  name: string;
  instrument: MoneyInstrument;
  custodian: Custodian;
  notes?: string | null;
}

/**
 * The GL account a money location rolls into, derived from what KIND of place it is.
 *
 * ⭐ **Derived, never chosen.** Letting a user pick the GL code would put the chart of accounts in
 * a settings form, where a typo becomes a wallet that reports as cash — and DEF-058's lesson is
 * exactly this: *"the owner belongs to the ACCOUNT — it should be derived, never ticked."* Same
 * reasoning one level along.
 *
 * ⚠️ Cash is the interesting case. A `cash` location's GL code depends on WHO holds it, because
 * v2's chart splits cash by custodian (1110/1120/1130) while every wallet and bank account shares
 * one control account (1140). That asymmetry is ADR-010 §2's test showing through: three cash
 * locations are each reconciled separately, so each earned its own account.
 */
export function glCodeFor(instrument: MoneyInstrument, custodian: Custodian): string {
  if (instrument !== 'cash') return '1140';
  switch (custodian) {
    case 'cashier':
      return '1110';
    case 'staff':
      return '1120';
    case 'office':
      return '1130';
  }
}

export async function createMoneyAccount(
  tx: Tx | null,
  actor: Actor,
  input: CreateMoneyAccountInput,
): Promise<{ id: string }> {
  if (tx) return runCreate(tx, actor, input);
  return transaction((trx) => runCreate(trx, actor, input));
}

async function runCreate(
  tx: Tx,
  actor: Actor,
  input: CreateMoneyAccountInput,
): Promise<{ id: string }> {
  await authorize(tx, actor, 'manage_chart_of_accounts', {});

  const name = input.name.trim();
  if (!name) {
    throw new Error('createMoneyAccount: a money account needs a name people will recognise.');
  }

  // ⚠️ Two cash locations with the same custodian at one store would be two rows rolling into the
  // SAME GL account with nothing to tell their lines apart — 1110 carries no party, because the
  // code IS the location. Refused here with the reason, rather than silently creating a place
  // whose balance can never be attributed.
  if (input.instrument === 'cash') {
    const existing = await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, {
      storeId: input.storeId,
      custodian: input.custodian,
      instrument: 'cash',
    });
    if (existing.length > 0) {
      throw new Error(
        `createMoneyAccount: this store already has a ${input.custodian} cash location ` +
          `("${existing[0]!.name}"). Cash is identified by its account code, so a second one ` +
          `could never be told apart from the first in the ledger.`,
      );
    }
  }

  return moneyAccountsRepo.insertMoneyAccount(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    name,
    instrument: input.instrument,
    glAccountCode: glCodeFor(input.instrument, input.custodian),
    custodian: input.custodian,
    notes: input.notes?.trim() || null,
  });
}

/** ⛔ Retire, never delete — its journal lines and sales-day tenders outlive it. */
export async function retireMoneyAccount(
  tx: Tx | null,
  actor: Actor,
  input: { moneyAccountId: string },
): Promise<void> {
  if (tx) return runRetire(tx, actor, input);
  return transaction((trx) => runRetire(trx, actor, input));
}

async function runRetire(
  tx: Tx,
  actor: Actor,
  input: { moneyAccountId: string },
): Promise<void> {
  const account = await moneyAccountsRepo.getById(tx, actor.orgId, input.moneyAccountId);
  if (!account) {
    throw new Error(
      `retireMoneyAccount: money account ${input.moneyAccountId} does not exist in org ${actor.orgId}`,
    );
  }
  // Retiring is the same authority as creating: it changes what accounts the books have.
  await authorize(tx, actor, 'manage_chart_of_accounts', {});

  // ⛔ ONE OF THE FIVE CANNOT BE RETIRED WHILE THE STORE IS TRADING (bible row 156).
  //
  // > **Ian, 2026-08-26:** *"these 5 accounts must always be present and available since they are
  // > the foundation of money movement."*
  //
  // ⚠️ Checked BEFORE the balance guard below, because it is the stronger statement: an empty
  // cashier till is still the store's till, and "it happens to hold ₱0 today" is not permission to
  // remove the place the day's takings go. Since T-139 a cash payment must NAME an account, so a
  // store without its till cannot record a cash expense at all.
  //
  // ⭐ "While the store is active" is Ian's own qualifier, and it is what makes this a rule rather
  // than a wall: close the store and its accounts can be closed with it.
  if (account.isFoundation) {
    const storeOpen = await moneyAccountsRepo.storeIsActive(tx, account.storeId);
    if (storeOpen) {
      throw new Error(
        `retireMoneyAccount: "${account.name}" is one of the five accounts every trading store ` +
          'must have, so it cannot be retired. Rename it if it is called something else here — ' +
          'that is what the name is for.',
      );
    }
  }

  // ⛔ AN ACCOUNT HOLDING MONEY CANNOT BE RETIRED (Ian, 2026-08-26).
  //
  // Retiring hides it from every picker, so the money inside becomes unreachable: nothing can
  // transfer out of a place nobody can select. The balance would keep counting toward the trial
  // balance and toward the custodian position — real pesos, in a location the system has stopped
  // offering. **A wallet is emptied first and retired second, never the other way round.**
  //
  // ⚠️ Checked against the LEDGER, not a stored figure, so the guard cannot be fooled by a stale
  // column — there is no column. It is the same number the register shows.
  const balance = await moneyAccountsRepo.balanceOf(tx, actor.orgId, account);
  if (!isZero(money(balance))) {
    throw new Error(
      `retireMoneyAccount: "${account.name}" still holds ${balance}. Transfer the balance out ` +
        `first — retiring it would hide the account from every picker and strand the money in a ` +
        `place nothing can select.`,
    );
  }

  await moneyAccountsRepo.retireMoneyAccount(tx, actor.orgId, input.moneyAccountId);
}

export { judgeDraw, checkDraw, type DrawVerdict } from './overdraft';

/**
 * Renames a money account. ⭐ **The name is the configurable part of a foundation account.**
 *
 * > **Ian, 2026-08-26:** *"cashier cash may be renamed to counter till, office cash may be office
 * > vault … unretirable but configurable in ui esp name."*
 *
 * ⚠️ Admin-only, like creating one. The gate is `manage_chart_of_accounts` because a money
 * account's NAME is what every picker, every report and every reviewer reads — renaming "Office
 * vault" to "Petty cash" changes what people believe a balance means without changing a peso.
 * ⛔ Custodian and instrument are deliberately NOT editable here: they decide the GL code, so
 * changing them would move money between accounts by editing a label.
 */
export async function renameMoneyAccount(
  tx: Tx | null,
  actor: Actor,
  input: {
    moneyAccountId: string;
    name: string;
    notes?: string | null;
    /**
     * ⭐ How far below zero a CASHIER drawer may go. Admin-set, per account.
     *
     * > **Ian, 2026-08-27:** *"it can't be unlimited, so admin can set it."*
     *
     * ⚠️ Accepted on ANY account for one shape, but only a cashier one ever consults it — office
     * and staff balances are complete and block at zero regardless (bible row 154).
     */
    overdraftLimit?: string | null;
  },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_chart_of_accounts', {});
    const name = input.name.trim();
    if (!name) {
      throw new Error('renameMoneyAccount: a money account needs a name people will recognise.');
    }
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) {
      throw new Error(`renameMoneyAccount: money account ${input.moneyAccountId} does not exist.`);
    }
    // ⛔ Stored positive, and zero is meaningful — it means this drawer may never go below zero at
    // all. A negative value would invert the comparison silently, so it is refused here as well as
    // by the CHECK.
    //
    // ⭐ T-371 R6 — the column is NOT NULL DEFAULT '20000.00', so a BLANK (or absent) limit is
    // OMITTED: the stored limit is left unchanged. It is never a guessed zero, which would be the
    // strictest setting there is.
    const limit = parseDecimalInput(
      input.overdraftLimit?.trim(),
      '14,2',
      'renameMoneyAccount: the overdraft limit',
      'The overdraft limit',
      { blank: 'omit' },
    );
    if (limit !== undefined && compare(limit, ZERO) < 0) {
      throw refuse(
        'renameMoneyAccount: an overdraft limit is how far BELOW zero the drawer may go, so it is ' +
          'entered as a positive number. Zero means it may never go below zero at all.',
        'An overdraft limit is how far below zero the drawer may go, so enter it as a positive number. ' +
          'Zero means it may never go below zero at all.',
      );
    }

    await moneyAccountsRepo.renameMoneyAccount(trx, actor.orgId, account.id, {
      name,
      notes: input.notes?.trim() || null,
      ...(limit !== undefined ? { overdraftLimit: limit } : {}),
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// T-153 / T-316 — the till float (a target on the cashier drawer, not a separate pot)
// -------------------------------------------------------------------------------------

/**
 * Set, resize or clear a store's till float. Bible row 129's sibling.
 *
 * > **Ian, 2026-08-29:** *"extra cash float that is not remitted to the manager or admin — it sits
 * > on till forever… if the configured budget is 20k, every day opening and closing it is 20k."*
 *
 * ⭐ **T-316 (A4): the float is a TARGET on the cashier's own cash drawer, not a side pocket.** This
 * sets `float_target` on the store's existing active `Cashier cash` account (cash, cashier, `1110`)
 * and NEVER inserts. A store with none, or with more than one, is refused in a sentence.
 *
 * ⭐ **`set_cash_policy`, the same admin-only capability as the un-remitted ceiling.** Whoever is
 * measured must not be able to move the bar.
 *
 * ⛔ **Setting a target does NOT put money in the drawer.** The money arrives by a transfer from the
 * office (or, at cutover, as an opening balance). Clearing (null) on an account with no target is a
 * no-op returning its id.
 */
export async function setTillFloat(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; target: string | null },
): Promise<{ moneyAccountId: string }> {
  await authorize(tx, actor, 'set_cash_policy', { storeId: input.storeId });

  // ⭐ T-371 R5/R6 — parsed AFTER authorize(). `float_target` is nullable, so a blank is null
  // (clear the target), never a guessed zero.
  const target = parseDecimalInput(
    input.target,
    '14,2',
    'setTillFloat: the float target',
    'The till float target',
    { blank: 'null' },
  );

  const drawers = (
    await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, {
      storeId: input.storeId,
      custodian: 'cashier',
      instrument: 'cash',
    })
  ).filter((a) => a.glAccountCode === '1110');

  if (drawers.length !== 1) {
    const store = await storesRepo.getById(tx, actor.orgId, input.storeId);
    const storeName = store?.name ?? 'This store';
    throw refuse(
      `setTillFloat: store ${input.storeId} has ${drawers.length} active cashier cash (1110) accounts`,
      drawers.length === 0
        ? `${storeName} has no cashier cash account to hold a float.`
        : `${storeName} has more than one cashier cash account; the float needs exactly one.`,
    );
  }

  const drawer = drawers[0]!;
  // ⚠️ Clearing a target retires the float STATUS, not the account or its money; nothing is posted.
  if (target === null && drawer.floatTarget === null) return { moneyAccountId: drawer.id };
  await moneyAccountsRepo.setFloatTarget(tx, actor.orgId, drawer.id, target);
  return { moneyAccountId: drawer.id };
}
