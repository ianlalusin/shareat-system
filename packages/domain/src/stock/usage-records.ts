/**
 * Usage, wastage — the DOCUMENT. T-168 / DEF-135.
 *
 * ⭐ **This is the authorize-and-orchestrate layer over `usage.ts`'s engine.** `usage.ts`'s
 * `postUsageRecord`/`voidUsageRecord` are tx-level and carry NO `authorize()` call at all (they
 * take FIFO/ledger inputs, not an `Actor`) — this file is what turns "a person, acting" into the
 * inputs that engine expects, exactly the split T-167's `transfers.ts` already established
 * (`consume.ts`/`layers.ts` engine, `transfers.ts` document) and T-169's `count-sessions.ts` +
 * `count-workflow.ts` repeats concurrently with this task.
 *
 * ## Draft → post → void, and only the middle one moves stock
 *
 * `saveUsageDraft` never calls `stockLedgerRepo` or `usage.ts` — it only ever writes
 * `stock_usage_records`/`stock_usage_lines`. `postUsage` is the one function in this file that
 * calls `postUsageRecord`, and it is manager-only (`post_usage`).
 *
 * ## ⚠️ The COGS category, and why it lives here rather than on the item
 *
 * Items carry no COGS-category column (`packages/db/schema/items.ts` has `kind` only — T-149 chose
 * three independent sellability flags, not a costing taxonomy). `cogsCategoryForItemKind` is the
 * one place that bridges `ItemKind` to COA-ALIGNMENT §4.1's category. v1 posts every kind to one
 * COGS line too (`meat-usage.actions.ts` never varied by item), so this is parity, not a
 * regression — and COA-ALIGNMENT already marks `5100` "drive to zero" for exactly the items this
 * mapping cannot place more precisely.
 *
 * ## ✅ Void reverses stock, layers AND the entry — DEF-141, fixed by the coordinator
 *
 * Building this screen found that `usage.ts`'s `voidUsageRecord` reversed stock and the FIFO
 * layers (`reverseConsumption`) but left the `Dr 5110/5300 · Cr inventory` entry standing — reported
 * per bible §3.4a rather than patched around here, since `usage.ts` is out of this lane's scope.
 * The coordinator fixed the engine itself (DEF-141): `voidUsageRecord` now finds the posted
 * entries by `(source_type = kind, source_id LIKE '<recordId>:%')` and reverses each through
 * `reverseEntry`, returning `reversalEntryIds`. `voidUsage` below passes the caller's void reason
 * through as `VoidUsageInput.reason`, which lands on the reversal entries' memo.
 */
import { authorize, type Actor } from '@shareat/auth';
import { posMappingRepo, stockUsageRepo, type Tx } from '@shareat/db';
import { toBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { humanDate } from '../shared/refusal-leaf';
import { voidPullUsageRecord } from './void-pull-usage-record';
import type { Money } from '@shareat/core/money';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from './receipt-posting';
import { compareQuantity, quantity, ZERO_QUANTITY } from './quantity';
import { parseRequiredQuantity } from './quantity-field';
import {
  postUsageRecord,
  voidUsageRecord,
  type PostUsageInput,
  type UsageLineInput,
  type VoidUsageInput,
} from './usage';
import { isReservedUsageCategory, isWastageReason, type WastageReason } from './wastage-reasons';

/**
 * COA-ALIGNMENT §4.1's consumption category, derived from the item's own `kind` — see this file's
 * header. `meat_slab`/`meat_sliced` → meat; `retail` → retail; `supply` → packaging;
 * `raw_material`/`prepped` (the latter not yet a real `ItemKind`, T-176's future output) and
 * anything else → the `food` catch-all, which is the COA's own designated drain for an
 * unclassified kind rather than a silent guess at a more specific one.
 */
export function cogsCategoryForItemKind(kind: string): string {
  switch (kind) {
    case 'meat_slab':
    case 'meat_sliced':
      return 'meat';
    case 'retail':
      return 'retail';
    case 'supply':
      return 'packaging';
    case 'raw_material':
    case 'prepped':
    default:
      return 'food';
  }
}

function reservedCategoryReason(value: string): string {
  return (
    `"${value}" is a reserved category: a usage writes only an OUT leg, so a transfer recorded ` +
    'here would destroy the stock instead of moving it. Use a stock transfer.'
  );
}

export interface UsageDraftLine {
  readonly itemId: string;
  /** Decimal string, must be greater than zero. T-371 S3: parsed at the entry after `authorize()`; a blank is refused. */
  readonly quantity: string;
}

export interface SaveUsageDraftInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly kind: 'usage' | 'wastage';
  /** YYYY-MM-DD. */
  readonly usedOn: string;
  /** Required for `wastage`, refused for `usage` — the DB CHECK agrees either way. */
  readonly reasonCode?: string | null;
  readonly departmentId?: string | null;
  readonly lines: readonly UsageDraftLine[];
}

export type DraftOutcome = { readonly ok: true; readonly recordId: string } | { readonly ok: false; readonly reason: string };
export type LineOutcome = { readonly ok: true; readonly lineId: string } | { readonly ok: false; readonly reason: string };
export type VoidableOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type VoidUsageOutcome =
  | { readonly ok: true; readonly reversalEntryIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };
export type PostOutcome =
  | {
      readonly ok: true;
      readonly totalCost: Money;
      readonly entryIds: readonly string[];
      /**
       * ⭐ T-223. The store and the items this post touched, so the caller can trigger the low-stock
       * auto-order **after the transaction commits** without re-reading them.
       *
       * ⚠️ Returned rather than re-fetched deliberately: the action would otherwise issue a second
       * query for data already loaded here, and race a concurrent void while doing it.
       */
      readonly storeId: string;
      readonly itemIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

function capabilityFor(kind: 'usage' | 'wastage'): 'record_wastage' | 'record_stock_movement' {
  return kind === 'wastage' ? 'record_wastage' : 'record_stock_movement';
}

/**
 * Saves a whole draft — header and every line — in one call. ⭐ Never writes `stock_movements`;
 * posting (below) is the only step that moves stock (T-168 §3).
 */
export async function saveUsageDraft(tx: Tx, actor: Actor, input: SaveUsageDraftInput): Promise<DraftOutcome> {
  await authorize(tx, actor, capabilityFor(input.kind), { storeId: input.storeId });
  // T-371 S3 (R5, R6): every line's quantity becomes the brand here, after `authorize()`; a blank is refused.
  const lines = input.lines.map((l, i) => ({
    itemId: l.itemId,
    quantity: parseRequiredQuantity(l.quantity, `saveUsageDraft: the quantity for item ${l.itemId}`, `Line ${i + 1}'s quantity`),
  }));

  if (lines.length === 0) {
    return { ok: false, reason: 'a usage record needs at least one line' };
  }
  for (const line of lines) {
    if (compareQuantity(line.quantity, ZERO_QUANTITY) <= 0) {
      return { ok: false, reason: `the line for item ${line.itemId} must have a quantity greater than zero` };
    }
  }

  let reasonCode: string | null = null;
  if (input.kind === 'wastage') {
    reasonCode = input.reasonCode?.trim() || null;
    if (!reasonCode) {
      return { ok: false, reason: 'a wastage must carry a reason' };
    }
    // ⭐ Checked BEFORE the enum check, on purpose, mirroring `usage.ts`'s own ordering: T-168's
    // named footgun is about the STRING, not about which reasons a select happens to offer today.
    if (isReservedUsageCategory(reasonCode)) {
      return { ok: false, reason: reservedCategoryReason(reasonCode) };
    }
    if (!isWastageReason(reasonCode)) {
      return { ok: false, reason: `"${reasonCode}" is not a recognised wastage reason` };
    }
  } else if (input.reasonCode) {
    return { ok: false, reason: 'only a wastage record carries a reason' };
  }

  // ⚠️ Whether the room is `operating` is NOT re-checked here. `stock_usage_operating_location_trg`
  // (migration 0067) is the control (bible row 104: never re-implement a DB-enforced rule) — a
  // storage/Receiving/inactive room throws from this insert, unhandled by design; the UI's
  // `actions.ts` translates the raised message onto the screen.
  const { id: recordId } = await stockUsageRepo.insertUsageRecord(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    locationId: input.locationId,
    kind: input.kind,
    usedOn: input.usedOn,
    departmentId: input.departmentId ?? null,
    reasonCode,
    createdBy: actor.personId,
  });

  await stockUsageRepo.insertUsageLines(
    tx,
    recordId,
    lines.map((l, i) => ({ lineNo: String(i + 1), itemId: l.itemId, quantity: l.quantity })),
  );

  return { ok: true, recordId };
}

type LoadedDraft =
  | { readonly ok: true; readonly record: NonNullable<Awaited<ReturnType<typeof stockUsageRepo.getUsageRecord>>> }
  | { readonly ok: false; readonly reason: string };

async function loadDraftForEdit(tx: Tx, actor: Actor, recordId: string): Promise<LoadedDraft> {
  const record = await stockUsageRepo.getUsageRecord(tx, recordId);
  if (!record) return { ok: false, reason: `usage record ${recordId} does not exist` };
  await authorize(tx, actor, capabilityFor(record.kind === 'wastage' ? 'wastage' : 'usage'), {
    storeId: record.storeId,
  });
  if (record.status !== 'draft') {
    return { ok: false, reason: `usage record ${recordId} is ${record.status}, not draft` };
  }
  return { ok: true, record };
}

/**
 * Adds one line to an EXISTING draft. ⚠️ Built to the task's contract (§5) but has no UI caller in
 * this pass — the "New record" form creates every line the draft starts with in one submission
 * (dynamic rows), the same shape `NewOrderForm`/`saveBranchOrderDraft` already use. Reported as a
 * deliberate, named scope choice rather than a silent gap — see the task doc's Built section.
 */
export async function addUsageLine(
  tx: Tx,
  actor: Actor,
  input: { readonly recordId: string; readonly itemId: string; readonly quantity: string },
): Promise<LineOutcome> {
  const loaded = await loadDraftForEdit(tx, actor, input.recordId);
  if (!loaded.ok) return loaded;
  const qty = parseRequiredQuantity(input.quantity, 'addUsageLine: the quantity', 'Quantity');
  if (compareQuantity(qty, ZERO_QUANTITY) <= 0) {
    return { ok: false, reason: 'a line must have a quantity greater than zero' };
  }
  const existing = await stockUsageRepo.listUsageLines(tx, input.recordId);
  const [line] = await stockUsageRepo.insertUsageLines(tx, input.recordId, [
    { lineNo: String(existing.length + 1), itemId: input.itemId, quantity: qty },
  ]);
  return { ok: true, lineId: line!.id };
}

export async function removeUsageLine(
  tx: Tx,
  actor: Actor,
  input: { readonly recordId: string; readonly lineId: string },
): Promise<VoidableOutcome> {
  const loaded = await loadDraftForEdit(tx, actor, input.recordId);
  if (!loaded.ok) return loaded;
  await stockUsageRepo.deleteUsageLine(tx, input.lineId);
  return { ok: true };
}

export async function deleteUsageDraft(
  tx: Tx,
  actor: Actor,
  input: { readonly recordId: string },
): Promise<VoidableOutcome> {
  const loaded = await loadDraftForEdit(tx, actor, input.recordId);
  if (!loaded.ok) return loaded;
  await stockUsageRepo.deleteUsageDraft(tx, input.recordId);
  return { ok: true };
}

/**
 * ⭐ Manager-only (`post_usage`) — posting is the only step that moves stock and hits the P&L
 * (T-168 §3). Builds `usage.ts`'s `PostUsageInput` from the draft's own lines: `inventoryAccount`
 * from `INVENTORY_ACCOUNT_BY_ITEM_KIND[item.kind]`, `cogsCategory` from `cogsCategoryForItemKind`.
 */
export async function postUsage(tx: Tx, actor: Actor, input: { readonly recordId: string }): Promise<PostOutcome> {
  const record = await stockUsageRepo.getUsageRecord(tx, input.recordId);
  if (!record) return { ok: false, reason: `usage record ${input.recordId} does not exist` };
  await authorize(tx, actor, 'post_usage', { storeId: record.storeId });

  if (record.status !== 'draft') {
    return { ok: false, reason: `usage record ${input.recordId} is ${record.status}, not draft` };
  }
  if (record.kind !== 'usage' && record.kind !== 'wastage') {
    // ⛔ `adjustment`/`opening` are storable (T-168 §7.2/§9.7) but their posting path — T-164's
    // `postCountVariance` and T-134's cutover, respectively — is not built in this pass.
    return { ok: false, reason: `posting a "${record.kind}" record is not built yet` };
  }

  const lines = await stockUsageRepo.listUsageLines(tx, input.recordId);
  if (lines.length === 0) {
    return { ok: false, reason: 'a usage record with no lines posts nothing' };
  }

  const usageLines: UsageLineInput[] = [];
  for (const line of lines) {
    const inventoryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind];
    if (!inventoryAccount) {
      return { ok: false, reason: `item kind "${line.itemKind}" has no inventory account in COA-ALIGNMENT §4.1` };
    }
    usageLines.push({
      lineId: line.id,
      itemId: line.itemId,
      cogsCategory: cogsCategoryForItemKind(line.itemKind),
      inventoryAccount,
      quantity: quantity(line.quantity),
    });
  }

  const postInput: PostUsageInput = {
    orgId: record.orgId,
    storeId: record.storeId,
    locationId: record.locationId,
    recordId: record.id,
    kind: record.kind,
    usedOn: record.usedOn,
    postedBy: actor.personId,
    reason: record.kind === 'wastage' && record.reasonCode ? (record.reasonCode as WastageReason) : undefined,
    lines: usageLines,
  };

  const result = await postUsageRecord(tx, postInput);
  if (!result.ok) return result;

  // ⭐ `movementIds` is in line order — `usage.ts`'s own contract — asserted, not assumed: a
  // mismatch here would silently attach the wrong movement to the wrong line.
  if (result.movementIds.length !== lines.length) {
    throw new Error(
      `postUsage: postUsageRecord returned ${result.movementIds.length} movement(s) for ${lines.length} line(s)`,
    );
  }
  for (let i = 0; i < lines.length; i++) {
    await stockUsageRepo.setUsageLineMovement(tx, lines[i]!.id, result.movementIds[i]!);
  }
  await stockUsageRepo.markUsagePosted(tx, record.id, actor.personId);

  return {
    ok: true,
    totalCost: result.totalCost,
    entryIds: result.entryIds,
    storeId: record.storeId,
    itemIds: lines.map((l) => l.itemId),
  };
}

/**
 * ⭐ Manager-only (`void_usage_record`) — same asymmetry as `void_transfer`/`void_expense`.
 *
 * ✅ Reverses stock, the FIFO layers AND the journal entry `postUsage` wrote — DEF-141, fixed in
 * `usage.ts` by the coordinator after this lane reported it (see this file's header). The caller's
 * reason travels through to `VoidUsageInput.reason`, which lands on the reversal entries' memo.
 */
export async function voidUsage(
  tx: Tx,
  actor: Actor,
  input: { readonly recordId: string; readonly reason: string },
): Promise<VoidUsageOutcome> {
  const record = await stockUsageRepo.getUsageRecord(tx, input.recordId);
  if (!record) return { ok: false, reason: `usage record ${input.recordId} does not exist` };
  await authorize(tx, actor, 'void_usage_record', { storeId: record.storeId });

  // T-374 S7 (R10): a record a live POS pull made is voided WITH the pull, so the day can be pulled again.
  // After `authorize`, so a person who may not void learns nothing about the pull. A record of an already-void
  // pull is not linked to a live one, and fails the "not posted" check inside the core as before.
  const livePull = await posMappingRepo.livePullForUsageRecord(tx, input.recordId);
  if (livePull) {
    return {
      ok: false,
      reason: `This usage came from the POS pull for ${humanDate(livePull.businessDate as BusinessDate)}. Void the pull instead, so the day can be pulled again.`,
    };
  }

  return voidPullUsageRecord(tx, {
    recordId: input.recordId,
    reason: input.reason,
    voidedOn: toBusinessDate(),
    voidedBy: actor.personId,
  });
}
