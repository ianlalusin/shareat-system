/**
 * Getting an asset onto the register. docs/tasks/124-fixed-assets-and-depreciation.md §6.
 *
 * Two doors, and they are deliberately different:
 *
 *   - {@link createAsset} — a human adds one, and chooses its terms.
 *   - {@link capitalizeFromExpense} — an approved CAPEX expense over the threshold becomes one
 *     automatically, on default terms, flagged `needsReview`.
 *
 * ## ⛔ Neither of these posts a journal entry
 *
 * That looks like an omission and is not. **T-122 already posts the capitalisation** — a CAPEX
 * expense debits its category's account, and the seeded CAPEX category's account IS 1510
 * (`packages/db/seed/expense-categories.ts`), so `routeExpense` books DR 1510 / CR the funding
 * side with no special-casing at all. Its own comment says so: *"PERSONAL (-> 3200) and CAPEX
 * (-> a 15xx asset) reach this exact same branch."*
 *
 * So the money is already in the ledger before this file runs. What is missing is not an entry
 * but a **register row** — the thing that knows the ₱45,000 sitting in 1510 is a chest freezer
 * with a 24-month life. Posting again here would double the asset.
 *
 * ⚠️ An asset created by {@link createAsset} with no source expense has NOT been capitalised to
 * 1510 by anything. That is a real gap, and it is surfaced rather than papered over — see
 * `fixedAssetsRepo.assetsMissingCapitalisation`, which is T-135's OIL hook.
 */
import { authorize, type Actor } from '@shareat/auth';
import {
  expensesRepo,
  fixedAssetsRepo,
  transaction,
  type AssetCategory,
  type Tx,
} from '@shareat/db';
import { compare, money } from '@shareat/core/money';
import type { DepreciationInterval } from './schedule';
import { readPolicyOrRefuse, resolveUsefulLifeMonths } from './policy';

export interface CreateAssetInput {
  storeId: string;
  name: string;
  category: AssetCategory;
  acquiredOn: string;
  cost: string;
  salvageValue?: string | null;
  /** MONTHS (bible row 140). Omitted falls back to the category default, then 24. */
  usefulLifeMonths?: number | null;
  interval?: DepreciationInterval;
  notes?: string | null;
}

/**
 * A human adds an asset and chooses its terms.
 *
 * `needsReview` is FALSE here — the terms were chosen deliberately by someone who was looking at
 * the thing. The flag means "these are defaults nobody has confirmed", which is only true of the
 * automatic path below.
 */
export async function createAsset(
  tx: Tx | null,
  actor: Actor,
  input: CreateAssetInput,
): Promise<{ id: string }> {
  if (tx) return runCreateAsset(tx, actor, input);
  return transaction((trx) => runCreateAsset(trx, actor, input));
}

async function runCreateAsset(
  tx: Tx,
  actor: Actor,
  input: CreateAssetInput,
): Promise<{ id: string }> {
  await authorize(tx, actor, 'manage_fixed_assets', {});

  const cost = money(input.cost);
  if (compare(cost, money('0')) <= 0) {
    throw new Error('createAsset: cost must be greater than zero.');
  }

  // Read the policy even on the manual path, because the salvage default comes from it — and
  // because an unreadable policy must stop this door too, not only the automatic one.
  const policy = await readPolicyOrRefuse(tx, actor.orgId);
  const salvage = money(input.salvageValue ?? policy.defaultSalvageValue);

  // ⚠️ Checked here as well as by the CHECK constraint. The constraint is the guarantee; this is
  // the message. `salvage >= cost` means the asset depreciates by zero or a negative amount, and
  // every figure downstream is nonsense — a caller deserves to be told which two numbers clash.
  if (compare(salvage, cost) >= 0) {
    throw new Error(
      `createAsset: salvage value ${salvage} must be below cost ${cost}, or the asset never depreciates.`,
    );
  }

  const usefulLifeMonths =
    input.usefulLifeMonths ?? (await resolveUsefulLifeMonths(tx, actor.orgId, input.category));
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1) {
    throw new Error(
      `createAsset: useful life must be a whole number of months greater than zero, got ${usefulLifeMonths}.`,
    );
  }

  return fixedAssetsRepo.insertAsset(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    name: input.name.trim(),
    category: input.category,
    acquiredOn: input.acquiredOn,
    cost: String(cost),
    salvageValue: String(salvage),
    usefulLifeMonths,
    interval: input.interval ?? 'monthly',
    status: 'active',
    needsReview: false,
    notes: input.notes?.trim() || null,
    sourceExpenseId: null,
    createdBy: actor.personId,
  });
}

export interface CapitaliseFromExpenseResult {
  /** `null` when the expense was below the threshold — not an error, just not an asset. */
  assetId: string | null;
  created: boolean;
  reason: 'created' | 'below_threshold' | 'already_capitalised';
}

/**
 * Turn an approved CAPEX expense into a register row, if it clears the threshold.
 *
 * ⭐ **Idempotent on the expense**, not on a key — `findBySourceExpense` is the guard. Approving
 * the same expense twice must not mint a second chest freezer, and unlike a journal entry there
 * is no idempotency index to lean on here, because the register is not the ledger.
 *
 * `needsReview: true` is the important part, and it is v1's idea worth keeping. The terms applied
 * are defaults nobody chose — v1 pairs this flag with a persistent banner and a manager
 * notification, on the reasoning that auto-capitalisation is a guess that must be visibly
 * provisional rather than silently permanent. Only a human editing the terms clears it
 * (spec invariant 5).
 */
export async function capitalizeFromExpense(
  tx: Tx | null,
  actor: Actor,
  expenseId: string,
): Promise<CapitaliseFromExpenseResult> {
  if (tx) return runCapitalise(tx, actor, expenseId);
  return transaction((trx) => runCapitalise(trx, actor, expenseId));
}

async function runCapitalise(
  tx: Tx,
  actor: Actor,
  expenseId: string,
): Promise<CapitaliseFromExpenseResult> {
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw new Error(
      `capitalizeFromExpense: expense ${expenseId} does not exist in org ${actor.orgId}`,
    );
  }

  // Store-scoped read BEFORE authorize, same reasoning as the expenses module: the capability is
  // org-scoped but the store is a property of the expense, not of caller input.
  await authorize(tx, actor, 'manage_fixed_assets', {});

  const existing = await fixedAssetsRepo.findBySourceExpense(tx, actor.orgId, expenseId);
  if (existing) {
    return { assetId: existing.id, created: false, reason: 'already_capitalised' };
  }

  // ⛔ The refusal. If this throws, nothing is written — including, because the caller runs
  // inside the approving transaction, the expense approval itself. v1 refuses the whole expense
  // for exactly this reason: a CAPEX purchase recorded without its asset is a number in 1510
  // that nothing will ever depreciate.
  const policy = await readPolicyOrRefuse(tx, actor.orgId);

  if (compare(money(expense.totalAmount), money(policy.threshold)) < 0) {
    return { assetId: null, created: false, reason: 'below_threshold' };
  }

  const category = await categoryForExpense(tx, actor.orgId, expense.categoryId);
  const usefulLifeMonths = await resolveUsefulLifeMonths(tx, actor.orgId, category);
  const salvage = money(policy.defaultSalvageValue);
  const cost = money(expense.totalAmount);

  // A default salvage at or above the cost would produce an asset that cannot depreciate. Rather
  // than refuse an otherwise-valid purchase over a CONFIG value, drop salvage to zero and flag
  // it — the review flag is already how this path says "somebody look at this".
  const effectiveSalvage = compare(salvage, cost) >= 0 ? money('0') : salvage;

  const { id } = await fixedAssetsRepo.insertAsset(tx, {
    orgId: actor.orgId,
    storeId: expense.storeId,
    name: expense.particulars.trim().slice(0, 200),
    category,
    acquiredOn: expense.businessDate,
    cost: String(cost),
    salvageValue: String(effectiveSalvage),
    usefulLifeMonths,
    interval: 'monthly',
    status: 'active',
    needsReview: true,
    notes: `Auto-capitalised from expense ${expenseId} on default terms (${usefulLifeMonths} months, straight line). Review the terms.`,
    sourceExpenseId: expenseId,
    createdBy: actor.personId,
  });

  return { assetId: id, created: true, reason: 'created' };
}

/**
 * Which asset category an expense's category implies.
 *
 * v1 maps its expense sub-category to an asset category (`assetCategoryFromSubCategory`) so the
 * register does not end up entirely "Equipment". v2 has ONE seeded CAPEX category, so there is
 * nothing to map from yet — everything auto-capitalised lands in `equipment` and the review flag
 * is what gets a human to correct it.
 *
 * ⚠️ Deliberately not invented further. Splitting CAPEX into per-category expense rows is a
 * change to the seeded chart and expense categories, which is bible §4.4 reference data and out
 * of this task's scope — guessing a mapping here would put a fabricated taxonomy in the register.
 */
async function categoryForExpense(
  tx: Tx,
  orgId: string,
  categoryId: string,
): Promise<AssetCategory> {
  const category = await expensesRepo.getCategoryById(tx, orgId, categoryId);
  const name = (category?.category ?? '').toLowerCase();

  if (name.includes('building')) return 'building';
  if (name.includes('vehicle')) return 'vehicles';
  if (name.includes('machin')) return 'machinery';
  if (name.includes('furnitur') || name.includes('fixture')) return 'furniture_and_fixture';
  if (name.includes('applianc')) return 'appliances';
  if (name.includes('smallware')) return 'smallwares';
  return 'equipment';
}
