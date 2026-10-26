/**
 * The inter-entity reconciliation - T-398 S5e. The commissary (the SELLER) and a franchise (the BUYER) are two companies with two sets of
 * books; this compares them, never changes them.
 *
 * ## What it compares (docs/tasks/398-s5/S5-REFRESH.md section 5, QUESTIONS.md "S5e tester gaps")
 *
 * - Per RECEIVED shipment: what the seller billed less what it credited, against what the buyer's own books posted for the receipt. An
 *   in-transit or void shipment is not listed: the buyer has not recorded it yet, so there is nothing to compare.
 * - Per linked pair of organisations: the seller's receivable (1210 net of 2140 store credit) against the buyer's payable (2110 net of 1240), each
 *   side reading the OTHER side's figure through a definer that returns ONE number (no lines, no accounts, no people). Billing on shipments still
 *   in transit is taken out of the seller's figure first.
 * - Exact centavos. There is no tolerance: a one-centavo disagreement is a finding.
 * - One finding per cause: the pair's gap reported here is the RESIDUAL left after the shipment gaps explain what they can.
 *
 * Every gap is a signed Money string, "what THIS side says minus what the other side recorded".
 *
 * Runs under the caller's own organisation principal and only reads. The 06:30 job (scheduler/index.ts) writes the commissary's own
 * `franchise_credit` discrepancy rows from the result; a human posts the credit note (franchise-credit.ts).
 */
import { interEntityRepo, tradeDiscrepanciesRepo, type Tx } from '@shareat/db';
import { add, compare, money, multiplyToMoney, subtract, ZERO, type Money } from '@shareat/core/money';
import { quantity, subtractQuantity, toThousandths } from '../stock/quantity';

export interface ShipmentGap {
  readonly shipmentId: string;
  /** `seller`: the caller billed it. `buyer`: the caller received it. */
  readonly role: 'seller' | 'buyer';
  readonly counterpartyOrgId: string;
  readonly counterpartyName: string | null;
  /** YYYY-MM-DD the goods were shipped (what a sentence calls "the shipment of ..."). */
  readonly shippedOn: string;
  /** The caller's own store for the shipment. */
  readonly storeId: string;
  /** Billed less credited. */
  readonly billedNet: Money;
  /** What the buyer's books posted for the receipt. */
  readonly buyerPosted: Money;
  /** Seller: billedNet - buyerPosted. Buyer: buyerPosted - billedNet. */
  readonly gap: Money;
}

export interface PairGap {
  readonly counterpartyOrgId: string;
  readonly counterpartyName: string | null;
  readonly role: 'seller' | 'buyer';
  /** The caller's own balance with the other organisation (receivable for a seller, payable for a buyer), in-transit billing excluded. */
  readonly mine: Money;
  /** The other organisation's figure for the same debt, as its one-number definer reports it, in-transit billing excluded. */
  readonly theirs: Money;
  /** The RESIDUAL: (mine - theirs) less the gaps of this pair's shipments. Zero when the shipment gaps explain everything. */
  readonly gap: Money;
}

export interface ReconcileResult {
  readonly shipments: ShipmentGap[];
  readonly pairs: PairGap[];
}

const figureOf = (rows: readonly { counterpartyOrgId: string; amount: string }[]): Map<string, Money> =>
  new Map(rows.map((r) => [r.counterpartyOrgId, money(r.amount)]));

/** Seller side: every received shipment against what the buyer posted, then every linked buyer's balance. */
async function sellerSide(tx: Tx, orgId: string): Promise<{ shipments: ShipmentGap[]; pairs: PairGap[] }> {
  const rows = await interEntityRepo.sellerReceivedShipments(tx, orgId);
  const posted = new Map((await interEntityRepo.buyerPosted(tx, rows.map((r) => r.shipmentId))).map((p) => [p.shipmentId, money(p.postedTotal)]));
  const shipments: ShipmentGap[] = rows.map((r) => {
    const billedNet = subtract(money(r.billedTotal), money(r.creditedTotal));
    const buyerPosted = posted.get(r.shipmentId) ?? ZERO;
    return {
      shipmentId: r.shipmentId, role: 'seller', counterpartyOrgId: r.counterpartyOrgId, counterpartyName: r.counterpartyName,
      shippedOn: r.shippedOn, storeId: r.storeId, billedNet, buyerPosted, gap: subtract(billedNet, buyerPosted),
    };
  });

  const own = await interEntityRepo.ownReceivableByBuyer(tx, orgId);
  const inTransit = figureOf(await interEntityRepo.inTransitBilledByCounterparty(tx, orgId, 'seller'));
  const theirs = new Map((await interEntityRepo.counterpartyBalance(tx)).map((b) => [b.counterpartyOrgId, money(b.counterpartyOwes)]));
  const pairs: PairGap[] = own.map((o) => {
    const mine = subtract(money(o.amount), inTransit.get(o.counterpartyOrgId) ?? ZERO);
    const other = theirs.get(o.counterpartyOrgId) ?? ZERO;
    const explained = add(...shipments.filter((s) => s.counterpartyOrgId === o.counterpartyOrgId).map((s) => s.gap));
    return {
      counterpartyOrgId: o.counterpartyOrgId, counterpartyName: o.counterpartyName ?? null, role: 'seller', mine, theirs: other,
      gap: subtract(subtract(mine, other), explained),
    };
  });
  return { shipments, pairs };
}

/** Buyer side: every received shipment against what the seller billed less credited, then every linked seller's balance. */
async function buyerSide(tx: Tx, orgId: string): Promise<{ shipments: ShipmentGap[]; pairs: PairGap[] }> {
  const rows = await interEntityRepo.buyerReceivedShipments(tx, orgId);
  const shipments: ShipmentGap[] = rows.map((r) => {
    const billedNet = subtract(money(r.billedTotal), money(r.creditedTotal));
    const buyerPosted = money(r.ownPostedTotal ?? '0');
    return {
      shipmentId: r.shipmentId, role: 'buyer', counterpartyOrgId: r.counterpartyOrgId, counterpartyName: r.counterpartyName,
      shippedOn: r.shippedOn, storeId: r.storeId, billedNet, buyerPosted, gap: subtract(buyerPosted, billedNet),
    };
  });

  const own = await interEntityRepo.ownPayableBySeller(tx, orgId);
  const inTransit = figureOf(await interEntityRepo.inTransitBilledByCounterparty(tx, orgId, 'buyer'));
  const theirs = new Map((await interEntityRepo.counterpartyReceivable(tx)).map((b) => [b.counterpartyOrgId, money(b.counterpartyIsOwed)]));
  const pairs: PairGap[] = own.map((o) => {
    const mine = money(o.amount);
    const other = subtract(theirs.get(o.counterpartyOrgId) ?? ZERO, inTransit.get(o.counterpartyOrgId) ?? ZERO);
    const explained = add(...shipments.filter((s) => s.counterpartyOrgId === o.counterpartyOrgId).map((s) => s.gap));
    return {
      counterpartyOrgId: o.counterpartyOrgId, counterpartyName: o.counterpartyName ?? null, role: 'buyer', mine, theirs: other,
      gap: subtract(subtract(mine, other), explained),
    };
  });
  return { shipments, pairs };
}

/**
 * The caller organisation's reconciliation, as seller and as buyer (an organisation is normally only one of the two). `orgId` must be the org the
 * transaction's principal is acting for: the definers read `app_current_org()`, so a different id would compare nothing.
 */
export async function reconcileInterEntity(tx: Tx, orgId: string): Promise<ReconcileResult> {
  const seller = await sellerSide(tx, orgId);
  const buyer = await buyerSide(tx, orgId);
  return { shipments: [...seller.shipments, ...buyer.shipments], pairs: [...seller.pairs, ...buyer.pairs] };
}

/** True when the figure is not exactly zero. */
export const hasGap = (gap: Money): boolean => compare(gap, ZERO) !== 0;

/** 2480.00 -> "₱2,480.00" (sign dropped: the sentence says which way). Pure string work; no floats. */
export function pesoText(value: Money): string {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [whole = '0', frac = '00'] = unsigned.split('.');
  let grouped = '';
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ',';
    grouped += whole[i];
  }
  return `₱${grouped}.${frac.padEnd(2, '0')}`;
}

const absOf = (v: Money): Money => (v.startsWith('-') ? money(v.slice(1)) : v);

/**
 * The sentence a shipment gap shows in the caller's feed, in its OWN words. Never a uuid, never an account, never a cost, never a person of the other
 * company (QI-1 (a), R2): only the other company's name, the ship date and the amounts both sides already share.
 */
export function shipmentGapDetail(g: ShipmentGap): string {
  const other = g.counterpartyName ?? (g.role === 'seller' ? 'The franchise' : 'The commissary');
  if (g.role === 'seller') {
    return compare(g.gap, ZERO) > 0
      ? `${other} has recorded ${pesoText(g.buyerPosted)} against the shipment of ${g.shippedOn}, but ${pesoText(g.billedNet)} is billed on it: ${pesoText(absOf(g.gap))} short. Post the credit note for the shortage.`
      : `${other} has recorded ${pesoText(g.buyerPosted)} against the shipment of ${g.shippedOn}, which is ${pesoText(absOf(g.gap))} more than the ${pesoText(g.billedNet)} billed on it.`;
  }
  return `${other} billed ${pesoText(g.billedNet)} for the shipment of ${g.shippedOn}; you recorded ${pesoText(g.buyerPosted)}. The difference is ${pesoText(absOf(g.gap))}.`;
}

/** The sentence a pair's residual balance gap shows, in the caller's own words. */
export function balanceGapDetail(p: PairGap): string {
  const other = p.counterpartyName ?? (p.role === 'seller' ? 'The franchise' : 'The commissary');
  const tail = `The ${pesoText(absOf(p.gap))} difference is not explained by any one shipment: look for a payment or a return that only one of you has entered.`;
  return p.role === 'seller'
    ? `Your books say ${other} owes you ${pesoText(p.mine)}; ${other} has recorded ${pesoText(p.theirs)}. ${tail}`
    : `Your books say you owe ${other} ${pesoText(p.mine)}; ${other} has recorded ${pesoText(p.theirs)} owed by you. ${tail}`;
}

/**
 * The 06:30 job's one write: for every received shipment of THIS organisation (as the seller) the franchise paid less than was billed for, ONE open
 * `franchise_credit` discrepancy per short shipment line, in this organisation's own books. The commissary manager's to-do, ending in a credit note.
 *
 * Idempotent (a second run writes none: the unique index on the order line), never touches the franchise's books, posts nothing and moves no stock.
 * `value` is the credit it will become: the line's bill less what the franchise booked for it, round(received x rate, 2).
 * Returns the number of rows written.
 */
export async function raiseShortageDiscrepancies(tx: Tx, orgId: string, result: ReconcileResult): Promise<number> {
  let written = 0;
  for (const gap of result.shipments) {
    if (gap.role !== 'seller' || compare(gap.gap, ZERO) <= 0) continue;
    const shipment = await interEntityRepo.findById(tx, gap.shipmentId);
    if (!shipment || shipment.orgId !== orgId) continue;
    for (const line of await interEntityRepo.linesOf(tx, gap.shipmentId)) {
      if (line.receivedQuantity === null) continue;
      const shipped = quantity(line.quantity);
      const received = quantity(line.receivedQuantity);
      const short = subtractQuantity(shipped, received);
      if (toThousandths(short) <= 0n) continue;
      const value = subtract(money(line.lineTotal), multiplyToMoney(received, money(line.rate)));
      // A short quantity so small it rounds to nothing has no credit to give (and a zero-value row is not allowed).
      if (compare(value, ZERO) <= 0) continue;
      const raised = await tradeDiscrepanciesRepo.createFranchiseCredit(tx, {
        orgId,
        storeId: shipment.storeId,
        orderId: shipment.tradeOrderId,
        orderLineId: line.tradeOrderLineId,
        shipmentLineId: line.id,
        quantity: short,
        value,
        note: `${line.itemName}: the franchise counted ${received} of ${shipped} ${line.unit} at the door.`,
      });
      if (raised) written += 1;
    }
  }
  return written;
}
