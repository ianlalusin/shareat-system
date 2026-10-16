/**
 * Server-side loader for `<MoneyLines>` — T-266 §3, `docs/tasks/266-money-lines.md`.
 *
 * ⚠️ **This exists because balances are DERIVED, never stored.** There is no `balance` column on
 * `money_accounts` and there must never be one — `packages/db/src/repo/money-accounts.ts:10-14`
 * carries the measured reason (v1's AP control says ₱669,829.84 while its own subledger sums to
 * ₱1,567,980.87). So the numbers the picker shows need a transaction, which means they are
 * assembled here and handed to the client component as a **prepared payload**, exactly as
 * `money-transfers/RecordTransferForm.tsx:6-9` already documents for the same boundary.
 *
 * ⛔ Nothing in here decides a RULE. Which methods are offered, how sources are grouped and what
 * makes a document coherent all live in `@shareat/domain`'s `money-lines` module, so the form and
 * the server action cannot disagree. This only fetches.
 */
import { asc, and, eq, inArray } from 'drizzle-orm';
import { authorize, type Actor, can } from '@shareat/auth';
import {
  cashRequestsRepo,
  moneyAccountsRepo,
  schema,
  type Tx,
} from '@shareat/db';
import {
  accountAsSource,
  floatAsSource,
  type MoneyAccountOption,
  type FloatOption,
  type SourceOption,
} from '@shareat/domain';
import { compare, money, ZERO } from '@shareat/core/money';
import { withOrgPrincipal } from '../../app/expenses/lib';

export interface MoneyLinesData {
  /** Accounts and open floats, already flattened into one list (§7.3). */
  sources: SourceOption[];
  /** Who money can be handed to, for a `reimbursable` line. */
  staff: { id: string; displayName: string }[];
  /**
   * T-369 S6b (DEF-291): accounts at OTHER stores where the actor holds `transfer_funds` (a draw on another
   * branch's money is cross-store movement, `approve.ts`). Accounts only - never another branch's staff floats.
   * `[]` when no actor is named: nobody is named, so nothing at another branch is offered.
   */
  otherStoreSources: SourceOption[];
  /** Store id -> name for the stores in `otherStoreSources`, so the picker can say which branch an account is at. */
  storeNames: Record<string, string>;
}

/**
 * ⭐ Open floats, presented as if each were an account.
 *
 * > *"online gcash bpi bdo are separate accounts but they are all online, so ana, ben and joy are
 * > staff accounts and they are all staff float"* — Ian, 2026-09-11
 *
 * Labelled by **person**, valued by **outstanding**, identified by the **request**. ⚠️ That split
 * is unambiguous only because `releaseCashRequest` refuses a second float while one is open for
 * the same person (DEF-159, `cash-requests/index.ts:199-209`). ⛔ **If that gate is ever relaxed,
 * two rows here can carry the same name and the picker silently shows duplicates** — the label
 * would stop identifying the thing it selects.
 */
async function openFloatsFor(tx: Tx, orgId: string, storeId: string): Promise<FloatOption[]> {
  const [floats, positions, staffAccounts] = await Promise.all([
    cashRequestsRepo.openFloats(tx, orgId),
    cashRequestsRepo.floatsByRequest(tx, orgId),
    moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId, custodian: 'staff', instrument: 'cash' }),
  ]);

  // The store's single staff-float account, when it has one. ⚠️ `createMoneyAccount` refuses a second cash location per
  // custodian per store, so there is at most one. ⭐ T-414: a float is offered whether or not there is one - releasing a
  // request now creates it (R-AUTO), and a request released before that is still spendable (routing credits 1120 with the
  // request as party), so its `moneyAccountId` is then `null`.
  const floatAccount = staffAccounts[0];

  const forStore = floats.filter((f) => f.storeId === storeId);
  if (forStore.length === 0) return [];

  const holders = await tx
    .select({ id: schema.persons.id, displayName: schema.persons.displayName })
    .from(schema.persons)
    .where(inArray(schema.persons.id, [...new Set(forStore.map((f) => f.requestedFor))]));
  const nameOf = new Map(holders.map((h) => [h.id, h.displayName] as const));

  return forStore
    .map((f) => ({
      cashRequestId: f.id,
      holderName: nameOf.get(f.requestedFor) ?? 'Unknown holder',
      outstanding: positions.get(f.id)?.outstanding ?? '0.00',
      moneyAccountId: floatAccount?.id ?? null,
      storeId: f.storeId,
    }))
    // ⚠️ v1's rule, kept (`picker-options.ts:22`) — a drained float is not a source of money. Read
    // from the ledger here rather than from a stored `remainingAmount` column v2 does not have.
    .filter((f) => compare(money(f.outstanding), ZERO) > 0)
    .sort((a, b) => a.holderName.localeCompare(b.holderName));
}

/**
 * Everything `<MoneyLines>` needs for one store, in one transaction.
 *
 * ⭐ **Scoped to the store** — DEF-291. The picker used to pass `{}` and offer every account at
 * every store to everyone. That is not a control hole (a cross-store draw is gated at
 * `approve.ts:111-121`, and `approve_expense` is manager-and-above), but it offered a staff member
 * at Lipa the Malvar safe with no hint and let them find out only when approval was refused.
 */
export async function loadMoneyLines(orgId: string, storeId: string, actor?: Actor): Promise<MoneyLinesData> {
  if (!storeId) return { sources: [], staff: [], otherStoreSources: [], storeNames: {} };

  return withOrgPrincipal(orgId, async (tx) => {
    const [accounts, balances, floats, staff] = await Promise.all([
      moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId }),
      moneyAccountsRepo.balancesFor(tx, orgId, storeId),
      openFloatsFor(tx, orgId, storeId),
      tx
        .select({ id: schema.persons.id, displayName: schema.persons.displayName })
        .from(schema.persons)
        .where(and(eq(schema.persons.orgId, orgId), eq(schema.persons.isActive, true)))
        .orderBy(asc(schema.persons.displayName)),
    ]);

    const asSources = (rows: typeof accounts, bal: ReadonlyMap<string, string>) => rows
      // ⛔ The aggregate staff-float row is NOT offered (§7.3). Its balance is every open float at
      // the store summed together — Ana's ₱1,240 plus Ben's ₱380 — which belongs to nobody and is
      // not spendable by anyone. The individual floats above are the real choices; this row only
      // resolves the GL code behind them.
      .filter((a) => a.custodian !== 'staff')
      .map((a): MoneyAccountOption => ({
        id: a.id,
        name: a.name,
        storeId: a.storeId,
        custodian: a.custodian,
        instrument: a.instrument,
        glAccountCode: a.glAccountCode,
        balance: bal.get(a.id) ?? '0.00',
        overdraftLimit: a.overdraftLimit,
        floatTarget: a.floatTarget,
      }))
      .map(accountAsSource);
    const accountSources = asSources(accounts, balances);

    // T-369 S6b: every OTHER store where this actor may move money, judged by the per-store authorize loop.
    const otherStoreSources: SourceOption[] = [];
    const storeNames: Record<string, string> = {};
    if (actor) {
      const stores = await tx.select({ id: schema.stores.id, name: schema.stores.name }).from(schema.stores).where(eq(schema.stores.orgId, orgId));
      for (const st of stores) {
        if (st.id === storeId) continue;
        if (!(await can(tx, actor, 'transfer_funds', { storeId: st.id }))) continue;
        const [theirs, theirBalances] = await Promise.all([
          moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId: st.id }),
          moneyAccountsRepo.balancesFor(tx, orgId, st.id),
        ]);
        const rows = asSources(theirs, theirBalances);
        if (rows.length > 0) storeNames[st.id] = st.name;
        otherStoreSources.push(...rows);
      }
    }

    return {
      sources: [...accountSources, ...floats.map(floatAsSource)],
      staff,
      otherStoreSources,
      storeNames,
    };
  });
}
