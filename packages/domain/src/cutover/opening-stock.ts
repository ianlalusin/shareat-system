/**
 * Opening stock: the count becomes FIFO `opening` layers per room and ONE inventory entry per store. T-390 S2, DEF-623.
 * `docs/tasks/390-opening-stock-and-subledger-tieout.md` section 4 R5, R5a, R7, R8, R13, R14, R17 and section 5.2.
 *
 * - `planOpeningStock` is PURE and is the ONE implementation of R5's arithmetic (R17): `valueOpeningStock` draws the entry from it,
 *   the tie-out (T1) compares the ledger with it, and `writeOpeningStock` re-checks the draft against it at C5.
 * - `valueOpeningStock` writes the generated draft (Dr 1310/1320/1330, Cr 3900). Pressing it again deletes and rewrites it.
 * - `writeOpeningStock` is called only from `postOpeningBalances`, inside ITS transaction: movements and layers commit with the post
 *   or not at all (I7).
 *
 * ROUNDING: one per item per store, half-up, in exact scaled integers (never a float). Three rooms of one unit at 0.0050 are
 * round2(0.015) = 0.02, not 3 x 0.01.
 */
import { cutoverRepo, journalRepo, stockLayersRepo, stockLedgerRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { decimal, fromCentavos, money } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { quantity as toQuantity, toThousandths } from '../stock/quantity';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../stock/receipt-posting';
import { closedStockPeriodSentence } from '../stock/period-guard';
import { CONVERSION_DATE } from './conversion-date';

const EQUITY = '3900';
const SOURCE_TYPE = 'opening_balance';
/** The conversion date (POSTING-PATTERNS `opening_balance.load`), derived from the leaf module: one edit moves every copy (T-394 R7, DEF-642). */
const CONVERSION = CONVERSION_DATE;
const CONVERSION_INSTANT = new Date(`${CONVERSION}T00:00:00Z`);

/** The idempotency key of a store's generated inventory draft. */
export const openingStockKey = (orgId: string, storeId: string): string => `opening-stock:${orgId}:${storeId}`;

export interface OpeningStockCount {
  storeId: string;
  locationId: string;
  itemId: string;
  /** numeric(14,3) as text. */
  quantity: string;
  /** numeric(14,4) as text, or null when the row has no cost. */
  unitCost: string | null;
  itemName?: string;
  locationName?: string;
}

/** What `planOpeningStock` needs to know about an item. The map's values may carry either field. */
export interface OpeningItemInfo {
  kind: string;
  name?: string;
}

export interface OpeningStockStorePlan {
  storeId: string;
  /** Only the non-zero inventory accounts, by code. */
  accounts: { code: string; amount: string }[];
  /** Sum of the accounts, in pesos. */
  total: string;
  /** Counted items (quantity above zero) that have no cost: nobody can value them. */
  unpriced: { itemId: string; name: string }[];
}

const SCALE_COST = 10_000n; // numeric(14,4)

/** The cost as an exact count of ten-thousandths. */
function costUnits(unitCost: string): bigint {
  return BigInt(decimal(unitCost, '14,4').replace('.', ''));
}

/**
 * R5, pure. For each store: Σ over items of round2(Σ over rooms of quantity x unit cost), grouped by the item kind's inventory account.
 * An item kind with no inventory account is refused BY ITEM NAME. Rows with a quantity of zero add nothing and are never
 * kind-checked. A counted row with no cost adds nothing and is reported in `unpriced`.
 */
export function planOpeningStock(
  counts: readonly OpeningStockCount[],
  itemKinds: ReadonlyMap<string, unknown>,
): OpeningStockStorePlan[] {
  const infoOf = (itemId: string): OpeningItemInfo | undefined => {
    const v = itemKinds.get(itemId) as { kind?: unknown; name?: unknown } | string | undefined;
    if (v === undefined || v === null) return undefined;
    const kind = typeof v === 'string' ? v : (v as { kind?: unknown }).kind;
    if (typeof kind !== 'string') return undefined;
    const name = typeof v === 'object' && typeof v.name === 'string' ? v.name : undefined;
    return name === undefined ? { kind } : { kind, name };
  };

  // store -> item -> { exact sum in 1e-7 pesos, account, name }
  const byStore = new Map<string, Map<string, { units: bigint; account: string; name: string }>>();
  const unpricedByStore = new Map<string, Map<string, string>>();
  for (const row of counts) {
    const q = toThousandths(toQuantity(row.quantity));
    if (q === 0n) continue;
    const info = infoOf(row.itemId);
    const name = info?.name ?? row.itemName ?? row.itemId;
    const account = info ? INVENTORY_ACCOUNT_BY_ITEM_KIND[info.kind] : undefined;
    if (!account) {
      throw refuse(
        `planOpeningStock: item "${name}" has kind "${info?.kind ?? 'unknown'}", which has no inventory account.`,
        `${name} is a kind of item (${info?.kind ?? 'unknown'}) that has no inventory account, so its count cannot be valued. Fix the item first.`,
      );
    }
    const items = byStore.get(row.storeId) ?? new Map();
    byStore.set(row.storeId, items);
    const entry = items.get(row.itemId) ?? { units: 0n, account, name };
    items.set(row.itemId, entry);
    if (row.unitCost === null || costUnits(row.unitCost) === 0n) {
      // A cost of 0 is not a price: it would open the item at nothing. Unpriced, exactly like a missing cost.
      const u = unpricedByStore.get(row.storeId) ?? new Map<string, string>();
      u.set(row.itemId, name);
      unpricedByStore.set(row.storeId, u);
      continue;
    }
    entry.units += q * costUnits(row.unitCost); // thousandths x ten-thousandths = 1e-7 pesos
  }

  const plans: OpeningStockStorePlan[] = [];
  const storeIds = new Set<string>([...byStore.keys(), ...unpricedByStore.keys()]);
  for (const storeId of [...storeIds].sort()) {
    const perAccount = new Map<string, bigint>();
    for (const e of (byStore.get(storeId) ?? new Map()).values()) {
      const centavos = (e.units + 50_000n) / 100_000n; // half-up, once per item per store (units are never negative)
      perAccount.set(e.account, (perAccount.get(e.account) ?? 0n) + centavos);
    }
    const accounts = [...perAccount.entries()]
      .filter(([, c]) => c !== 0n)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, c]) => ({ code, amount: fromCentavos(c) as string }));
    let total = 0n;
    for (const [, c] of perAccount) total += c;
    const unpriced = [...(unpricedByStore.get(storeId) ?? new Map<string, string>()).entries()]
      .map(([itemId, name]) => ({ itemId, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    plans.push({ storeId, accounts, total: fromCentavos(total) as string, unpriced });
  }
  return plans;
}

/** The kind and name of every item that appears in `counts`, in the shape `planOpeningStock` takes. */
export function itemKindsOf(rows: readonly { itemId: string; itemKind: string; itemName: string }[]): Map<string, OpeningItemInfo> {
  return new Map(rows.map((r) => [r.itemId, { kind: r.itemKind, name: r.itemName }]));
}

/**
 * R17: the one place a store's counted value is read. The count screen's total uses this too (the float total it replaces is gone).
 */
export async function countedStockValue(tx: Tx, orgId: string, storeId: string): Promise<string> {
  const rows = await cutoverRepo.countsForStore(tx, orgId, storeId);
  const plan = planOpeningStock(rows, itemKindsOf(rows)).find((p) => p.storeId === storeId);
  return plan ? plan.total : '0.00';
}

/**
 * R8 + R13 for every opening WRITER. Takes the SHARED opening lock FIRST (so a writer cannot commit between C5's checks and its
 * post), then refuses unless the purge has run (`requirePurge`) or once the books are open.
 */
export async function assertOpeningWritable(tx: Tx, orgId: string, opts: { requirePurge: boolean }): Promise<void> {
  await cutoverRepo.lockOpeningShared(tx, orgId);
  await assertPurgedAndNotOpened(tx, orgId, opts.requirePurge);
}

/** The same checks, for `postOpeningBalances`, which holds the EXCLUSIVE lock instead of the shared one. */
export async function assertPurgedAndNotOpened(tx: Tx, orgId: string, requirePurge: boolean): Promise<void> {
  if (requirePurge && !(await cutoverRepo.c2Performed(tx, orgId))) {
    throw refuse(
      'opening: The purge (C2) has not run. It deletes every journal entry, so a figure entered now would be lost.',
      'The purge (C2) has not run. It deletes every journal entry, so a figure entered now would be lost.',
    );
  }
  const opened = await cutoverRepo.openingPosted(tx, orgId);
  if (opened.posted) {
    throw refuse(
      `opening: The books were opened on ${opened.entryDate}. A correction is now a reversal or an ordinary stock document.`,
      `The books were opened on ${opened.entryDate}. A correction is now a reversal or an ordinary stock document.`,
    );
  }
}

/** R3: one item has ONE cost in a store. Compared in ten-thousandths, so costs 0.0001 apart are two costs. */
function assertOneCostPerItem(
  rows: readonly { itemId: string; itemName: string; locationName: string; unitCost: string | null }[],
  storeName: string,
): void {
  const firstCost = new Map<string, { cost: string; room: string }>();
  for (const r of rows) {
    if (r.unitCost === null) continue;
    const seen = firstCost.get(r.itemId);
    if (!seen) {
      firstCost.set(r.itemId, { cost: r.unitCost, room: r.locationName });
    } else if (costUnits(seen.cost) !== costUnits(r.unitCost)) {
      throw refuse(
        `opening stock: ${r.itemName} has two costs in ${storeName}.`,
        `${r.itemName} has two different costs at ${storeName}: ${seen.cost} in ${seen.room} and ${r.unitCost} in ${r.locationName}. One item has one cost per store: type it once to set it everywhere.`,
      );
    }
  }
}

export interface ValueOpeningStockResult {
  entryId: string;
  byAccount: { code: string; amount: string }[];
}

/**
 * R5. Writes (or rewrites) the store's one generated inventory draft: Dr 1310/1320/1330 (non-zero only) / Cr 3900, dated the
 * conversion date, idempotency key `opening-stock:{org}:{store}`. No counts with value: removes any old draft and returns `null`.
 */
export async function valueOpeningStock(
  tx: Tx | null,
  actor: Actor,
  input: { storeId: string },
): Promise<ValueOpeningStockResult | null> {
  const run = async (trx: Tx): Promise<ValueOpeningStockResult | null> => {
    await authorize(trx, actor, 'run_cutover', { storeId: input.storeId });
    await assertOpeningWritable(trx, actor.orgId, { requirePurge: true });

    const names = await cutoverRepo.storeNamesOf(trx, actor.orgId);
    const storeName = names.get(input.storeId) ?? 'this store';
    const rows = await cutoverRepo.countsForStore(trx, actor.orgId, input.storeId);

    // Counted but not priced: nobody can value it. Up to five names.
    const unpriced = new Map<string, string>();
    for (const r of rows) {
      if (toThousandths(toQuantity(r.quantity)) > 0n && (r.unitCost === null || costUnits(r.unitCost) === 0n)) unpriced.set(r.itemId, r.itemName);
    }
    if (unpriced.size > 0) {
      const list = [...unpriced.values()].sort((a, b) => a.localeCompare(b));
      const shown = list.slice(0, 5).join(', ');
      const more = list.length > 5 ? ` and ${list.length - 5} more` : '';
      throw refuse(
        `valueOpeningStock: ${list.length} counted item(s) at ${storeName} have no cost.`,
        `${list.length} counted item${list.length === 1 ? '' : 's'} at ${storeName} ${list.length === 1 ? 'has' : 'have'} no cost: ${shown}${more}. Type or import a cost for ${list.length === 1 ? 'it' : 'them'}, then value the count again.`,
      );
    }

    // R3 re-check: one cost per item per store.
    assertOneCostPerItem(rows, storeName);

    const plan = planOpeningStock(rows, itemKindsOf(rows)).find((p) => p.storeId === input.storeId);

    // Pressing it again deletes the draft and writes it fresh (it is a draft; T-134 correction 3).
    const key = openingStockKey(actor.orgId, input.storeId);
    const old = await journalRepo.findEntryByIdempotencyKey(trx, actor.orgId, key);
    if (old) await cutoverRepo.deleteDraftEntry(trx, actor.orgId, old.id);
    if (!plan || plan.accounts.length === 0) return null;

    const period = await journalRepo.findPeriodForDate(trx, actor.orgId, CONVERSION);
    if (!period) {
      throw refuse(
        `valueOpeningStock: no fiscal period covers ${CONVERSION}.`,
        `No fiscal period covers ${CONVERSION}. Create the opening period first: the conversion posts into it.`,
      );
    }
    const closed = await closedStockPeriodSentence(trx, actor.orgId, CONVERSION, 'opened');
    if (closed) throw refuse(`valueOpeningStock: ${closed}`, closed);

    const { id: entryId } = await journalRepo.insertDraftEntry(trx, {
      orgId: actor.orgId,
      entryDate: CONVERSION,
      periodId: period.id,
      memo: `Opening stock — ${storeName}`,
      sourceType: SOURCE_TYPE,
      sourceId: key,
      idempotencyKey: key,
    });
    const memo = `Opening stock — ${storeName}`;
    const lines: Parameters<typeof journalRepo.insertLines>[2] = [];
    let lineNo = 1;
    for (const a of plan.accounts) {
      lines.push({
        accountId: await journalRepo.resolveAccountId(trx, actor.orgId, a.code),
        lineNo: lineNo++,
        storeId: input.storeId,
        channelId: null,
        partyType: null,
        partyId: null,
        debit: money(a.amount),
        credit: money('0'),
        lineMemo: memo,
      });
    }
    lines.push({
      accountId: await journalRepo.resolveAccountId(trx, actor.orgId, EQUITY),
      lineNo: lineNo++,
      storeId: input.storeId,
      channelId: null,
      partyType: null,
      partyId: null,
      debit: money('0'),
      credit: money(plan.total),
      lineMemo: memo,
    });
    await journalRepo.insertLines(trx, entryId, lines);
    return { entryId, byAccount: plan.accounts };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * R7. Internal: called only from `postOpeningBalances`, inside its transaction, AFTER the tie-out and BEFORE the drafts post.
 * For every counted row with quantity above zero: one `opening` movement (the room kept) and one `opening` layer (the same instant,
 * the row's cost). Refuses, writing nothing, when a store's plan no longer matches its draft, when a counted row has no cost, when
 * the period is closed, or when opening movements already exist.
 */
export async function writeOpeningStock(tx: Tx, orgId: string, actorPersonId: string): Promise<void> {
  if (await cutoverRepo.openingStockMovementsExist(tx, orgId)) {
    throw refuse(
      'writeOpeningStock: opening stock movements already exist.',
      'The opening stock has already been written. A correction is an ordinary stock document.',
    );
  }
  const closed = await closedStockPeriodSentence(tx, orgId, CONVERSION, 'opened');
  if (closed) throw refuse(`writeOpeningStock: ${closed}`, closed);

  const names = await cutoverRepo.storeNamesOf(tx, orgId);
  const rows = await cutoverRepo.countsForStore(tx, orgId);
  const plans = planOpeningStock(rows, itemKindsOf(rows));
  const draftOf = new Map<string, string>();

  for (const storeId of new Set(rows.map((r) => r.storeId))) {
    assertOneCostPerItem(rows.filter((r) => r.storeId === storeId), names.get(storeId) ?? 'a store');
  }

  for (const plan of plans) {
    const storeName = names.get(plan.storeId) ?? 'a store';
    const again = `${storeName}'s count changed after it was valued: press Value the count again.`;
    const entry = await journalRepo.findEntryByIdempotencyKey(tx, orgId, openingStockKey(orgId, plan.storeId));
    if (plan.unpriced.length > 0) {
      const shown = plan.unpriced.slice(0, 5).map((u) => u.name).join(', ');
      throw refuse(
        `writeOpeningStock: ${plan.unpriced.length} counted item(s) at ${storeName} have no cost.`,
        `${plan.unpriced.length} counted item${plan.unpriced.length === 1 ? '' : 's'} at ${storeName} ${plan.unpriced.length === 1 ? 'has' : 'have'} no cost: ${shown}.`,
      );
    }
    const draftLines = entry ? await journalRepo.findLinesForEntryWithAccountCodes(tx, entry.id) : [];
    const have = new Map<string, string>();
    for (const l of draftLines) {
      if (l.accountCode !== EQUITY) have.set(l.accountCode, String(l.debit));
    }
    const same =
      plan.accounts.length === have.size &&
      plan.accounts.every((a) => have.has(a.code) && money(have.get(a.code)!) === money(a.amount));
    // A store whose every line values under 0.005 has NO inventory line and so no draft (valueOpeningStock returns null): that is a
    // valued plan, not a changed count. Its layers are still written (journal_entry_id null), so a retry behaves exactly like the first.
    if (plan.accounts.length === 0) {
      if (entry) throw refuse(`writeOpeningStock: ${again}`, again);
      continue;
    }
    if (!entry || !same) throw refuse(`writeOpeningStock: ${again}`, again);
    draftOf.set(plan.storeId, entry.id);
  }

  for (const r of rows) {
    const q = toQuantity(r.quantity);
    if (toThousandths(q) === 0n) continue;
    const cost = decimal(r.unitCost!, '14,4');
    const mv = await stockLedgerRepo.insertMovement(tx, {
      orgId,
      storeId: r.storeId,
      locationId: r.locationId,
      itemId: r.itemId,
      movedAt: CONVERSION_INSTANT,
      quantity: q,
      kind: 'opening',
      sourceType: 'opening_count',
      sourceId: r.id,
      journalEntryId: draftOf.get(r.storeId) ?? null,
      createdBy: actorPersonId,
    });
    await stockLayersRepo.createLayer(tx, {
      orgId,
      storeId: r.storeId,
      itemId: r.itemId,
      receivedAt: CONVERSION_INSTANT,
      quantity: q,
      unitCost: cost,
      source: 'opening',
      sourceId: r.id,
      movementId: mv.id,
    });
  }
}
