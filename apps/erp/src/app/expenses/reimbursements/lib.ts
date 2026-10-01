/**
 * Server-only loaders for the staff reimbursement payout screen. T-369 S1 (DEF-198).
 *
 * ⛔ Nothing here decides who may PAY: `payReimbursement` calls `authorize()` itself. These loaders
 * only decide what the screen OFFERS — a store the actor cannot pay at is not listed, so the form
 * never invites a refusal the domain would then have to make.
 */
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { expensesRepo, moneyAccountsRepo, schema } from '@shareat/db';
import { and, eq } from 'drizzle-orm';
import { withOrgPrincipal, listStores } from '../lib';

export { withOrgPrincipal };
export { peso } from '../../../lib/format';

export interface PayableStore {
  id: string;
  name: string;
  code: string;
}

/**
 * The stores at which this actor holds `record_ap_payment` — the capability `payReimbursement`
 * checks. `heldCapabilities` is store-blind by design, so each store is asked on its own with the
 * real `authorize()` (the same throw-to-value idiom `channel-settlements/page.tsx` uses).
 */
export async function listPayableStores(actor: Actor): Promise<PayableStore[]> {
  const stores = await listStores(actor.orgId);
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const ok: PayableStore[] = [];
    for (const s of stores) {
      try {
        await authorize(tx, actor, 'record_ap_payment', { storeId: s.id });
        ok.push(s);
      } catch (err) {
        if (err instanceof AuthorizationError) continue;
        throw err;
      }
    }
    return ok;
  });
}

/** Who this store owes a reimbursement to, biggest first. */
export async function listOwedAtStore(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => expensesRepo.reimbursablePayablesAtStore(tx, orgId, storeId));
}

export interface PayFromAccount {
  id: string;
  name: string;
}

/**
 * The accounts a payout may be drawn from at this store: its own, active, and never a staff float.
 * The domain refuses the other two cases too — this is the list, not the control.
 */
export async function listPayFromAccounts(orgId: string, storeId: string): Promise<PayFromAccount[]> {
  const accounts = await withOrgPrincipal(orgId, (tx) =>
    moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId }),
  );
  return accounts.filter((a) => a.custodian !== 'staff').map((a) => ({ id: a.id, name: a.name }));
}

/** The person's display name, for the confirmation banner. Empty when no such person exists. */
export async function displayNameOf(orgId: string, personId: string): Promise<string> {
  const [row] = await withOrgPrincipal(orgId, (tx) =>
    tx
      .select({ name: schema.persons.displayName })
      .from(schema.persons)
      .where(and(eq(schema.persons.orgId, orgId), eq(schema.persons.id, personId)))
      .limit(1),
  );
  return row?.name ?? '';
}
