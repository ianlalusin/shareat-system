/**
 * Server-only data helpers for the channel-settlement screens. DEF-137, spec `docs/tasks/150-*.md`.
 *
 * ⭐ **Every figure here is a query, not a column.** What a channel is owed is `1220` grouped by
 * party; whether a day is still waiting is the absence of a posted settlement row. There is no
 * "outstanding" column anywhere in this feature, which is why the screen cannot drift from the
 * books it describes — the same discipline that found v1's 13.3% drift in a maintained
 * `outstandingAmount`.
 *
 * ⛔ **No SQL lives in this file.** It composes repo calls; the queries are in
 * `packages/db/src/repo/channel-settlements.ts`. Three app `lib.ts` files were caught holding
 * drizzle SQL during the DEF-135 review — that is the rule this file is keeping.
 */
import { channelSettlementsRepo, loansRepo, moneyAccountsRepo } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
/** Re-exported for `actions.ts`, which needs the RLS principal and nothing else from here. */
export { withOrgPrincipal } from '../expenses/lib';

export interface LoanOption {
  id: string;
  label: string;
  /** The store that OWNS the debt. Different from the paying store = the cross-store case. */
  storeId: string;
  outstanding: string;
}

export interface DestinationOption {
  id: string;
  storeId: string;
  name: string;
  custodian: string;
  glAccountCode: string;
}

export async function listChannels(orgId: string) {
  return withOrgPrincipal(orgId, (tx) => channelSettlementsRepo.listSettlementChannels(tx, orgId));
}

export async function listWaitingDays(orgId: string) {
  return withOrgPrincipal(orgId, (tx) =>
    channelSettlementsRepo.listSettleableChannelDays(tx, orgId, { limit: 100 }),
  );
}

export async function listRecentSettlements(orgId: string) {
  return withOrgPrincipal(orgId, (tx) =>
    channelSettlementsRepo.listSettlements(tx, orgId, { limit: 50 }),
  );
}

/**
 * Active loans, with what each still owes.
 *
 * ⚠️ Every store's loans, not just the paying one — the cross-store dock is a real case (T-150 §6:
 * a Grab loan owned by Lipa, deducted from Malvar's payout), and a picker scoped to the paying
 * store could not express it. The domain decides what that costs: `1250`/`2150` when the owner
 * differs, plain `2400` when it does not.
 */
export async function listActiveLoans(orgId: string): Promise<LoanOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const loans = await loansRepo.listLoans(tx, orgId, { status: 'active' });
    const positions = await loansRepo.positionsByLoan(tx, orgId);
    return loans.map((l) => ({
      id: l.id,
      label: `${l.name} — ${l.lenderName}`,
      storeId: l.storeId,
      outstanding: positions.get(l.id)?.outstanding ?? '0.00',
    }));
  });
}

/**
 * The accounts a channel's payout may be pointed at.
 *
 * ⚠️ Active only. A retired wallet is refused by `setChannelPayoutDestination`, so offering one
 * would be an error the form invites and the domain then rejects.
 */
export async function listDestinationAccounts(orgId: string): Promise<DestinationOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, {});
    return rows.map((a) => ({
      id: a.id,
      storeId: a.storeId,
      name: a.name,
      custodian: a.custodian,
      glAccountCode: a.glAccountCode,
    }));
  });
}
