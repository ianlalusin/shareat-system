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
  transaction,
  type Custodian,
  type MoneyInstrument,
  type Tx,
} from '@shareat/db';

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
  if (Number(balance) !== 0) {
    throw new Error(
      `retireMoneyAccount: "${account.name}" still holds ${balance}. Transfer the balance out ` +
        `first — retiring it would hide the account from every picker and strand the money in a ` +
        `place nothing can select.`,
    );
  }

  await moneyAccountsRepo.retireMoneyAccount(tx, actor.orgId, input.moneyAccountId);
}

export { judgeDraw, checkDraw, type DrawVerdict } from './overdraft';
