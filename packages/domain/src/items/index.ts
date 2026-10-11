/**
 * The item master. T-145 — `docs/tasks/145-item-master-and-invoice-lines.md`.
 *
 * ⭐ One identity per purchasable thing, org-wide, with one canonical unit. That is the whole
 * feature: everything else (price history, supplier comparison, and eventually T-146's OCR
 * matching) is a query that only becomes answerable once the identity exists.
 *
 * ⛔ No cost lives here. `itemsRepo.priceHistory` derives it from invoice lines — v1's stored
 * `costPerUnit` is zero on 71% of its items, which is what a snapshot nobody maintains looks
 * like after a year.
 */
import {
  auditLogRepo,
  itemCodesRepo,
  itemsRepo,
  transaction,
  type InvoiceLineInput,
  type ItemRequestRow,
  type MergeReport,
  type SimilarItem,
  type Tx,
} from '@shareat/db';
import type { BaseUnit, ItemKind, ItemStatus, PurchaseUnit } from '@shareat/db/schema';
import { computeBranchPrice, type BranchPrice } from './branch-price';
import { authorize, type Actor } from '@shareat/auth';
import { decimal, toCentavos, type Decimal } from '@shareat/core/money';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';
import { parseQuantityInput } from '../shared/quantity-input';
import { isPositiveQuantity, toThousandths, type Quantity } from '../stock/quantity';
import { parseFourDecimalCost } from '../commissary/catalogue';
import { gone, refuse } from '../shared/refusal';
import { notActiveItemSentence } from './not-active';
import { formatItemCode, itemCodeStem, parseItemCode } from './code';
import { allocateItemCode, requireItemCodeStem, validateItemCodeOverride } from './code-allocation';

export { ITEM_CODE_RE, formatItemCode, itemCodeStem, parseItemCode } from './code';
export { allocateItemCode, requireItemCodeStem } from './code-allocation';

export interface CreateItemInput {
  /**
   * ⭐ T-386. Absent or blank: the code is allocated from the name (`CHWN-001`). Present: a super-admin OVERRIDE, validated
   * (shape, number above the stem's mark) and upper-cased. Only `approve_item` paths accept a code at all.
   */
  code?: string;
  name: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  notes?: string | null;
  /** ⭐ T-149. Default: purchasable, sold to nobody — the commonest case by far. */
  isPurchasable?: boolean;
  sellableRetail?: boolean;
  sellableWholesale?: boolean;
}

/**
 * ⛔ **Super-admin only** (Ian, 2026-08-28). Everyone else calls `requestItem` and waits.
 *
 * An item is the identity every price, every supplier link and every future OCR match keys on.
 * A duplicate is not a row you delete afterwards — it is a price history split in two, invisibly,
 * until somebody notices the chart is wrong. One person deciding is the strongest control
 * available, and unlike a similarity threshold it does not degrade as the catalogue grows.
 */
export async function createItem(tx: Tx | null, actor: Actor, input: CreateItemInput): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const name = input.name.trim();
    if (!name) throw new Error('createItem: an item needs a name people will recognise.');
    // T-386 R5: the name must yield a stem even when a code is typed - the name rule is independent of the code.
    const stem = requireItemCodeStem(name);
    const typed = (input.code ?? '').trim();
    const code = typed
      ? await validateItemCodeOverride(trx, actor.orgId, typed)
      : await allocateItemCode(trx, actor.orgId, stem);
    return itemsRepo.insertItem(trx, {
      orgId: actor.orgId,
      code,
      name,
      kind: input.kind,
      baseUnit: input.baseUnit,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
      isPurchasable: input.isPurchasable ?? true,
      sellableRetail: input.sellableRetail ?? false,
      sellableWholesale: input.sellableWholesale ?? false,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ DEF-130. The three T-149 flags are editable here too — the ORG's default answer. Until
 * 2026-09-03 this signature did not admit them, so no screen could ever change what an existing
 * item is sold as, and `createItemAction` never passed them either: every item made through the
 * app was sold to nobody, and a wholesale order on it was refused by its own gate. A store that
 * disagrees with the org still says so through `setStoreSellability`, never here.
 */
export async function updateItem(
  tx: Tx | null,
  actor: Actor,
  itemId: string,
  values: Partial<{
    kind: ItemKind;
    notes: string | null;
    isPurchasable: boolean;
    sellableRetail: boolean;
    sellableWholesale: boolean;
  }>,
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    // T-378 R4: one audited path for the unit. A caller that still passes it (the type no longer admits it) is told where to go.
    if ('baseUnit' in values) {
      const sentence = "Change the unit with Change unit on the item's page.";
      throw refuse(sentence, sentence);
    }
    // T-391 S1: one audited path for the buying unit.
    if ('purchaseUnit' in values || 'purchaseFactor' in values) {
      const sentence = "Set the buying unit with Buying unit on the item's page.";
      throw refuse(sentence, sentence);
    }
    // T-383 R2: one audited path for the name and the code.
    if ('name' in values || 'code' in values) {
      const sentence = "Rename an item with Rename on the item's page.";
      throw refuse(sentence, sentence);
    }
    const item = await itemsRepo.getItemById(trx, actor.orgId, itemId);
    if (!item) throw new Error(`updateItem: item ${itemId} does not exist.`);
    await itemsRepo.updateItem(trx, actor.orgId, itemId, values);
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ T-378 R4/R6. Correct an item's unit. Super-admin only (`approve_item`): the unit is part of the identity
 * a super-admin approved. "Has history" is decided once, by the database (`items_base_unit_fixed`); this
 * function does not re-implement it, so a refused change surfaces as the trigger's own constraint error and
 * writes no audit row (the append comes after the UPDATE, in the same transaction).
 */
export async function changeItemBaseUnit(
  tx: Tx | null,
  actor: Actor,
  input: { itemId: string; baseUnit: BaseUnit },
): Promise<{ changed: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw gone(`changeItemBaseUnit: item ${input.itemId} does not exist.`, 'item');
    if (item.baseUnit === input.baseUnit) return { changed: false };
    // T-391 S1: the buying-unit factor is in the OLD base unit; changing the base under it would silently re-read it.
    if (item.purchaseUnit !== null) {
      const sentence = "Clear the buying unit first; its factor is in the old unit.";
      throw refuse(sentence, sentence);
    }
    await itemsRepo.updateItem(trx, actor.orgId, input.itemId, { baseUnit: input.baseUnit });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'change_item_base_unit',
      entity: 'items',
      entityId: input.itemId,
      before: { baseUnit: item.baseUnit },
      after: { baseUnit: input.baseUnit },
      source: 'web',
    });
    return { changed: true };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Round a plain decimal string with more than six places to six, half up on the magnitude; anything else is returned as typed. */
function roundToScale6(raw: string): string {
  const m = /^(-?)(\d+)\.(\d{7,})$/.exec(String(raw).trim());
  if (m === null) return raw;
  const [, sign = '', whole = '0', frac = ''] = m;
  const extra = frac.length - 6;
  // BigInt throughout: the kept digits, the dropped digits, and "dropped >= half of one unit in the sixth place".
  const dropped = BigInt(frac.slice(6));
  const up = dropped * 2n >= 10n ** BigInt(extra) ? 1n : 0n;
  const scaled = BigInt(whole + frac.slice(0, 6)) + up;
  const digits = scaled.toString().padStart(7, '0');
  return `${sign}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/**
 * ⭐ T-391 S1. Set (or clear, with both null) an item's default buying unit: `box` / `24` for a box of 24 pcs. Gated on
 * `approve_item` and audited like `changeItemBaseUnit`, because T-390 divides delivered prices by the factor. The rules
 * (both or neither; not the base unit; a listed unit; a positive finite factor) are the database's CHECKs, not
 * re-implemented here, so a refused pair surfaces as the constraint's own error and writes no audit row (the append
 * comes after the UPDATE, in the same transaction). Setting what is already set writes nothing.
 */
export async function setItemPurchaseUnit(
  tx: Tx | null,
  actor: Actor,
  input: { itemId: string; purchaseUnit: PurchaseUnit | null; purchaseFactor: string | null; source?: 'web' | 'etl' },
): Promise<{ changed: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw gone(`setItemPurchaseUnit: item ${input.itemId} does not exist.`, 'item');
    // Parsed AFTER authorize, before any write: a malformed or oversize factor is a sentence, never a column overflow.
    // Normalised to the column's scale (6) so the comparison, the stored value and the audit `after` are one form.
    let factor: Decimal<'14,6'> | null = null;
    if (input.purchaseFactor !== null && input.purchaseFactor !== undefined) {
      try {
        factor = parseDecimalInput(roundToScale6(input.purchaseFactor), '14,6', 'setItemPurchaseUnit: the buying-unit factor', 'The buying-unit factor');
      } catch (e) {
        const msg = (e as { userMessage?: string }).userMessage ?? (e as Error).message;
        throw refuse((e as Error).message, msg);
      }
    }
    const same =
      item.purchaseUnit === input.purchaseUnit &&
      (item.purchaseFactor === null || factor === null
        ? item.purchaseFactor === factor
        : Number(item.purchaseFactor) === Number(factor));
    if (same) return { changed: false };
    await itemsRepo.updateItem(trx, actor.orgId, input.itemId, {
      purchaseUnit: input.purchaseUnit,
      purchaseFactor: factor,
    });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'set_item_purchase_unit',
      entity: 'items',
      entityId: input.itemId,
      before: { purchaseUnit: item.purchaseUnit, purchaseFactor: item.purchaseFactor },
      after: { purchaseUnit: input.purchaseUnit, purchaseFactor: factor },
      source: input.source ?? 'web',
    });
    return { changed: true };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ T-383 R1. Rename an item: name and code, one audited path, super-admin only (`approve_item`). A blank is passed
 * to the database as blank so its CHECK speaks; it is never replaced by the old value. The comparison is exact and
 * case-sensitive. `status` is never written. The audit append comes after the UPDATE, so a refused rename writes none.
 *
 * ⭐ T-386 R8 (Ian q4 = a: the code stays on rename; the screen OFFERS the new one). `adoptSuggestedCode === true` ignores the
 * typed code: the code stays when it is of the shape and its stem is the new name's stem, else a new one is allocated.
 * Otherwise a typed code equal to the current one is unchanged (so a legacy code survives a rename before the recode), a
 * blank goes to the database as blank, and any other change is an override (shape, number above the stem's mark).
 */
export async function renameItem(
  tx: Tx | null,
  actor: Actor,
  input: { itemId: string; name: string; code: string; adoptSuggestedCode?: boolean },
): Promise<{ changed: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw gone(`renameItem: item ${input.itemId} does not exist.`, 'item');
    const name = input.name.trim();
    const typed = input.code.trim();
    let code: string;
    if (input.adoptSuggestedCode === true) {
      const stem = requireItemCodeStem(name);
      code = parseItemCode(item.code)?.stem === stem ? item.code : await allocateItemCode(trx, actor.orgId, stem);
    } else if (typed === '') {
      code = typed;
    } else if (typed.toUpperCase() === item.code.toUpperCase()) {
      code = item.code; // the item's own code typed in another case is unchanged (R9)
    } else {
      code = await validateItemCodeOverride(trx, actor.orgId, typed);
    }
    if (name === item.name && code === item.code) return { changed: false };
    await itemsRepo.updateItem(trx, actor.orgId, input.itemId, { name, code });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'rename_item',
      entity: 'items',
      entityId: input.itemId,
      before: { name: item.name, code: item.code },
      after: { name, code },
      source: 'web',
    });
    return { changed: true };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ T-383 R3. Retire (`inactive`) or restore (`active`) an item: one audited, reversible path, super-admin only
 * (`approve_item`). Not gated on history, stock, maps or recipes (the page shows them). A merged item is refused in words
 * (the database's `items_merged_shape_check` backs it; this check exists for the sentence). The audit append comes after the UPDATE.
 */
export async function setItemStatus(
  tx: Tx | null,
  actor: Actor,
  input: { itemId: string; status: 'active' | 'inactive' },
): Promise<{ changed: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw gone(`setItemStatus: item ${input.itemId} does not exist.`, 'item');
    if (item.status === 'merged') {
      const S = 'This item was merged into another, so it cannot be retired or restored.';
      throw refuse(S, S);
    }
    if (item.status === input.status) return { changed: false };
    await itemsRepo.updateItem(trx, actor.orgId, input.itemId, { status: input.status });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: input.status === 'inactive' ? 'retire_item' : 'restore_item',
      entity: 'items',
      entityId: input.itemId,
      before: { status: item.status },
      after: { status: input.status },
      source: 'web',
    });
    return { changed: true };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Invoice lines — the rules a line must satisfy before it becomes a price observation
// -------------------------------------------------------------------------------------

export interface InvoiceLineDraft {
  itemId: string;
  description?: string | null;
  quantity: string;
  purchaseUnit: PurchaseUnit;
  /** purchase_unit → the item's base unit. 1 when they are the same unit. */
  conversionFactor: string;
  /** Per PURCHASE unit, as the supplier billed it. */
  unitPrice: string;
  lineTotal: string;
}

/**
 * T-367 S3 (DEF-420) — `quantity × unit price`, in whole centavos, rounded HALF-UP once. Both inputs are
 * exact decimal strings (quantity ≤ 3 dp from `parseQuantityInput`, price ≤ 4 dp from
 * `parseFourDecimalCost`), so the product is an integer in 10⁻⁷ peso and the only rounding is the final
 * ÷10⁵ — no float anywhere (bible §2.5). Half-up is on the absolute value (away from zero), the same
 * convention as `multiply` in `@shareat/core/money`.
 */
function lineCentavos(quantity: Quantity, unitPrice: Decimal<'14,4'>): bigint {
  const negative = unitPrice.startsWith('-');
  const [whole = '', frac = ''] = (negative ? unitPrice.slice(1) : unitPrice).split('.');
  const abs4 = BigInt(whole || '0') * 10000n + BigInt(frac.padEnd(4, '0'));
  const tenThousandths = negative ? -abs4 : abs4;
  // T-371 G3: both parts arrive minted (`parseQuantityInput`, `parseFourDecimalCost`) — no brand is asserted here.
  const product = toThousandths(quantity) * tenThousandths;
  const abs = product < 0n ? -product : product;
  const rounded = (abs + 50000n) / 100000n;
  return product < 0n ? -rounded : rounded;
}

/**
 * T-371 (DEF-382) — what `Number(raw)` made of a conversion factor, decided EXACTLY: is it above zero, and is it 1 to
 * within 10⁻⁹ (the old `Math.abs(factor - 1) > 1e-9`). Text in the decimal-literal shape `Number()` reads (optional sign,
 * digits with an optional point, an optional exponent) is read as `digits × 10^exp` in bigint; anything else — blank,
 * `1,5`, `abc` — is what `Number()` made `NaN` or `0`, so neither positive nor one. The format check that follows still
 * refuses every non-plain shape, so this widens nothing that is saved.
 */
function factorValue(text: string): { positive: boolean; one: boolean } {
  const m = /^([+-]?)(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!m) return { positive: false, one: false };
  const [int = '', frac = ''] = (m[2] ?? '').split('.');
  const digitText = `${int}${frac}`.replace(/^0+/, '');
  if (digitText === '') return { positive: false, one: false }; // zero, whatever its exponent
  if (m[1] === '-') return { positive: false, one: false };
  // value = digits × 10^exp
  const digits = BigInt(digitText);
  const exp = BigInt(m[3] ?? '0') - BigInt(frac.length);
  // value ∈ [10^(len−1+exp), 10^(len+exp)): far from 1 at either end, decided before any big power is built.
  const magnitude = BigInt(digitText.length) + exp;
  if (magnitude > 2n || magnitude < -1n) return { positive: true, one: false };
  const k = exp < -9n ? -exp : 9n; // a scale at which both the value and the 10⁻⁹ tolerance are integers
  const scaled = digits * 10n ** (exp + k);
  const unity = 10n ** k;
  const diff = scaled > unity ? scaled - unity : unity - scaled;
  return { positive: true, one: diff <= 10n ** (k - 9n) };
}

/** ₱ text for a centavo count that may sit outside `numeric(14,2)` — a mismatch sentence must still be
 *  readable then, which `fromCentavos` (it throws past the column's range) would not allow. */
function pesos(centavos: bigint): string {
  const abs = centavos < 0n ? -centavos : centavos;
  return `${centavos < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** T-379 S3b (DEF-568) — `pesos` with the whole-peso part grouped in thousands, for the refusal SENTENCES only.
 *  ⛔ `lineTotalFromParts` keeps the ungrouped `pesos`: its result is a `Money` string a column parses. */
function groupedPesos(centavos: bigint): string {
  return groupWhole(pesos(centavos));
}

/** Groups the whole-peso digits of a plain decimal; the decimals are left exactly as typed (a unit price keeps its 4). */
function groupWhole(text: string): string {
  const neg = text.startsWith('-');
  const [whole = '', frac] = (neg ? text.slice(1) : text).split('.');
  return `${neg ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac === undefined ? '' : `.${frac}`}`;
}

/**
 * ⭐ T-367 S3 (DEF-420) — a line's total from its parts, as the `Money` string `validateInvoiceLines` demands:
 * the SAME half-up centavo rounding it compares against, so a form that computes the total for the person
 * (`setInvoiceLinesAction`) can never hand the domain a figure the domain then disagrees with. ⛔ There is
 * no second rounding anywhere — a float `(q * p).toFixed(2)` gave 1.25 for 1 × 1.2550 where this gives 1.26.
 *
 * Total on purpose: parts that do not parse return `''`, and a product past `numeric(14,2)` is returned as the
 * digits it is. The caller runs BEFORE `authorize` and the item checks, so a refusal here would reorder them
 * (T-364's authorize-first rule); `validateInvoiceLines` parses the same parts first and says what is wrong
 * with its own written sentence, and refuses an out-of-range total with the parser's "too large".
 */
export function lineTotalFromParts(quantity: string, unitPrice: string): string {
  let centavos: bigint;
  try {
    centavos = lineCentavos(
      parseQuantityInput(quantity, 'lineTotalFromParts: quantity', 'The quantity'),
      parseFourDecimalCost(unitPrice, 'lineTotalFromParts: unit price', 'The unit price'),
    );
  } catch {
    return '';
  }
  return pesos(centavos);
}

/**
 * ⭐ Validates a set of lines against the invoice they belong to, and returns them numbered.
 *
 * Three rules, each of which exists because of something real:
 *
 * 1. **A line's parts must make its total.** A line whose arithmetic does not close is a typo,
 *    and a typo that gets stored becomes a price observation nobody can distinguish from a real
 *    one. (Also a DB CHECK — this is the readable error.)
 * 2. **`purchaseUnit === baseUnit` ⟹ `conversionFactor === 1`.** v1 has **7 items with
 *    `pack→pack` and 1 with `box→box` at a factor ≠ 1**, which is meaningless: a conversion
 *    between identical units is either 1 or a data error. Industry guidance says flag impossible
 *    conversions; this refuses them instead.
 * 3. **Lines, when present, sum to the header** to the centavo, exactly. Lines are OPTIONAL — a
 *    utility bill has none — but a partial set that silently disagreed with the total would be worse than
 *    none, because it looks like detail.
 *
 * ⭐ T-367 S3 (DEF-420): rules 1 and 3 compare integer CENTAVOS, never floats and never a tolerance. A
 * line is `quantity × unit price` rounded half-up to the centavo once and must EQUAL its stated total;
 * the stated totals are summed in centavos and must EQUAL the invoice total. Before this a ₱0.01 epsilon
 * on `Number`s let a set that was a whole centavo off (900.01 against 900.00) through.
 */
export async function validateInvoiceLines(
  trx: Tx,
  orgId: string,
  lines: InvoiceLineDraft[],
  invoiceTotal: string,
  /** ⭐ T-149: purchasability is resolved AT THIS STORE. Lipa makes the bulgogi sauce it sells;
   *  another branch buys it in, and the same item is legitimately both. */
  storeId?: string,
): Promise<InvoiceLineInput[]> {
  if (lines.length === 0) return [];

  // T-367 S3 (DEF-420): the invoice total is parsed FIRST, so a bad one is the parser's sentence and the exact
  // centavo comparison at the end can never see a non-number.
  const invoiceCentavos = toCentavos(
    parseMoneyInput(invoiceTotal, 'validateInvoiceLines: the invoice total', 'The invoice total'),
  );
  let sumCentavos = 0n;
  const out: InvoiceLineInput[] = [];

  for (const [i, l] of lines.entries()) {
    const item = await itemsRepo.getItemById(trx, orgId, l.itemId);
    if (!item) throw new Error(`validateInvoiceLines: line ${i + 1} names item ${l.itemId}, which does not exist.`);
    if (item.status !== 'active') {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} names ${item.name}, which is inactive.`,
        notActiveItemSentence(item.status, 'bought or received', `Line ${i + 1}`),
      );
    }
    // ⭐ T-149. A supplier billing us for something we MAKE means either the item is wrong or the
    // flag is — both worth stopping before it becomes a price observation. Resolved at the
    // invoice's own store when one is known, because the answer genuinely differs by branch.
    const resolved = storeId ? await itemsRepo.sellabilityAt(trx, orgId, l.itemId, storeId) : undefined;
    const purchasableHere = resolved ? resolved.isPurchasable : item.isPurchasable;
    if (!purchasableHere) {
      throw new Error(
        `validateInvoiceLines: line ${i + 1} names ${item.name}, which this store does not buy — ` +
          'it is made here, not purchased. Either the wrong item was picked, or this store should ' +
          'be marked as buying it.',
      );
    }

    // S5.5w item 3 — routes the quantity through the shared parser first, so a comma/malformed
    // string names itself instead of failing the plain `!(qty > 0)` guard below as a bare NaN.
    const quantityText = parseQuantityInput(
      l.quantity,
      `validateInvoiceLines: line ${i + 1}'s quantity`,
      `Line ${i + 1}'s quantity`,
    );
    const price = Number(l.unitPrice);
    // T-371 (DEF-382) — the factor's value is read EXACTLY (`factorValue`, scaled bigint), never through `Number()`, so no
    // `NaN` can slip a comparison: text that is no number at all is "not above zero", exactly as `!(NaN > 0)` made it.
    const factor = factorValue(l.conversionFactor);

    if (!isPositiveQuantity(quantityText)) {
      throw new Error(`validateInvoiceLines: line ${i + 1} (${item.name}) needs a quantity above zero.`);
    }
    if (!factor.positive) throw new Error(`validateInvoiceLines: line ${i + 1} (${item.name}) needs a conversion factor above zero.`);
    // S5.5w Amendment A1 item 2 — moved before the format/magnitude checks below: a same-unit line
    // demands factor === 1 regardless of what shape the typed value takes, so a malformed factor on
    // a same-unit line gets the "must be 1" sentence, not the six-decimal/too-large one.
    if (l.purchaseUnit === item.baseUnit && !factor.one) {
      // ⚠️ S5.5w Amendment A1 (orchestrator) — now fronts the format/magnitude checks below, so a
      // malformed factor on a same-unit line reaches this branch too; it must be presentable.
      // userMessage is byte-identical to the raw (minus the function-name prefix) — the sentence a
      // manager already saw via errorMessage()'s fallback strip stays exactly what they see now.
      throw refuse(
        `validateInvoiceLines: line ${i + 1} (${item.name}) is billed in ${l.purchaseUnit}, which is ` +
          `already the item's own unit — the conversion factor must be 1, not ${l.conversionFactor}.`,
        `line ${i + 1} (${item.name}) is billed in ${l.purchaseUnit}, which is already the item's own ` +
          `unit — the conversion factor must be 1, not ${l.conversionFactor}.`,
      );
    }
    // S5.5t Amendment A2 (revision 1b, auditor edit) — the `factor > 0` guard above still runs
    // first, so a blank or zero value never reaches this check. The format check must not narrow
    // what was already accepted (".5", "1." stay valid) — only the fraction length and
    // non-plain-decimal shapes (exponent notation, or no digit at all) are refused. Magnitude is
    // checked on the parsed VALUE, never the digit run, so a zero-padded "000000001" still saves as 1.
    const raw = l.conversionFactor.trim();
    const formatMatch = raw.match(/^(?=.*\d)(\d*)(?:\.(\d*))?$/);
    if (!formatMatch) {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} conversion factor ${JSON.stringify(raw)} is not a plain decimal`,
        `Line ${i + 1} (${item.name}) — "${raw}" is not a valid conversion factor. Use a number above zero with up to six decimal places.`,
      );
    }
    if ((formatMatch[2] ?? '').length > 6) {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} conversion factor ${JSON.stringify(raw)} has more than six decimal places`,
        `Line ${i + 1} (${item.name}) — "${raw}" is not a valid conversion factor. Use a number above zero with up to six decimal places.`,
      );
    }
    // T-371 R2 — minted at `conversion_factor`'s (14,6) shape, the column it is written to. The format check above has
    // already passed, so `decimal()` refuses only a value of 10^8 or more (RangeError) — the same boundary as the old
    // `factor >= 100000000`, decided exactly. ".5" and "1." (accepted above) are canonicalised first.
    const [factorWhole = '', factorFrac = ''] = raw.split('.');
    const factorText = `${factorWhole || '0'}${factorFrac ? `.${factorFrac}` : ''}`;
    let conversionFactor: Decimal<'14,6'>;
    try {
      conversionFactor = decimal(factorText, '14,6');
    } catch {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} conversion factor ${JSON.stringify(raw)} is too large: ${factorText.replace(/^0+(?=\d)/, '')}`,
        `Line ${i + 1} (${item.name}) — "${raw}" is too large for a conversion factor. Use a number below 100000000.`,
      );
    }
    // T-340/DEF-393 — price checked before total, so a typed `abc` unit price is what the app
    // path quotes, not the `NaN` computed from it (T-328 §4c). `Number.isFinite`, not a `>= 0`
    // comparison — that would add an out-of-scope negativity rule (money-positivity-guard shape).
    if (!Number.isFinite(price)) {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} (${item.name}) — the unit price "${l.unitPrice}" is not a number.`,
        `Line ${i + 1} (${item.name})'s unit price — "${l.unitPrice}" is not a number.`,
      );
    }
    // T-351 / DEF-480 — shape and precision via the shared cost parser (`parseFourDecimalCost`),
    // which never compares the value against zero (the money-positivity census, `NUMBER_CMP`) and
    // refuses more than four decimals. That makes `quantity × price` in the action byte-for-byte
    // the string that is stored, so the action needs no parse of its own.
    const unitPrice = parseFourDecimalCost(
      l.unitPrice,
      `validateInvoiceLines: line ${i + 1} (${item.name})'s unit price`,
      `Line ${i + 1} (${item.name})'s unit price`,
    );
    // T-367 S3 (DEF-420): the stated line total is parsed as money, exactly. Not a plain decimal at all keeps
    // the sentence it always had (now a written refusal, not a bare Error); a decimal the column cannot hold
    // (3 places, too large) gets the parser's own.
    if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(l.lineTotal.trim())) {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} (${item.name}) — the line total "${l.lineTotal}" is not a number.`,
        `Line ${i + 1} (${item.name}) — the line total "${l.lineTotal}" is not a number.`,
      );
    }
    const lineTotal = parseMoneyInput(l.lineTotal, `validateInvoiceLines: line ${i + 1}'s total`, `Line ${i + 1}'s total`);
    // The arithmetic itself, exactly, in centavos.
    const totalCentavos = toCentavos(lineTotal);
    const computedCentavos = lineCentavos(quantityText, unitPrice);
    if (totalCentavos !== computedCentavos) {
      throw refuse(
        `validateInvoiceLines: line ${i + 1} (${item.name}) does not add up — ${l.quantity} × ` +
          `₱${groupWhole(l.unitPrice.trim())} is ₱${groupedPesos(computedCentavos)}, not ₱${groupedPesos(totalCentavos)}.`,
        `Line ${i + 1} (${item.name}) does not add up — ${l.quantity} × ` +
          `₱${groupWhole(l.unitPrice.trim())} is ₱${groupedPesos(computedCentavos)}, not ₱${groupedPesos(totalCentavos)}.`,
      );
    }
    sumCentavos += totalCentavos;
    out.push({
      lineNo: i + 1,
      itemId: l.itemId,
      description: l.description?.trim() || null,
      // T-367 S3 — the NORMALISED figures (the parsed quantity text, the `Money` string), not the box text.
      quantity: quantityText,
      purchaseUnit: l.purchaseUnit,
      // S5.5w Amendment A1 item 3 — store the TRIMMED factor, not the raw box text (`' 2 '` saves
      // `2.000000`, not a value with stray whitespace reaching the column). T-371: now the (14,6)-minted figure.
      conversionFactor,
      // T-351 / DEF-480 — the PARSED, trimmed string (`parseFourDecimalCost`'s return), not the raw
      // box text: `quantity × price` downstream (`ap/actions.ts`) then uses the exact string stored.
      unitPrice,
      lineTotal,
    });
  }

  // T-367 S3 (DEF-420) — exact, in centavos: no epsilon, no float.
  if (sumCentavos !== invoiceCentavos) {
    throw refuse(
      `validateInvoiceLines: the lines total ₱${groupedPesos(sumCentavos)}, but the goods on this bill come to ` +
        `₱${groupedPesos(invoiceCentavos)}. Either the lines are incomplete or the total is wrong — both are worth ` +
        'fixing before this becomes a price everyone trusts.',
      `The lines total ₱${groupedPesos(sumCentavos)}, but the goods on this bill come to ₱${groupedPesos(invoiceCentavos)}. Either the lines are incomplete or ` +
        'the total is wrong — both are worth fixing before this becomes a price everyone trusts.',
    );
  }

  return out;
}

// -------------------------------------------------------------------------------------
// The supplier-item catalogue — T-147
// -------------------------------------------------------------------------------------

/**
 * ⭐ Declare that a supplier *could* sell us an item, before any invoice proves it.
 *
 * ⛔ There is no matching "record that they DID sell it" verb, and that is the design: an
 * observed link is derived from `supplier_invoice_lines` at read time, so recording an invoice
 * already creates it. Nothing to call, nothing to forget to call, nothing to drift.
 */
export async function declareSupplierItem(
  tx: Tx | null,
  actor: Actor,
  input: { supplierId: string; itemId: string; notes?: string | null },
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`declareSupplierItem: item ${input.itemId} does not exist.`);
    if (item.status !== 'active') {
      throw refuse(
        `declareSupplierItem: ${item.name} is inactive.`,
        notActiveItemSentence(item.status, 'bought from a supplier'),
      );
    }
    return itemsRepo.insertSupplierItem(trx, {
      orgId: actor.orgId,
      supplierId: input.supplierId,
      itemId: input.itemId,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Withdraw a declaration.
 *
 * ⛔ **It cannot reach an observed link, structurally rather than by a check** — an observation is
 * not a row, so there is nothing for DELETE to find. "You cannot un-buy something" needed a guard
 * in the first draft of this design; deriving the observed half removed the need for one.
 */
export async function undeclareSupplierItem(
  tx: Tx | null,
  actor: Actor,
  input: { supplierId: string; itemId: string },
): Promise<{ removed: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const removed = await itemsRepo.deleteSupplierItem(trx, actor.orgId, input.supplierId, input.itemId);
    return { removed };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// ⭐ T-148 — governance: request, approve, merge
// -------------------------------------------------------------------------------------

/** Renders the similarity hits as one sentence a human can act on. */
function warningFrom(similar: SimilarItem[], alsoListed: ReadonlySet<string> = new Set()): string | null {
  if (similar.length === 0) return null;
  // An item that the same-stem sentence already names is not named twice: here it is only its code and score.
  return (
    'Possible duplicate of ' +
    similar
      .map((s) =>
        alsoListed.has(s.id)
          ? `${s.code} (per ${s.baseUnit}, ${Math.round(s.similarity * 100)}% alike)`
          : `"${s.name}" (${s.code}, per ${s.baseUnit}, ${Math.round(s.similarity * 100)}% alike)`,
      )
      .join('; ')
  );
}

/** T-386 R6: the same-stem items as one sentence ("Same code letters as: CHWN-001 Chicken wings (active)"), or null. */
function sameStemWarning(sameStem: { code: string; name: string; status: string }[]): string | null {
  if (sameStem.length === 0) return null;
  return 'Same code letters as: ' + sameStem.map((s) => `${s.code} ${s.name} (${s.status})`).join(', ');
}

export interface RequestItemInput {
  name: string;
  kind: ItemKind;
  baseUnit: BaseUnit;
  reason?: string | null;
  /** ⭐ T-378 R7 (DEF-599). Omitted means the DB default: purchasable, sold to nobody. */
  isPurchasable?: boolean;
  sellableRetail?: boolean;
  sellableWholesale?: boolean;
}

export interface RequestItemResult {
  requestId: string;
  /** Shown to the requester now AND frozen on the request for the approver later. */
  similarWarning: string | null;
  similar: SimilarItem[];
}

/**
 * Ask for an item. Manager and admin may ask; only a super-admin decides.
 *
 * ⚠️ The similarity check WARNS and never blocks — `Coke 1.5` and `Coke 15` are 55% alike and
 * are genuinely different products. Blocking on that would make the catalogue unusable; showing it
 * to two people, the requester and then the approver, is what actually prevents the duplicate.
 */
export async function requestItem(
  tx: Tx | null,
  actor: Actor,
  input: RequestItemInput,
): Promise<RequestItemResult> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const name = input.name.trim();
    if (!name) throw new Error('requestItem: an item needs a name people will recognise.');
    // T-386 R6: a request takes NO code (I3). It stores a frozen preview - the next code at this moment, a preview and not a
    // promise: approval allocates. Nothing is locked or written to the counters here.
    const stem = requireItemCodeStem(name);
    const last = await itemCodesRepo.peekItemCodeStem(trx, actor.orgId, stem);
    const code = last >= 999 ? `${stem}-???` : formatItemCode(stem, last + 1);

    const similar = await itemsRepo.findSimilarItems(trx, actor.orgId, name);
    const sameStem = await itemCodesRepo.itemsSharingStem(trx, actor.orgId, stem);
    const similarWarning = [warningFrom(similar, new Set(sameStem.map((s) => s.id))), sameStemWarning(sameStem)].filter((w): w is string => w !== null).join('; ') || null;

    const { id } = await itemsRepo.insertItemRequest(trx, {
      orgId: actor.orgId,
      name,
      code,
      kind: input.kind,
      baseUnit: input.baseUnit,
      isPurchasable: input.isPurchasable,
      sellableRetail: input.sellableRetail,
      sellableWholesale: input.sellableWholesale,
      reason: input.reason?.trim() || null,
      similarWarning,
      requestedBy: actor.personId,
    });
    return { requestId: id, similarWarning, similar };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⛔ Super-admin only. Approving MINTS the item in the same transaction, so an approved request
 * that produced nothing cannot exist — the database refuses that shape outright.
 */
export async function approveItemRequest(
  tx: Tx | null,
  actor: Actor,
  input: {
    requestId: string;
    note?: string | null;
    /** ⭐ T-386 R7. A super-admin's override code. Absent or blank: allocated from the request's name at approval. */
    code?: string;
    /** ⭐ T-378 R5/REV-11. `undefined` falls back to the request's (`??`); a blank string is NOT absent and the CHECK refuses it. */
    baseUnit?: BaseUnit;
    isPurchasable?: boolean;
    sellableRetail?: boolean;
    sellableWholesale?: boolean;
  },
): Promise<{ itemId: string; code: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const req = await itemsRepo.getItemRequestById(trx, actor.orgId, input.requestId);
    if (!req) throw new Error(`approveItemRequest: request ${input.requestId} does not exist.`);
    if (req.status !== 'requested') {
      throw new Error(`approveItemRequest: request is already ${req.status}.`);
    }
    // T-386 R5: the code is allocated HERE, never copied from the request (its stored code is only the requester's preview).
    const stem = requireItemCodeStem(req.name);
    const typed = (input.code ?? '').trim();
    const code = typed
      ? await validateItemCodeOverride(trx, actor.orgId, typed)
      : await allocateItemCode(trx, actor.orgId, stem);
    const { id: itemId } = await itemsRepo.insertItem(trx, {
      orgId: actor.orgId,
      code,
      name: req.name,
      kind: req.kind,
      baseUnit: input.baseUnit ?? req.baseUnit,
      notes: `Approved from item request ${req.id}.`,
      createdBy: actor.personId,
      isPurchasable: input.isPurchasable ?? req.isPurchasable,
      sellableRetail: input.sellableRetail ?? req.sellableRetail,
      sellableWholesale: input.sellableWholesale ?? req.sellableWholesale,
    });
    await itemsRepo.decideItemRequest(trx, actor.orgId, req.id, {
      status: 'approved',
      decidedBy: actor.personId,
      decisionNote: input.note?.trim() || null,
      createdItemId: itemId,
    });
    return { itemId, code };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface ItemCodeSuggestion {
  stem: string | null;
  /** The next free code, or the item's own code with `forItemId`; null when the name has no stem or the stem is full. */
  code: string | null;
  full: boolean;
  sameStem: { id: string; code: string; name: string; status: ItemStatus }[];
}

/**
 * ⭐ T-386 R9. The live suggestion the item form shows while a name is typed. Read-only (I6): never creates a counter row,
 * never locks. `forItemId` is the item being renamed: its own code is returned when it is of the shape with that stem, and it is
 * left out of the same-stem list.
 */
export async function suggestItemCode(
  tx: Tx | null,
  actor: Actor,
  input: { name: string; forItemId?: string },
): Promise<ItemCodeSuggestion> {
  const run = async (trx: Tx): Promise<ItemCodeSuggestion> => {
    await authorize(trx, actor, 'manage_items', {});
    const stem = itemCodeStem(input.name);
    if (stem === null) return { stem: null, code: null, full: false, sameStem: [] };
    const sameStem = await itemCodesRepo.itemsSharingStem(trx, actor.orgId, stem, { excludeItemId: input.forItemId });
    if (input.forItemId) {
      const own = await itemsRepo.getItemById(trx, actor.orgId, input.forItemId);
      if (own && parseItemCode(own.code)?.stem === stem) return { stem, code: own.code, full: false, sameStem };
    }
    const last = await itemCodesRepo.peekItemCodeStem(trx, actor.orgId, stem);
    if (last >= 999) return { stem, code: null, full: true, sameStem };
    return { stem, code: formatItemCode(stem, last + 1), full: false, sameStem };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export async function rejectItemRequest(
  tx: Tx | null,
  actor: Actor,
  input: { requestId: string; note: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    const note = input.note.trim();
    // A rejection with no reason teaches the requester nothing, and they will simply ask again.
    if (!note) throw new Error('rejectItemRequest: say why, so the requester knows what to do instead.');
    await itemsRepo.decideItemRequest(trx, actor.orgId, input.requestId, {
      status: 'rejected',
      decidedBy: actor.personId,
      decisionNote: note,
      createdItemId: null,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Merge a duplicate into the item it should have been.
 *
 * ⛔ Super-admin only, and irreversible in practice: every invoice line, price-list rate and
 * supplier link that named the loser now names the winner, and the two histories become one.
 *
 * ⚠️ The loser's row SURVIVES, marked `merged` and pointing at the winner. Deleting it would
 * break the FKs that make the repoint safe, and would erase the fact that the duplicate ever
 * existed — the first thing someone investigating a price anomaly needs to see.
 */
export async function mergeItems(
  tx: Tx | null,
  actor: Actor,
  input: { loserId: string; winnerId: string },
): Promise<MergeReport> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_item', {});
    if (input.loserId === input.winnerId) throw new Error('mergeItems: an item cannot merge into itself.');

    const loser = await itemsRepo.getItemById(trx, actor.orgId, input.loserId);
    const winner = await itemsRepo.getItemById(trx, actor.orgId, input.winnerId);
    if (!loser) throw new Error(`mergeItems: item ${input.loserId} does not exist.`);
    if (!winner) throw new Error(`mergeItems: item ${input.winnerId} does not exist.`);
    if (loser.status === 'merged') throw new Error(`mergeItems: ${loser.name} is already merged.`);
    if (winner.status === 'merged') {
      throw new Error(`mergeItems: ${winner.name} is itself merged — merge into the surviving item.`);
    }
    // ⛔ Different base units means these are not the same thing, or one of them is wrong. Either
    // way, merging would silently reinterpret every past price: in v1's real data `Bean sprout` is
    // kg and `Beans Sprout` is pcs, and combining those turns the ratio into a number with no
    // meaning. Refuse, and make someone fix the unit first.
    if (loser.baseUnit !== winner.baseUnit) {
      throw new Error(
        `mergeItems: ${loser.name} is measured in ${loser.baseUnit} and ${winner.name} in ` +
          `${winner.baseUnit}. Fix the unit on one of them first — merging now would make every ` +
          'past price incomparable.',
      );
    }
    return itemsRepo.mergeItemInto(trx, actor.orgId, input.loserId, input.winnerId);
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** What the super-admin review queue reads. Any manager may LOOK; only a super-admin decides. */
export async function pendingItemRequests(tx: Tx | null, actor: Actor): Promise<ItemRequestRow[]> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    return itemsRepo.listItemRequests(trx, actor.orgId, { status: 'requested' });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ Say what ONE store does with an item, where it differs from the org's answer.
 *
 * ⚠️ Pass `null` for a flag to mean *"no opinion, follow the org"* — not `false`. The difference
 * matters: `false` freezes today's default into a copy that stops tracking it.
 */
export async function setStoreSellability(
  tx: Tx | null,
  actor: Actor,
  input: {
    storeId: string;
    itemId: string;
    isPurchasable?: boolean | null;
    sellableRetail?: boolean | null;
    sellableWholesale?: boolean | null;
    note?: string | null;
  },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`setStoreSellability: item ${input.itemId} does not exist.`);

    const p = input.isPurchasable ?? null;
    const r = input.sellableRetail ?? null;
    const w = input.sellableWholesale ?? null;
    if (p === null && r === null && w === null) {
      // The DB refuses this too; saying it here explains WHY rather than quoting a constraint.
      throw new Error(
        'setStoreSellability: an override that overrides nothing is noise that looks like a ' +
          'decision. Clear it instead if this store should follow the organisation.',
      );
    }
    await itemsRepo.upsertStoreSellability(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      itemId: input.itemId,
      isPurchasable: p,
      sellableRetail: r,
      sellableWholesale: w,
      note: input.note?.trim() || null,
      setBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Return a store to the organisation's answer. */
export async function clearStoreSellability(
  tx: Tx | null,
  actor: Actor,
  input: { storeId: string; itemId: string },
): Promise<{ cleared: boolean }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const cleared = await itemsRepo.clearStoreSellability(trx, actor.orgId, input.storeId, input.itemId);
    return { cleared };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// =====================================================================================
// T-151 - the branch price
// =====================================================================================

export type { BranchPriceRule, BranchPrice } from './branch-price';
export { computeBranchPrice };

/** The figure each pricing mode cannot do without, in the words a screen shows. */
const MODE_FIGURE = {
  fixed: 'The fixed price',
  fixed_markup: 'The markup amount',
  percent_markup: 'The markup percent',
} as const;

/** Say how an item's branch price is worked out. */
export async function setItemPricing(
  tx: Tx | null,
  actor: Actor,
  input: {
    itemId: string;
    pricingMode: 'fixed' | 'fixed_markup' | 'percent_markup';
    fixedAmount?: string | null;
    markupPercent?: string | null;
    fixedMarkupAmount?: string | null;
    marginAlertThresholdPct?: string | null;
  },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`setItemPricing: item ${input.itemId} does not exist.`);
    if (item.status !== 'active') {
      throw refuse(
        `setItemPricing: ${item.name} is not active (${item.status}).`,
        notActiveItemSentence(item.status, 'given a new price'),
      );
    }

    // ⭐ T-371 (R5, R6) — every figure is parsed AFTER `authorize()`, at its `item_pricing` column's shape. All four
    // columns are NULLABLE with no default, so a blank is stored as null — never a guessed '0'; a blank in the mode's
    // own figure then meets the "needs its own number" refusal below instead of reaching the column as ''.
    const fixedAmount = parseDecimalInput(input.fixedAmount, '14,2', 'setItemPricing: the fixed amount', 'The fixed price', {
      blank: 'null',
    });
    const markupPercent = parseDecimalInput(input.markupPercent, '8,4', 'setItemPricing: the markup percent', 'The markup percent', {
      blank: 'null',
    });
    const fixedMarkupAmount = parseDecimalInput(
      input.fixedMarkupAmount,
      '14,2',
      'setItemPricing: the fixed markup amount',
      'The markup amount',
      { blank: 'null' },
    );
    const marginAlertThresholdPct = parseDecimalInput(
      input.marginAlertThresholdPct,
      '8,4',
      'setItemPricing: the margin alert threshold',
      'The margin alert threshold',
      { blank: 'null' },
    );

    const need = {
      fixed: fixedAmount,
      fixed_markup: fixedMarkupAmount,
      percent_markup: markupPercent,
    }[input.pricingMode];
    if (need == null) {
      throw refuse(
        `setItemPricing: ${input.pricingMode} needs its own number - a mode without one prices ` +
          'at zero, silently.',
        `${MODE_FIGURE[input.pricingMode]} — can't be left blank for this pricing mode. Enter a number.`,
      );
    }
    await itemsRepo.upsertItemPricing(trx, {
      orgId: actor.orgId,
      itemId: input.itemId,
      pricingMode: input.pricingMode,
      fixedAmount,
      markupPercent,
      fixedMarkupAmount,
      marginAlertThresholdPct,
      setBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Price this item off ANOTHER item's cost - v1's `costBasisProductId`. Sliced meat prices off its
 * source slab, which is the thing actually bought and so the only one with a real received cost.
 */
export async function setCostBasisItem(
  tx: Tx | null,
  actor: Actor,
  input: { itemId: string; costBasisItemId: string | null },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_items', {});
    const item = await itemsRepo.getItemById(trx, actor.orgId, input.itemId);
    if (!item) throw new Error(`setCostBasisItem: item ${input.itemId} does not exist.`);

    if (input.costBasisItemId) {
      if (input.costBasisItemId === input.itemId) {
        throw new Error('setCostBasisItem: an item cannot price off itself.');
      }
      const basis = await itemsRepo.getItemById(trx, actor.orgId, input.costBasisItemId);
      if (!basis) throw new Error('setCostBasisItem: the cost-basis item does not exist.');
      // A chain that loops would resolve forever, or resolve to whichever link happened to be
      // read first. Refused outright rather than depth-limited.
      const seen = new Set<string>([input.itemId]);
      let cursor: string | null = input.costBasisItemId;
      while (cursor) {
        if (seen.has(cursor)) {
          throw new Error(
            'setCostBasisItem: that link would form a cycle, and a cycle prices off itself ' +
              'eventually. Point it at something that has its own purchase history.',
          );
        }
        seen.add(cursor);
        const next = await itemsRepo.getItemById(trx, actor.orgId, cursor);
        cursor = next?.costBasisItemId ?? null;
      }
    }
    await itemsRepo.updateItem(trx, actor.orgId, input.itemId, {
      costBasisItemId: input.costBasisItemId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * What this item should be charged to a branch at, right now.
 *
 * Undefined when nothing can cost it - the caller surfaces that as "cost not set" rather than
 * silently pricing at zero, exactly as v1 does.
 */
export async function branchPriceFor(
  tx: Tx,
  orgId: string,
  itemId: string,
): Promise<(BranchPrice & { basisFrom: 'own' | 'linked' }) | undefined> {
  const rule = await itemsRepo.getItemPricing(tx, orgId, itemId);
  if (!rule) return undefined;
  const basis = await itemsRepo.costBasisFor(tx, orgId, itemId);
  // A fixed price needs no basis at all - it is a number somebody chose.
  if (!basis && rule.pricingMode !== 'fixed') return undefined;
  const computed = computeBranchPrice(rule, basis?.basis ?? '0');
  return { ...computed, basisFrom: basis?.basisFrom ?? 'own' };
}
