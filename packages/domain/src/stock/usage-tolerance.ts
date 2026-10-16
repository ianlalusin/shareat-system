/**
 * T-401 S6 - the usage tolerance band (I28) and the store-wide usage draft queue.
 * docs/tasks/401-erp-menu-catalog-master.md "S5 rulings" point 7, and Ian's ruling of 2026-10-14 (bible row 335).
 *
 * The model: staff record ACTUAL usage as drafts, a manager posts them (that is what moves stock), and the POS pull is a CHECK
 * only. The check, per (store, business date, stock item), in the item's base unit:
 *   expected = the sum of that day's plan lines for the item (the live pull's direct and recipe lines, from the source in force),
 *              or 0 when only a menu rule covers the item (a store on menu rules, the item sold nothing today);
 *   actual   = the sum of that day's `usage` records at the store for the item, draft + posted, never void;
 *   inside   iff |actual - expected| <= tolerance x expected, inclusive. Expected 0 with actual > 0, or expected > 0 with actual 0,
 *            is always outside. Tolerance = the item's own override, else the org setting (default 0.10).
 * An item with NO expected source that day (no plan line, no menu rule) is never checked.
 *
 * Money and quantities are never floats (bible section 6): the band is integer arithmetic on BigInt, and the sums come from SQL
 * `numeric` as text.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, itemsRepo, posMappingRepo, productionRepo, stockUsageRepo, type Tx } from '@shareat/db';
import { gone, internalFault, refuse } from '../shared/refusal';
import { humanDate } from '../shared/refusal-leaf';
import { menuRuleCoveredItemIds } from '../pos/depletion-source';
import type { BusinessDate } from '@shareat/core/datetime';
import { decimal, type Decimal } from '@shareat/core/money';
import { addQuantity, quantity } from './quantity';

// -------------------------------------------------------------------------------------------------------------------
// The band (pure)
// -------------------------------------------------------------------------------------------------------------------
const DECIMAL = /^\d+(\.\d+)?$/;

interface Scaled {
  readonly n: bigint;
  readonly scale: number;
}

function scaled(raw: string, what: string): Scaled {
  const s = raw.trim();
  if (!DECIMAL.test(s)) throw internalFault(`usage tolerance: ${what} must be an unsigned decimal string, got ${JSON.stringify(raw)}`);
  const [whole, frac = ''] = s.split('.');
  return { n: BigInt(`${whole}${frac}`), scale: frac.length };
}

/**
 * The band, written once. `expected`, `actual` and `tolerance` are unsigned decimal strings (tolerance a fraction: 0.10 = 10%).
 * Inside iff `|actual - expected| <= tolerance x expected` (relative to EXPECTED, inclusive), exactly, in integers. Both zero is
 * inside (there is nothing to check); expected 0 with actual > 0 and expected > 0 with actual 0 are outside at ANY tolerance.
 */
export function isWithinUsageTolerance(expected: string, actual: string, tolerance: string): boolean {
  const e0 = scaled(expected, 'expected');
  const a0 = scaled(actual, 'actual');
  const t0 = scaled(tolerance, 'tolerance');
  const scale = Math.max(e0.scale, a0.scale, t0.scale);
  const up = (x: Scaled): bigint => x.n * 10n ** BigInt(scale - x.scale);
  const e = up(e0);
  const a = up(a0);
  const t = up(t0);
  if (e === 0n) return a === 0n;
  if (a === 0n) return false;
  const diff = a > e ? a - e : e - a;
  return diff * 10n ** BigInt(scale) <= t * e;
}

/** A stored `numeric` for display: no trailing zeros ('10.000' -> '10', '0.500' -> '0.5'). */
function plain(q: string): string {
  if (!q.includes('.')) return q;
  return q.replace(/0+$/, '').replace(/\.$/, '');
}

/** '0.1000' -> '10%', '0.0250' -> '2.5%'. */
function percentWords(tolerance: string): string {
  const t = scaled(tolerance, 'tolerance');
  const hundred = t.n * 100n;
  const digits = hundred.toString().padStart(t.scale + 1, '0');
  const whole = t.scale === 0 ? digits : digits.slice(0, digits.length - t.scale);
  const frac = t.scale === 0 ? '' : digits.slice(digits.length - t.scale).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

/** A tolerance a person typed, as the stored text, or a refusal in words: a fraction from 0 to 1 with at most four decimals. */
function parseTolerance(raw: unknown, rawLabel: string): Decimal<'5,4'> {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const sentence = 'A tolerance is a number from 0 to 1 with at most four decimals, for example 0.10 for 10%.';
  if (!DECIMAL.test(s)) throw refuse(`${rawLabel}: ${JSON.stringify(raw)} is not a decimal fraction.`, sentence);
  const frac = s.split('.')[1] ?? '';
  if (frac.length > 4) throw refuse(`${rawLabel}: more than four decimals.`, sentence);
  const t = scaled(s, rawLabel);
  if (t.n > 10n ** BigInt(t.scale)) throw refuse(`${rawLabel}: above 1.`, sentence);
  return decimal(s, '5,4');
}

// -------------------------------------------------------------------------------------------------------------------
// The settings (admin only)
// -------------------------------------------------------------------------------------------------------------------
async function audit(tx: Tx, actor: Actor, action: string, storeId: string | null, entityId: string, before: unknown, after: unknown): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, { actorPersonId: actor.personId, action, storeId, entityId, before, after, source: 'web' });
}

/** Sets the org-wide usage tolerance. Admin only (`set_menu_depletion`). Audited as `menu.usage_tolerance_set`. */
export async function setOrgUsageTolerance(tx: Tx, actor: Actor, input: { readonly tolerance: string }): Promise<{ tolerance: string }> {
  await authorize(tx, actor, 'set_menu_depletion', {});
  const tolerance = parseTolerance(input.tolerance, 'setOrgUsageTolerance');
  const before = await stockUsageRepo.setOrgUsageTolerance(tx, actor.orgId, tolerance);
  if (!before) throw gone(`setOrgUsageTolerance: organization ${actor.orgId} does not exist.`, 'organization');
  await audit(tx, actor, 'menu.usage_tolerance_set', null, actor.orgId, { tolerance: before.previous }, { tolerance });
  return { tolerance };
}

/** Sets one item's tolerance override, or clears it with `null` (the org setting applies again). Admin only. Audited as `menu.item_usage_tolerance_set`. */
export async function setItemUsageTolerance(
  tx: Tx,
  actor: Actor,
  input: { readonly itemId: string; readonly tolerance: string | null },
): Promise<{ tolerance: string | null }> {
  await authorize(tx, actor, 'set_menu_depletion', {});
  const tolerance = input.tolerance === null ? null : parseTolerance(input.tolerance, 'setItemUsageTolerance');
  const before = await stockUsageRepo.setItemUsageTolerance(tx, actor.orgId, input.itemId, tolerance);
  if (!before) throw gone(`setItemUsageTolerance: item ${input.itemId} does not exist.`, 'stock item');
  await audit(tx, actor, 'menu.item_usage_tolerance_set', null, input.itemId, { tolerance: before.previous }, { tolerance });
  return { tolerance };
}

// -------------------------------------------------------------------------------------------------------------------
// The comparison
// -------------------------------------------------------------------------------------------------------------------
export interface UsageVariance {
  readonly itemId: string;
  readonly itemName: string;
  /** Item base units, a decimal string ('0' when only a menu rule covers the item). */
  readonly expected: string;
  readonly actual: string;
  /**
   * T-420: what POSTED recipe cooking already took out of this item that day ('0' when none, else 3 dp: '0.500'). `actual` stays what
   * staff recorded; the verdict judges `actual + cooked` against `expected`. A missing value (an old mock) reads as none.
   */
  readonly cooked: string;
  /** The tolerance in force for this item, as stored ('0.1000'). */
  readonly tolerance: string;
  readonly withinBand: boolean;
}

/**
 * Every COVERED item of one (store, day) with its expected, actual and verdict. Covered = a plan line of the day's live pull, or (a
 * store on menu rules only) a menu rule. `onlyItemIds` narrows the work to those items.
 */
export async function usageVariancesFor(
  tx: Tx,
  orgId: string,
  storeId: string,
  businessDate: string,
  onlyItemIds?: readonly string[],
): Promise<UsageVariance[]> {
  const planned = await stockUsageRepo.expectedFromPullForDay(tx, storeId, businessDate);
  const covered = new Set<string>(planned.keys());
  for (const id of await menuRuleCoveredItemIds(tx, orgId, storeId)) covered.add(id);
  const wanted = onlyItemIds ? new Set(onlyItemIds) : null;
  const ids = [...covered].filter((id) => !wanted || wanted.has(id));
  if (ids.length === 0) return [];

  const actuals = await stockUsageRepo.usageActualsForDay(tx, storeId, businessDate);
  const cooks = await productionRepo.cookedByItemForDay(tx, orgId, storeId, businessDate, { itemIds: ids, skipSnapshotRooms: true });
  const tolerances = await stockUsageRepo.usageTolerancesFor(tx, orgId, ids);
  const out: UsageVariance[] = [];
  for (const itemId of ids) {
    const expected = planned.get(itemId) ?? '0';
    const actual = actuals.get(itemId) ?? '0';
    const cooked = cooks.get(itemId) ?? '0';
    const tolerance = tolerances.byItem.get(itemId) ?? tolerances.org;
    const item = await itemsRepo.getItemById(tx, orgId, itemId);
    out.push({
      itemId,
      itemName: item?.name ?? 'an item',
      expected,
      actual,
      cooked,
      tolerance,
      withinBand: isWithinUsageTolerance(expected, addQuantity(quantity(actual), quantity(cooked)), tolerance),
    });
  }
  return out.sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemId.localeCompare(b.itemId));
}

/** The day's variances for a store, one row per covered item. Anyone who may record usage at the store may read it. */
export async function listUsageVariances(
  tx: Tx,
  actor: Actor,
  input: { readonly storeId: string; readonly date: string },
): Promise<UsageVariance[]> {
  await authorize(tx, actor, 'record_stock_movement', { storeId: input.storeId });
  return usageVariancesFor(tx, actor.orgId, input.storeId, input.date);
}

/** The store's usage drafts, from every author, each naming who recorded it. Anyone who may record usage at the store may read it. */
export async function listStoreUsageQueue(tx: Tx, actor: Actor, storeId: string): Promise<stockUsageRepo.StoreUsageQueueRow[]> {
  await authorize(tx, actor, 'record_stock_movement', { storeId });
  return stockUsageRepo.listStoreUsageQueue(tx, storeId);
}

// -------------------------------------------------------------------------------------------------------------------
// The post gate (called by `postUsage`)
// -------------------------------------------------------------------------------------------------------------------
export interface ToleranceGate {
  /** Refusal sentence when an item is out of band and no reason was given; otherwise null. */
  readonly refusal: string | null;
  /** The items out of band that a reason will cover: one audit row each, written after the post. */
  readonly verified: readonly UsageVariance[];
}

/**
 * ⭐ T-401 S6 audit rulings A3/A4. For a usage record a POS pull made, every item the pull covered is judged against the record's OWN
 * snapshot of what was expected of it (`pos_usage_pull_lines.draft_expected_qty`, summed per item), never against a live
 * recomputation and never against other records' quantities: `actual` is what THIS record holds of the item. An item whose line staff
 * deleted still counts (actual 0 against its snapshot): "covered" survives the deletion. `lines` are the record's current lines.
 */
export async function snapshotVariancesFor(
  tx: Tx,
  orgId: string,
  record: { readonly id: string; readonly storeId: string; readonly usedOn: string; readonly locationId: string },
  lines: readonly { readonly itemId: string; readonly quantity: string }[],
): Promise<UsageVariance[]> {
  const snapshot = await posMappingRepo.draftExpectedByItem(tx, record.id);
  if (snapshot.size === 0) return [];
  const own = new Map<string, string>();
  for (const l of lines) own.set(l.itemId, addQuantity(quantity(own.get(l.itemId) ?? '0'), quantity(l.quantity)));
  const ids = [...snapshot.keys()];
  const tolerances = await stockUsageRepo.usageTolerancesFor(tx, orgId, ids);
  // T-420 C3: only cooks in THIS record's own room, so one cook is credited to at most one pull draft (a pull writes one draft per room).
  const cooks = await productionRepo.cookedByItemForDay(tx, orgId, record.storeId, record.usedOn, { locationId: record.locationId, itemIds: ids });
  const out: UsageVariance[] = [];
  for (const itemId of ids) {
    const expected = snapshot.get(itemId)!;
    const actual = own.get(itemId) ?? '0';
    const cooked = cooks.get(itemId) ?? '0';
    const tolerance = tolerances.byItem.get(itemId) ?? tolerances.org;
    const item = await itemsRepo.getItemById(tx, orgId, itemId);
    out.push({
      itemId,
      itemName: item?.name ?? 'an item',
      expected,
      actual,
      cooked,
      tolerance,
      withinBand: isWithinUsageTolerance(expected, addQuantity(quantity(actual), quantity(cooked)), tolerance),
    });
  }
  return out.sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemId.localeCompare(b.itemId));
}

/**
 * For a usage draft about to post. Items the pull covered IN THIS RECORD are judged against the record's own snapshot (`snapshotVariancesFor`);
 * every other item of the draft (a manual draft, or an extra line staff added) is judged as before, the day's total against the plan
 * (`usageVariancesFor`). With no non-blank `reason` an out-of-band item refuses the post; with one it passes and `verified` names them.
 */
export async function checkUsageTolerance(
  tx: Tx,
  record: { readonly id: string; readonly orgId: string; readonly storeId: string; readonly usedOn: string; readonly locationId: string },
  itemIds: readonly string[],
  reason: string | undefined,
): Promise<ToleranceGate> {
  const lines = await stockUsageRepo.listUsageLines(tx, record.id);
  const own = await snapshotVariancesFor(tx, record.orgId, record, lines);
  const snapshotIds = new Set(own.map((v) => v.itemId));
  const live = await usageVariancesFor(tx, record.orgId, record.storeId, record.usedOn, itemIds.filter((id) => !snapshotIds.has(id)));
  const outside = [...own, ...live].filter((v) => !v.withinBand);
  if (outside.length === 0) return { refusal: null, verified: [] };
  if (reason !== undefined && reason.trim() !== '') return { refusal: null, verified: outside };
  const day = humanDate(record.usedOn as BusinessDate);
  const sentences = outside.map(
    (v) => {
      const cooking = v.cooked !== undefined && v.cooked !== '0' && plain(v.cooked) !== '0' ? ` + ${plain(v.cooked)} used in cooking` : '';
      return `${v.itemName}: ${plain(v.actual)} recorded${cooking} against ${plain(v.expected)} expected for ${day} (more than ${percentWords(v.tolerance)} apart)`;
    },
  );
  return {
    refusal: `${sentences.join('; ')}. A manager who has checked the count can post it with a reason.`,
    verified: [],
  };
}

/** After the post succeeded: one `stock.usage_tolerance_verified` row per out-of-band item, as the manager's act. */
export async function writeToleranceVerified(
  tx: Tx,
  actor: Actor,
  record: { readonly id: string; readonly storeId: string; readonly usedOn: string },
  verified: readonly UsageVariance[],
  reason: string,
): Promise<void> {
  for (const v of verified) {
    await audit(tx, actor, 'stock.usage_tolerance_verified', record.storeId, record.id, null, {
      itemId: v.itemId,
      businessDate: record.usedOn,
      expected: v.expected,
      actual: v.actual,
      tolerance: v.tolerance,
      reason: reason.trim(),
    });
  }
}
