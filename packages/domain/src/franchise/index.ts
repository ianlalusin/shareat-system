/**
 * T-398 S6 - the franchisor's view of a franchisee (Padre Garcia): its sales per day, its stock on hand, and the access log the franchisee reads.
 * docs/tasks/398-s6/S6-REFRESH.md sections 3-5; migration 0220.
 *
 * ## Two doors, and the database holds both
 *
 * 1. `authorize()` first, in every function here: the franchisor's reads need `view_franchise_sales` (super_admin by role, or Ian's person-level grant); the franchisee's log
 *    read needs `view_franchise_access_log` (admin and manager by role; ROLE ONLY, no grant confers it).
 * 2. The database then re-checks who is asking, in words (42501), and writes the access-log row itself, in the same statement as the read. This module never writes a log
 *    row and has no way to read the franchisee's tables: the SECURITY DEFINER functions are the only path (repo/franchise.ts).
 *
 * ## Run these inside `withActorPrincipal(orgId, personId, ...)`
 *
 * The three franchisor reads need `app.person_id` in the transaction (the database checks it). A call without it is refused by the database in words, never silently empty.
 * One call is ONE log row: a screen must call these from a button press (a server action), never from a render, and never twice for one press.
 *
 * Money and quantities are decimal strings (`Money`, `Quantity`), minted by `money()` / `decimal()`; there is no float anywhere in this file.
 */
import { authorize, type Actor } from '@shareat/auth';
import { franchiseRepo, type Tx } from '@shareat/db';
import { decimal, money, type Money, type Quantity } from '@shareat/core/money';
import { refuse } from '../shared/refusal';

/** A franchisee the actor's organisation holds an agreement with (the picker). */
export interface Franchisee {
  readonly franchiseeOrgId: string;
  readonly franchiseeName: string;
  /** YYYY-MM-DD: the earliest date the franchisor may ask for. */
  readonly salesVisibleFrom: string;
}

/** One sales row. `day` rows carry the day's money; `channel` rows carry the channel name and amount only (the other money fields are null). */
export interface FranchiseSalesLine {
  readonly rowKind: 'day' | 'channel';
  readonly storeId: string;
  readonly storeName: string;
  readonly businessDate: string;
  /** open / submitted / verified. Totals on a screen count verified days only (QI-1 (a)); the status is shown on every day. */
  readonly dayStatus: string;
  readonly grossSales: Money | null;
  readonly discounts: Money | null;
  readonly comps: Money | null;
  readonly refunds: Money | null;
  readonly netSales: Money | null;
  /** How it was paid, by kind (QI-2 (a)): never a money-account name. */
  readonly cashCollected: Money | null;
  readonly onlineCollected: Money | null;
  readonly creditSales: Money | null;
  readonly channelName: string | null;
  readonly channelAmount: Money | null;
}

export interface FranchiseStockLine {
  readonly storeId: string;
  readonly storeName: string;
  readonly itemName: string;
  readonly baseUnit: string;
  readonly onHand: Quantity;
  readonly threshold: Quantity | null;
  /** At or below the franchisee's own low-stock line. */
  readonly belowThreshold: boolean;
  readonly asOf: Date;
}

/**
 * The actor must BE the person the transaction's principal was opened with (audit A3): `authorize()` judges `actor`, the database judges `app.person_id`, and the two must not
 * diverge. A principal that carries NO person is left to the database (it refuses 42501 in words); one that carries a DIFFERENT person is refused here.
 */
async function assertActorIsPrincipal(tx: Tx, actor: Actor): Promise<void> {
  const carried = await franchiseRepo.principalPersonId(tx);
  if (carried !== null && carried !== actor.personId) {
    throw refuse('franchise: actor differs from the principal person', 'You are not signed in as the person this request was opened for. Sign in again.');
  }
}

const optMoney = (v: string | null): Money | null => (v === null ? null : money(v));

/** The franchisees this organisation may look at. Needs `view_franchise_sales`; not logged (no business figure). */
export async function listFranchisees(tx: Tx, actor: Actor): Promise<Franchisee[]> {
  await assertActorIsPrincipal(tx, actor);
  await authorize(tx, actor, 'view_franchise_sales');
  return franchiseRepo.listFranchisees(tx);
}

export interface ViewFranchiseSalesInput {
  readonly franchiseeOrgId: string;
  /** YYYY-MM-DD. */
  readonly from: string;
  /** YYYY-MM-DD. */
  readonly to: string;
  readonly reason?: string | null;
}

/** The franchisee's sales per day over a range. One call writes one access-log row. Refused (in words, nothing logged) before the agreement's visible-from date or over 366 days. */
export async function viewFranchiseSales(tx: Tx, actor: Actor, input: ViewFranchiseSalesInput): Promise<FranchiseSalesLine[]> {
  await assertActorIsPrincipal(tx, actor);
  await authorize(tx, actor, 'view_franchise_sales');
  const rows = await franchiseRepo.salesDaily(tx, input);
  return rows.map((r) => ({
    rowKind: r.rowKind,
    storeId: r.storeId,
    storeName: r.storeName,
    businessDate: r.businessDate,
    dayStatus: r.dayStatus,
    grossSales: optMoney(r.grossSales),
    discounts: optMoney(r.discounts),
    comps: optMoney(r.comps),
    refunds: optMoney(r.refunds),
    netSales: optMoney(r.netSales),
    cashCollected: optMoney(r.cashCollected),
    onlineCollected: optMoney(r.onlineCollected),
    creditSales: optMoney(r.creditSales),
    channelName: r.channelName,
    channelAmount: optMoney(r.channelAmount),
  }));
}

export interface ViewFranchiseStockInput {
  readonly franchiseeOrgId: string;
  /** One franchisee store; omitted = every store. */
  readonly storeId?: string | null;
  readonly reason?: string | null;
}

/** The franchisee's stock on hand today. One call writes one access-log row. No cost, value, supplier or movement is ever returned. */
export async function viewFranchiseStock(tx: Tx, actor: Actor, input: ViewFranchiseStockInput): Promise<FranchiseStockLine[]> {
  await assertActorIsPrincipal(tx, actor);
  await authorize(tx, actor, 'view_franchise_sales');
  const rows = await franchiseRepo.stockLevels(tx, input);
  return rows.map((r) => ({
    storeId: r.storeId,
    storeName: r.storeName,
    itemName: r.itemName,
    baseUnit: r.baseUnit,
    onHand: decimal(r.onHand, '14,3'),
    threshold: r.threshold === null ? null : decimal(r.threshold, '14,3'),
    belowThreshold: r.belowThreshold,
    asOf: r.asOf,
  }));
}

export interface ListFranchiseAccessLogInput {
  readonly from?: Date;
  readonly to?: Date;
  readonly what?: franchiseRepo.AccessLogRow['what'];
  readonly limit?: number;
}

/** The actor's OWN organisation's access log (who looked, who signed in, who approved), newest first. Needs `view_franchise_access_log`. */
export async function listFranchiseAccessLog(tx: Tx, actor: Actor, input: ListFranchiseAccessLogInput = {}): Promise<franchiseRepo.AccessLogRow[]> {
  await assertActorIsPrincipal(tx, actor);
  await authorize(tx, actor, 'view_franchise_access_log');
  return franchiseRepo.listAccessLog(tx, actor.orgId, input);
}
