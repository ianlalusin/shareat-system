/**
 * T-502 S5 - the cost report by Group -> Category -> Sub-category -> Item
 * (docs/tasks/502-expense-item-catalog.md section 4 S5, sections 11 and 16). Read-only.
 *
 * THE ATTRIBUTION RULE (section 16). An expense is a category part of an invoice, so the unit is ONE INVOICE + ONE CATEGORY:
 *   T = posted expenses of category C on the invoice;  L = the invoice's lines whose item category is C.
 *   T <= L : T is shared over those lines pro-rata by line_total; centavos floored, the remainder to the largest line
 *            (a tie goes to the lowest line_no) so the shares add up to T exactly.
 *   T >  L : every line in full; (T - L) is the "(unitemised)" row under C, sub-category "(none)".
 *   no lines of C : all of T is "(unitemised)" under C.
 * Draft and voided expenses never count. The date is the expense business date (= the invoice date).
 * All money is centavos in bigint; quantities are scaled integers; nothing here is a float except the 0-100 percent,
 * which is rounded to one decimal in bigint first.
 */
import { expenseItemsRepo, accessRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { fromCentavos, toCentavos, money, type Money } from '@shareat/core/money';

export const UNITEMISED_NAME = '(unitemised)';
const NO_SUBCATEGORY = '(none)';

export interface ExpenseItemsInput {
  from: string;
  to: string;
  /** null = every store the actor may see. */
  storeId: string | null;
}

export interface ExpenseItemStoreRow {
  storeId: string;
  total: Money;
  timesBought: number;
}
export interface ExpenseItemRow {
  /** null on the "(unitemised)" row. */
  itemId: string | null;
  name: string;
  baseUnit: string | null;
  total: Money;
  /** 0..100 of the report total, one decimal. */
  pct: number;
  timesBought: number;
  avgUnitPrice: Money | null;
  byStore: ExpenseItemStoreRow[];
}
export interface ExpenseSubcategoryRow {
  subcategoryId: string | null;
  name: string;
  total: Money;
  pct: number;
  items: ExpenseItemRow[];
}
export interface ExpenseCategoryRow {
  categoryId: string;
  category: string;
  total: Money;
  pct: number;
  subcategories: ExpenseSubcategoryRow[];
}
export interface ExpenseGroupRow {
  group: string;
  total: Money;
  pct: number;
  categories: ExpenseCategoryRow[];
}
export interface ExpenseItemsReport {
  total: Money;
  groups: ExpenseGroupRow[];
}

export interface ExpenseItemLine {
  invoiceId: string;
  invoiceDate: string;
  storeId: string;
  lineNo: number;
  quantity: string;
  unit: string;
  lineTotal: Money;
  attributed: Money;
}

export interface UnitemisedExpense {
  expenseId: string;
  invoiceId: string;
  storeId: string;
  businessDate: string;
  amount: Money;
  particulars: string;
}

/** Which stores this viewer may read; a named store is authorized (refused when not held), none named = every held store. */
async function resolveScope(tx: Tx, actor: Actor, requested: string | null): Promise<readonly string[] | undefined> {
  if (requested) {
    await authorize(tx, actor, 'view_financial_reports', { storeId: requested });
    return [requested];
  }
  const covers = await accessRepo.personCoversWholeOrg(tx, actor.personId, actor.orgId);
  const held = covers
    ? await accessRepo.activeStoreIdsForOrg(tx, actor.orgId)
    : await accessRepo.storeIdsForPerson(tx, actor.personId);
  if (held.length === 0) await authorize(tx, actor, 'view_financial_reports', {});
  for (const s of held) await authorize(tx, actor, 'view_financial_reports', { storeId: s });
  return covers ? undefined : held;
}

/** "12.345" -> 12345n (a numeric text with a fixed scale, as the repo casts it). */
function scaled(text: string, scale: number): bigint {
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? text.slice(1) : text).split('.');
  const n = BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0').slice(0, scale) || '0');
  return negative ? -n : n;
}

interface AttributedLine {
  invoiceId: string;
  invoiceDate: string;
  storeId: string;
  categoryId: string;
  categoryName: string;
  group: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnit: string;
  purchaseUnit: string;
  subcategoryId: string | null;
  subcategoryName: string;
  quantity: string;
  lineCents: bigint;
  /** quantity x conversion factor, scale 9. */
  baseQty9: bigint;
  attributed: bigint;
}
interface Unitemised {
  invoiceId: string;
  storeId: string;
  categoryId: string;
  categoryName: string;
  group: string;
  cents: bigint;
}

async function attribute(tx: Tx, actor: Actor, input: ExpenseItemsInput) {
  const storeIds = await resolveScope(tx, actor, input.storeId);
  const scope = { orgId: actor.orgId, from: input.from, to: input.to, ...(storeIds ? { storeIds } : {}) };
  const [parts, lines] = await Promise.all([
    expenseItemsRepo.postedParts(tx, scope),
    expenseItemsRepo.linesOfScopedInvoices(tx, scope),
  ]);
  const linesByInvoice = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = linesByInvoice.get(l.invoiceId) ?? [];
    arr.push(l);
    linesByInvoice.set(l.invoiceId, arr);
  }
  const out: AttributedLine[] = [];
  const unitemised: Unitemised[] = [];
  for (const p of parts) {
    const t = toCentavos(money(p.total));
    const mine = (linesByInvoice.get(p.invoiceId) ?? []).filter((l) => l.categoryId === p.categoryId);
    const lineCents = mine.map((l) => toCentavos(money(l.lineTotal)));
    const lTotal = lineCents.reduce((s, c) => s + c, 0n);
    const base = { invoiceId: p.invoiceId, invoiceDate: p.businessDate, storeId: p.storeId, categoryId: p.categoryId, categoryName: p.categoryName, group: p.group };
    let shares: bigint[];
    let over = 0n;
    if (lTotal > 0n && t <= lTotal) {
      shares = lineCents.map((c) => (t * c) / lTotal);
      const remainder = t - shares.reduce((s, c) => s + c, 0n);
      if (remainder > 0n) {
        let best = 0;
        for (let i = 1; i < mine.length; i++) {
          const lc = lineCents[i]!;
          const bc = lineCents[best]!;
          if (lc > bc || (lc === bc && mine[i]!.lineNo < mine[best]!.lineNo)) best = i;
        }
        shares[best] = shares[best]! + remainder;
      }
    } else if (lTotal > 0n) {
      shares = lineCents;
      over = t - lTotal;
    } else {
      shares = mine.map(() => 0n);
      over = t;
    }
    mine.forEach((l, i) => {
      out.push({
        ...base,
        lineNo: l.lineNo,
        itemId: l.itemId,
        itemName: l.itemName,
        baseUnit: l.baseUnit,
        purchaseUnit: l.purchaseUnit,
        subcategoryId: l.subcategoryId,
        subcategoryName: l.subcategoryName ?? NO_SUBCATEGORY,
        quantity: l.quantity,
        lineCents: lineCents[i]!,
        baseQty9: scaled(l.quantity, 3) * scaled(l.conversionFactor, 6),
        attributed: shares[i]!,
      });
    });
    if (over > 0n) unitemised.push({ invoiceId: p.invoiceId, storeId: p.storeId, categoryId: p.categoryId, categoryName: p.categoryName, group: p.group, cents: over });
  }
  return { out, unitemised, scope };
}

/** 0..100, one decimal, half-up, in integer math. */
function pctOf(cents: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number(((cents * 2000n) / total + 1n) / 2n) / 10;
}

interface ItemAcc {
  itemId: string | null;
  name: string;
  baseUnit: string | null;
  total: bigint;
  lineKeys: Set<string>;
  lineTotal: bigint;
  baseQty9: bigint;
  stores: Map<string, { total: bigint; lineKeys: Set<string> }>;
}
interface SubAcc {
  id: string | null;
  name: string;
  items: Map<string, ItemAcc>;
}

const desc = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? -1 : 1);

export async function expenseItemsReport(tx: Tx, actor: Actor, input: ExpenseItemsInput): Promise<ExpenseItemsReport> {
  const { out, unitemised } = await attribute(tx, actor, input);

  const cats = new Map<string, { name: string; group: string; subs: Map<string, SubAcc> }>();
  const subOf = (categoryId: string, name: string, group: string, subId: string | null, subName: string): SubAcc => {
    let c = cats.get(categoryId);
    if (!c) cats.set(categoryId, (c = { name, group, subs: new Map() }));
    const key = subId ?? '';
    let s = c.subs.get(key);
    if (!s) c.subs.set(key, (s = { id: subId, name: subName, items: new Map() }));
    return s;
  };
  const itemOf = (s: SubAcc, itemId: string | null, name: string, baseUnit: string | null): ItemAcc => {
    const key = itemId ?? '';
    let i = s.items.get(key);
    if (!i) s.items.set(key, (i = { itemId, name, baseUnit, total: 0n, lineKeys: new Set(), lineTotal: 0n, baseQty9: 0n, stores: new Map() }));
    return i;
  };
  const storeOf = (i: ItemAcc, storeId: string) => {
    let s = i.stores.get(storeId);
    if (!s) i.stores.set(storeId, (s = { total: 0n, lineKeys: new Set() }));
    return s;
  };

  for (const a of out) {
    if (a.attributed <= 0n) continue;
    const i = itemOf(subOf(a.categoryId, a.categoryName, a.group, a.subcategoryId, a.subcategoryName), a.itemId, a.itemName, a.baseUnit);
    const key = `${a.invoiceId}#${a.lineNo}`;
    i.total += a.attributed;
    i.lineKeys.add(key);
    i.lineTotal += a.lineCents;
    i.baseQty9 += a.baseQty9;
    const st = storeOf(i, a.storeId);
    st.total += a.attributed;
    st.lineKeys.add(key);
  }
  for (const u of unitemised) {
    const i = itemOf(subOf(u.categoryId, u.categoryName, u.group, null, NO_SUBCATEGORY), null, UNITEMISED_NAME, null);
    i.total += u.cents;
    storeOf(i, u.storeId).total += u.cents;
  }

  // Build the tree with centavo totals, then sort and format.
  interface ItemN { cents: bigint; row: ExpenseItemRow }
  interface SubN { cents: bigint; row: ExpenseSubcategoryRow; items: ItemN[] }
  interface CatN { cents: bigint; row: ExpenseCategoryRow; subs: SubN[] }
  const catNodes: { group: string; node: CatN }[] = [];
  let grand = 0n;
  for (const [categoryId, c] of cats) {
    const subs: SubN[] = [];
    let catCents = 0n;
    for (const s of c.subs.values()) {
      const items: ItemN[] = [];
      let subCents = 0n;
      for (const i of s.items.values()) {
        subCents += i.total;
        const avg = i.itemId !== null && i.baseQty9 > 0n ? fromCentavos(((i.lineTotal * 10n ** 9n * 2n) / i.baseQty9 + 1n) / 2n) : null;
        const byStore = [...i.stores.entries()]
          .map(([storeId, v]) => ({ storeId, cents: v.total, timesBought: v.lineKeys.size }))
          .sort((x, y) => desc(x.cents, y.cents) || x.storeId.localeCompare(y.storeId))
          .map((v) => ({ storeId: v.storeId, total: fromCentavos(v.cents), timesBought: v.timesBought }));
        items.push({
          cents: i.total,
          row: { itemId: i.itemId, name: i.name, baseUnit: i.baseUnit, total: fromCentavos(i.total), pct: 0, timesBought: i.lineKeys.size, avgUnitPrice: avg, byStore },
        });
      }
      items.sort((x, y) => {
        if ((x.row.itemId === null) !== (y.row.itemId === null)) return x.row.itemId === null ? 1 : -1;
        return desc(x.cents, y.cents) || x.row.name.localeCompare(y.row.name);
      });
      catCents += subCents;
      subs.push({ cents: subCents, items, row: { subcategoryId: s.id, name: s.name, total: fromCentavos(subCents), pct: 0, items: [] } });
    }
    subs.sort((x, y) => {
      if ((x.row.subcategoryId === null) !== (y.row.subcategoryId === null)) return x.row.subcategoryId === null ? 1 : -1;
      return desc(x.cents, y.cents) || x.row.name.localeCompare(y.row.name);
    });
    grand += catCents;
    catNodes.push({ group: c.group, node: { cents: catCents, subs, row: { categoryId, category: c.name, total: fromCentavos(catCents), pct: 0, subcategories: [] } } });
  }

  const groupMap = new Map<string, { cents: bigint; cats: CatN[] }>();
  for (const { group, node } of catNodes) {
    const g = groupMap.get(group) ?? { cents: 0n, cats: [] };
    g.cents += node.cents;
    g.cats.push(node);
    groupMap.set(group, g);
  }

  const groups: ExpenseGroupRow[] = [...groupMap.entries()]
    .sort(([ka, a], [kb, b]) => desc(a.cents, b.cents) || ka.localeCompare(kb))
    .map(([group, g]) => ({
      group,
      total: fromCentavos(g.cents),
      pct: pctOf(g.cents, grand),
      categories: g.cats
        .sort((x, y) => desc(x.cents, y.cents) || x.row.category.localeCompare(y.row.category))
        .map((c) => ({
          ...c.row,
          pct: pctOf(c.cents, grand),
          subcategories: c.subs.map((s) => ({
            ...s.row,
            pct: pctOf(s.cents, grand),
            items: s.items.map((i) => ({ ...i.row, pct: pctOf(i.cents, grand) })),
          })),
        })),
    }));

  return { total: fromCentavos(grand), groups };
}

/** The invoice lines behind one item row. `attributed` sums to the item row's total. null itemId has no lines (see unitemisedExpenses). */
export async function expenseItemLines(
  tx: Tx,
  actor: Actor,
  input: ExpenseItemsInput & { itemId: string | null },
): Promise<ExpenseItemLine[]> {
  const { out } = await attribute(tx, actor, input);
  if (input.itemId === null) return [];
  return out
    .filter((a) => a.itemId === input.itemId && a.attributed > 0n)
    .sort((x, y) => x.invoiceDate.localeCompare(y.invoiceDate) || x.invoiceId.localeCompare(y.invoiceId) || x.lineNo - y.lineNo)
    .map((a) => ({
      invoiceId: a.invoiceId,
      invoiceDate: a.invoiceDate,
      storeId: a.storeId,
      lineNo: a.lineNo,
      quantity: a.quantity,
      unit: a.purchaseUnit,
      lineTotal: fromCentavos(a.lineCents),
      attributed: fromCentavos(a.attributed),
    }));
}

/**
 * Ruling 5: the drill-down on a "(unitemised)" row lists the EXPENSES (not lines): the posted expenses of that category
 * on the invoices that carry unitemised money.
 */
export async function unitemisedExpenses(
  tx: Tx,
  actor: Actor,
  input: ExpenseItemsInput & { categoryId: string },
): Promise<UnitemisedExpense[]> {
  const { unitemised, scope } = await attribute(tx, actor, input);
  const invoices = new Set(unitemised.filter((u) => u.categoryId === input.categoryId).map((u) => u.invoiceId));
  if (invoices.size === 0) return [];
  const rows = await expenseItemsRepo.postedExpensesOfCategory(tx, scope, input.categoryId);
  return rows
    .filter((r) => invoices.has(r.invoiceId))
    .map((r) => ({
      expenseId: r.expenseId,
      invoiceId: r.invoiceId,
      storeId: r.storeId,
      businessDate: r.businessDate,
      amount: money(r.amount),
      particulars: r.particulars,
    }));
}
