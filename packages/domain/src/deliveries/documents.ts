/**
 * T-166 — the delivery DOCUMENT: draft it (with its lines and proof photo), then receive it.
 * DEF-135, 2026-09-03: the engine (`receive.ts`'s `receiveDelivery`, `duplicate-risk.ts`) has
 * been built and tested since 2026-08-29 with zero callers anywhere in `apps/`. This file is
 * that caller — the seam between the screen and the engine.
 *
 * ## Two acts, two functions
 *
 * `createDeliveryDocument` writes the header and lines as a DRAFT — nothing moves yet, nothing
 * posts. `receiveDeliveryDocument` is the event: it turns a person's counted quantities into the
 * three things `receiveDelivery` already does atomically (movement, layer, journal entry).
 *
 * ## ⭐ Where the trigger fires, and why the order of writes matters
 *
 * `delivery_lines_shortage_explained_trg` (migration 0066) reads the delivery's CURRENT status
 * and validates a line's shape only when that status is `received`. So `receiveDeliveryDocument`
 * marks the delivery `received` FIRST, then writes each line's receipt fields — writing them in
 * the other order would have the trigger check against `draft` and validate nothing at all.
 *
 * ## ⭐ Role authorization vs. the trigger — two different jobs, on purpose
 *
 * The trigger only ever sees a boolean column (`over_receipt_allowed`); it cannot know WHO is
 * allowed to set it true. That is `authorize(tx, actor, 'allow_over_receipt', …)`'s job, called
 * here whenever a line asks for it — a cashier passing the flag is refused before a single row is
 * written (invariant 3), same as T-166 §7.2's own lesson: never re-implement what the trigger
 * already checks (short-needs-a-reason, over-needs-the-flag), but never skip a check the trigger
 * cannot make either.
 *
 * ## What is NOT built here
 *
 * ⛔ **Void.** Its refusal condition ("any layer consumed") needs a real usage path to test
 * against, and the task's own §7.6 defers it for that reason. ⛔ **The invoice link** —
 * `linkInvoiceToReceipt` (T-163) already exists and is tested; wiring a delivery to an invoice is
 * the AP screen's job, not this one.
 */
import { authorize, type Actor } from '@shareat/auth';
import { deliveriesRepo, filesRepo, stockLedgerRepo, type Tx } from '@shareat/db';
import type { ShortageReason } from '@shareat/db/schema';
import { duplicateRisk, type DuplicateWarning } from './duplicate-risk';
import { receiveDelivery, toBaseUnits, type ReceiveLineInput, type ReceiveResult } from './receive';
import { compareDecimal, decimal, type Decimal } from '@shareat/core/money';
import { parseFourDecimalCost } from '../commissary/catalogue';
import { parseDecimalInput } from '../shared/money-input';
import { gone, internalFault, refuse } from '../shared/refusal';
import {
  addQuantity,
  compareQuantity,
  isPositiveQuantity,
  isZeroQuantity,
  quantity,
  ZERO_QUANTITY,
  type Quantity,
} from '../stock/quantity';

/** Deliveries recorded in this many days count toward the "same item, same day" and hard-duplicate
 *  warnings — advisory only (§7.4); a delivery older than this simply stops being compared. */
const DUPLICATE_RISK_WINDOW_DAYS = 30;

/** `delivery_lines.conversion_factor`'s shape — numeric(14,6), packages/db/schema/deliveries.ts. */
const ZERO_FACTOR = decimal('0', '14,6');

/**
 * T-371 R6/C3 — parse one line figure into its column's brand, after `authorize()`. Every column this file parses is
 * NOT NULL with no default (`ordered_quantity`, `conversion_factor`), or is answered at the dock (`received_quantity`),
 * so a blank is refused in words rather than guessed — never a `'0'` invented here. `parseDecimalInput` writes the
 * sentence (it names the field, quotes the typed value, and says the places allowed); this re-raises it as a
 * `RefusalError` so the screen treats it like every other refusal in this file.
 */
function parseLineFigure<S extends `${number},${number}`>(
  raw: string,
  shape: S,
  rawLabel: string,
  humanLabel: string,
): Decimal<S> {
  try {
    return parseDecimalInput(raw, shape, rawLabel, humanLabel, { blank: 'refuse' });
  } catch (e) {
    const err = e as Error & { userMessage?: string };
    throw refuse(err.message, err.userMessage ?? `${humanLabel} — "${raw}" is not a valid figure.`);
  }
}

export interface CreateDeliveryLineInput {
  readonly itemId: string;
  /** In PURCHASE units, as agreed with the supplier or counted at the register. */
  readonly orderedQuantity: string;
  readonly purchaseUnit: string;
  readonly conversionFactor: string;
  readonly unitCost: string;
  /** `null` — undecided; parked in Receiving at receive time (T-166 invariant 5). */
  readonly locationId: string | null;
  /** S5.3b R3 — the operator's own VISIBLE form row (1-based), assigned by the caller BEFORE it
   *  drops any empty rows. Falls back to the post-filter array position when a caller omits it
   *  (existing callers, tests), so "Line n" still names something rather than nothing. */
  readonly lineNo?: number;
}

export interface CreateDeliveryInput {
  readonly storeId: string;
  /** ⛔ Never 'commissary' — that kind is created only by T-173's own cross-store receipt. */
  readonly kind: 'supplier' | 'purchase';
  readonly supplierId: string | null;
  readonly referenceNo: string | null;
  /** YYYY-MM-DD. */
  readonly deliveredOn: string;
  /** The photo of the paper — invariant 1. Must already exist in `stored_files`. */
  readonly proofFileId: string;
  readonly lines: readonly CreateDeliveryLineInput[];
}

export interface CreateDeliveryResult {
  readonly deliveryId: string;
  /** ⭐ Advisory. NEVER a reason to refuse the create — §7.4. */
  readonly warnings: readonly DuplicateWarning[];
}

/**
 * Draft a delivery or a cash purchase: header, lines, proof — nothing moves and nothing posts
 * until `receiveDeliveryDocument`.
 */
export async function createDeliveryDocument(
  tx: Tx,
  actor: Actor,
  input: CreateDeliveryInput,
): Promise<CreateDeliveryResult> {
  await authorize(tx, actor, 'receive_delivery', { storeId: input.storeId });

  if (input.kind !== 'supplier' && input.kind !== 'purchase') {
    // Invariant 13 — unreachable from a real user: the one production caller
    // (apps/erp/src/app/inventory/deliveries/actions.ts:116) computes `kind` as
    // `str(fd, 'kind') === 'supplier' ? 'supplier' : 'purchase'`, a ternary that can never
    // resolve to anything else regardless of what the form sends. Only a caller bypassing the
    // action (a direct `CreateDeliveryInput` with a bad `kind`) reaches this line.
    throw internalFault(
      "createDeliveryDocument: kind must be 'supplier' or 'purchase' — a commissary delivery is " +
        "created only by T-173's own cross-store receipt",
    );
  }
  if (input.kind === 'supplier' && !input.supplierId) {
    throw refuse('createDeliveryDocument: a supplier delivery must name its supplier', 'A supplier delivery must name its supplier.');
  }
  if (input.lines.length === 0) {
    throw refuse('createDeliveryDocument: a delivery needs at least one line', 'A delivery needs at least one line.');
  }

  // ⭐ Invariant 1, checked here even though the CHECK constraint also refuses it — the CHECK only
  // proves the column is non-null, never that the row it points at actually exists (T-166 §5,
  // citing DEF-077's own regression: a photo gate that only checks "a string was given" isn't one).
  const file = await filesRepo.getById(tx, actor.orgId, input.proofFileId);
  if (!file) {
    throw refuse(
      `createDeliveryDocument: proof file ${input.proofFileId} does not exist in this org`,
      'That photo could not be found — try attaching it again.',
    );
  }

  // T-328/DEF-382 — the validated value is CAPTURED and used below, not merely checked and
  // discarded. A bare call whose only job is to throw makes the call site's safety rest entirely
  // on `parseFourDecimalCost` never changing shape (`tryMoney` elsewhere in this tree is the
  // precedent for a "parser" that returns `null` on failure instead of throwing) — `const cost =
  // parseFourDecimalCost(...)` and using `cost` is self-guarding; a bare statement is not.
  const validatedUnitCosts: Decimal<'14,4'>[] = [];
  // T-371 — the ordered quantity and conversion factor are CAPTURED as brands too, the same way, and written below
  // instead of the raw strings (the unit-cost reasoning above applies to them word for word).
  const validatedQuantities: Quantity[] = [];
  const validatedFactors: Decimal<'14,6'>[] = [];
  for (const [i, line] of input.lines.entries()) {
    // R4.9 — named by LINE POSITION, never the item id: at this point the line hasn't been proved
    // to name a real item yet, so a position is the only human key available.
    // S5.3b R3 — `lineNo` is the operator's own VISIBLE form row, assigned by the caller before it
    // drops empty rows; the post-filter array index (`i + 1`) is only a fallback for callers that
    // never numbered their rows (existing callers, tests).
    const n = line.lineNo ?? i + 1;
    // T-371 — parsed into the column's brand first: a malformed figure ('abc', 'NaN') gets a sentence that quotes it,
    // where it used to throw a raw TypeError (the quantity) or read as "not greater than zero" (the factor).
    const ordered = parseLineFigure(
      line.orderedQuantity,
      '14,3',
      `createDeliveryDocument: item ${line.itemId}'s ordered quantity`,
      `Line ${n}: the ordered quantity`,
    );
    if (!isPositiveQuantity(ordered)) {
      throw refuse(
        `createDeliveryDocument: item ${line.itemId}'s ordered quantity must be greater than zero`,
        `Line ${n}: the ordered quantity must be greater than zero.`,
      );
    }
    const factor = parseLineFigure(
      line.conversionFactor,
      '14,6',
      `createDeliveryDocument: item ${line.itemId}'s conversion factor`,
      `Line ${n}: the conversion factor`,
    );
    if (compareDecimal(factor, ZERO_FACTOR) <= 0) {
      throw refuse(
        `createDeliveryDocument: item ${line.itemId}'s conversion factor must be greater than zero`,
        `Line ${n}: the conversion factor must be greater than zero.`,
      );
    }
    // ⛔ Unvalidated before this: the string reached `delivery_lines.unit_cost` (declared
    // `numeric(14,4)`, packages/db/schema/deliveries.ts:163) straight through, and Postgres's own
    // refusal was the only thing standing between a typo and the operator. NOT `parseMoneyInput`:
    // that enforces two decimal places, and this column is declared with four — confirmed against
    // the column declaration itself, not inferred from a test fixture. `parseFourDecimalCost` is
    // the matching shape, reused rather than adding a fourth validator (DEF-383). `0` is a
    // legitimate unit cost (a free sample, a promotional item) and the shape allows it, same as
    // the other two lines above.
    validatedUnitCosts.push(
      parseFourDecimalCost(line.unitCost, `createDeliveryDocument: item ${line.itemId}'s unit cost`, `Line ${n}: the unit cost`),
    );
    validatedQuantities.push(ordered);
    validatedFactors.push(factor);
  }

  // ⭐ Read what already exists BEFORE writing this one, so the new draft never gets compared
  // against itself.
  const recent = await deliveriesRepo.recentDeliveriesForRisk(tx, input.storeId, DUPLICATE_RISK_WINDOW_DAYS);
  const onHandRows = await stockLedgerRepo.onHandByStore(tx, input.storeId);
  const onHandByItem: Record<string, Quantity> = {};
  for (const row of onHandRows) {
    onHandByItem[row.itemId] = addQuantity(onHandByItem[row.itemId] ?? ZERO_QUANTITY, quantity(row.quantity));
  }
  const incomingByItem: Record<string, Quantity> = {};
  for (const [i, line] of input.lines.entries()) {
    // ⛔ `!` — same index invariant as `validatedUnitCosts[i]!` below (one push per line, same order, no filter).
    const base = toBaseUnits(validatedQuantities[i]!, validatedFactors[i]!);
    incomingByItem[line.itemId] = addQuantity(incomingByItem[line.itemId] ?? ZERO_QUANTITY, base);
  }

  const delivery = await deliveriesRepo.insertDelivery(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    kind: input.kind,
    supplierId: input.kind === 'supplier' ? input.supplierId : (input.supplierId ?? null),
    referenceNo: input.referenceNo,
    deliveredOn: input.deliveredOn,
    proofFileId: input.proofFileId,
    createdBy: actor.personId,
  });

  // ⚠️ The hard duplicate (same supplier + same reference, non-void) is a unique index — it fires
  // HERE, as a thrown constraint violation, and `actions.ts` translates it. The soft cases below
  // never block.
  await deliveriesRepo.insertDeliveryLines(
    tx,
    delivery.id,
    input.lines.map((line, i) => ({
      lineNo: String(i + 1),
      itemId: line.itemId,
      orderedQuantity: validatedQuantities[i]!,
      purchaseUnit: line.purchaseUnit,
      conversionFactor: validatedFactors[i]!,
      // T-328 — the validated value captured above, not `line.unitCost` (the raw, un-normalised
      // form `parseFourDecimalCost` already trimmed and proved valid).
      // ⛔ `!` is safe because `validatedUnitCosts` was built by iterating this SAME `input.lines`
      // array, one push per line, in the same order (docs/RULES.md §2 row 206) — index `i` here is
      // always in range because neither loop filters or reorders `input.lines` between them. If a
      // future edit adds a `.filter()`/`.sort()` to either loop over `input.lines`, this index
      // invariant breaks silently and this `!` is the only place that would have said so.
      unitCost: validatedUnitCosts[i]!,
      locationId: line.locationId,
    })),
  );

  const warnings = duplicateRisk({
    supplierId: input.supplierId,
    referenceNo: input.referenceNo,
    deliveredOn: input.deliveredOn,
    itemIds: input.lines.map((l) => l.itemId),
    existing: recent,
    onHandByItem,
    incomingByItem,
  });

  return { deliveryId: delivery.id, warnings };
}

export interface ReceiveDeliveryLineInput {
  readonly lineId: string;
  /** In PURCHASE units, as counted at the dock. Empty/blank is treated as zero — nothing arrived. */
  readonly receivedQuantity: string;
  /** Required by the trigger when the line is short; ignored (and overridden) when zero. */
  readonly shortageReason?: ShortageReason | null;
  /** Must be accompanied by `allow_over_receipt` — a cashier ticking this is refused (invariant 3). */
  readonly overReceiptOk?: boolean;
  /** `null`/omitted keeps whatever room the draft named; still `null` parks in Receiving. */
  readonly locationId?: string | null;
}

export interface ReceiveDeliveryDocumentInput {
  readonly deliveryId: string;
  readonly lines: readonly ReceiveDeliveryLineInput[];
}

/**
 * Receive a drafted delivery: every line answered, quantity/cost/location resolved, then handed
 * to `receiveDelivery` for the atomic movement+layer+posting.
 */
export async function receiveDeliveryDocument(
  tx: Tx,
  actor: Actor,
  input: ReceiveDeliveryDocumentInput,
): Promise<ReceiveResult> {
  const delivery = await deliveriesRepo.getDeliveryDocument(tx, input.deliveryId);
  if (!delivery) {
    throw gone(`receiveDeliveryDocument: delivery ${input.deliveryId} does not exist`, 'delivery');
  }

  // ⭐ Invariant 11 (RLS): passing the delivery's OWN org/store means a manager scoped to store A
  // is refused on store B's delivery, and a cross-org attempt is refused before the role check.
  await authorize(tx, actor, 'receive_delivery', { storeId: delivery.storeId, orgId: delivery.orgId });

  if (delivery.status !== 'draft') {
    throw refuse(
      `receiveDeliveryDocument: delivery ${input.deliveryId} is ${delivery.status}, not draft`,
      `This delivery is ${delivery.status}, not draft.`,
    );
  }

  const draftByLine = new Map(input.lines.map((l) => [l.lineId, l]));
  for (const line of delivery.lines) {
    if (!draftByLine.has(line.id)) {
      throw refuse(`receiveDeliveryDocument: line ${line.lineNo} was not answered`, `Line ${line.lineNo} was not answered.`);
    }
  }

  let anyOverReceipt = false;
  const receiveLines: ReceiveLineInput[] = [];
  const lineWrites: {
    lineId: string;
    receivedQuantity: Quantity;
    shortageReason: ShortageReason | null;
    overReceiptAllowed: boolean;
    locationId: string | null;
  }[] = [];

  for (const line of delivery.lines) {
    const draft = draftByLine.get(line.id)!;
    // T-371 — parsed into the column's brand, after `authorize()` above: 'abc' or 'NaN' is refused in words naming the
    // line, where it used to throw a raw TypeError. ⚠️ The blank-means-nothing-arrived rule (this input's own contract,
    // documented on `receivedQuantity` above, and the screen sends '0' for an empty box itself) is kept as it was.
    const receivedQty = parseLineFigure(
      draft.receivedQuantity || '0',
      '14,3',
      `receiveDeliveryDocument: line ${line.lineNo}'s received quantity`,
      `Line ${line.lineNo}: the received quantity`,
    );
    // R4 — a stored value, re-minted (never cast); `0155` keeps it finite, so this never refuses.
    const ordered = quantity(line.orderedQuantity);
    const cmp = compareQuantity(receivedQty, ordered);

    // ⭐ System-decided, never asked of the person (T-166's own picker excludes it) — a zero-
    // received line always means "did not arrive", regardless of what else was selected.
    let shortageReason: ShortageReason | null = null;
    if (isZeroQuantity(receivedQty)) {
      shortageReason = 'not_received';
    } else if (cmp < 0) {
      // ⛔ Passed through, not defaulted — an unexplained short line is exactly what the trigger
      // must refuse (test: "8 of 10 with no reason is refused").
      shortageReason = draft.shortageReason ?? null;
    }

    if (cmp > 0 && draft.overReceiptOk) {
      anyOverReceipt = true;
    }

    const locationId = draft.locationId !== undefined ? draft.locationId : (line.locationId ?? null);

    lineWrites.push({
      lineId: line.id,
      receivedQuantity: receivedQty,
      shortageReason,
      // ⚠️ Only a line that IS over-received carries the approval flag. The screen sends one
      // document-wide checkbox; stamping it on an in-full line would record a manager-only
      // approval nobody was asked for (review 2026-09-03).
      overReceiptAllowed: cmp > 0 && !!draft.overReceiptOk,
      locationId,
    });

    receiveLines.push({
      lineId: line.id,
      itemId: line.itemId,
      itemKind: line.itemKind,
      receivedQuantity: receivedQty,
      conversionFactor: line.conversionFactor,
      unitCost: line.unitCost,
      locationId,
      lineNo: line.lineNo,
    });
  }

  if (anyOverReceipt) {
    // ⛔ THE gate a cashier cannot pass, no matter what the form sends — checked before any write.
    await authorize(tx, actor, 'allow_over_receipt', { storeId: delivery.storeId });
  }

  // ⭐ markReceived FIRST — see this file's header. Writing the lines before this would have the
  // trigger validate nothing at all.
  await deliveriesRepo.markReceived(tx, delivery.id, { receivedBy: actor.personId, receivedAt: new Date() });

  for (const write of lineWrites) {
    await deliveriesRepo.updateLineReceipt(tx, write.lineId, {
      receivedQuantity: write.receivedQuantity,
      shortageReason: write.shortageReason,
      overReceiptAllowed: write.overReceiptAllowed,
      locationId: write.locationId,
    });
  }

  const locations = await deliveriesRepo.listLocationsLike(tx, delivery.storeId);

  const outcome = await receiveDelivery(tx, {
    orgId: delivery.orgId,
    storeId: delivery.storeId,
    deliveryId: delivery.id,
    deliveredOn: delivery.deliveredOn,
    lines: receiveLines,
    locations,
    receivedBy: actor.personId,
  });

  if (!outcome.ok) {
    // ⛔ The header and line updates above already wrote. THROW so the whole transaction unwinds
    // rather than leaving a `received` document with nothing posted — T-166 §7.2's own lesson,
    // repeated here one layer up. S5.3b — `receive.ts`'s own `userReason` (all four of its
    // reasons now carry one). Never `outcome.reason` itself in the sentence; that is the raw,
    // unsanitised diagnostic.
    throw refuse(
      `receiveDeliveryDocument: ${outcome.reason}`,
      outcome.userReason && outcome.userReason.trim() !== ''
        ? outcome.userReason
        : "This delivery couldn't be received. Reload the page and try again.",
    );
  }

  return outcome;
}
