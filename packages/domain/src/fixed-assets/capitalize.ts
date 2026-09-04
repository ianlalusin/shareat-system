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
  journalRepo,
  transaction,
  type AssetCategory,
  type Tx,
} from '@shareat/db';
import { compare, money } from '@shareat/core/money';
import type { DepreciationInterval } from './schedule';
import { readPolicyOrRefuse, resolveUsefulLifeMonths } from './policy';
import { reverseEntry } from '../ledger/reverse-entry';

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
  if (tx) return runCapitalise(tx, actor, expenseId, true);
  return transaction((trx) => runCapitalise(trx, actor, expenseId, true));
}

/**
 * ⭐ The same thing, called as a CONSEQUENCE of approving the expense — and deliberately NOT
 * gated on `manage_fixed_assets`.
 *
 * ⚠️ This distinction is not a convenience, and getting it wrong is a real regression I made and
 * a test caught. `manage_fixed_assets` is admin-only, while `approve_expense` is a MANAGER's
 * capability. Requiring both here would have meant **no manager could ever approve a CAPEX
 * expense again** — `authorize: role 'manager' may not 'manage_fixed_assets'` — which is not a
 * decision anybody made, just a consequence of calling the wrong function.
 *
 * The reasoning that settles it: the person is not "managing fixed assets", they are approving a
 * purchase. The register row is something the SYSTEM must record because the money has already
 * landed in 1510 — not a second, separately-permissioned action the approver is performing. The
 * gate that matters is `approve_expense`, and the caller has already checked it.
 *
 * ⛔ Only `approveExpense` may call this. Any other caller is performing a deliberate act on the
 * register and must go through {@link capitalizeFromExpense}, which authorizes.
 */
export async function capitalizeApprovedExpense(
  tx: Tx,
  actor: Actor,
  expenseId: string,
): Promise<CapitaliseFromExpenseResult> {
  return runCapitalise(tx, actor, expenseId, false);
}

async function runCapitalise(
  tx: Tx,
  actor: Actor,
  expenseId: string,
  checkCapability: boolean,
): Promise<CapitaliseFromExpenseResult> {
  const expense = await expensesRepo.getExpenseById(tx, actor.orgId, expenseId);
  if (!expense) {
    throw new Error(
      `capitalizeFromExpense: expense ${expenseId} does not exist in org ${actor.orgId}`,
    );
  }

  if (checkCapability) {
    await authorize(tx, actor, 'manage_fixed_assets', {});
  }

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

export interface RetireAssetFromVoidedExpenseResult {
  /** `null` when the expense never capitalised an asset — the ordinary case. */
  assetId: string | null;
  /** Posted depreciation entries reversed as a consequence. */
  depreciationEntriesReversed: number;
}

/**
 * DEF-160 — a CAPEX expense that auto-capitalised a `fixed_assets` row must not leave that row
 * standing when the expense is voided, or it keeps depreciating a cost that no longer exists in
 * the ledger.
 *
 * ⛔ **This does NOT post a cost-removal entry, and must never call {@link disposeAsset}.**
 * `disposeAsset` credits `1510` for a real retirement — but this file's own header explains the
 * capitalisation never posted its own entry: the ORIGINAL expense's `Dr 1510` already exists, and
 * `voidExpense`'s `reverseEntry` call already credits it back to zero. A second credit here would
 * double-count and leave `1510` negative by the asset's cost.
 *
 * What this retires is the REGISTER ROW only — reusing the `disposed` status (no new status value
 * exists, and one is not needed: `disposed` already means "off the active register, not subject
 * to further depreciation," which is exactly right here). Any depreciation already posted against
 * the asset is reversed too, since it was computed against a cost that has just been unwound.
 *
 * ⛔ Not separately gated on `manage_fixed_assets`, for the same reason
 * {@link capitalizeApprovedExpense} is not: the caller is not managing fixed assets, they are
 * voiding a purchase, and the register row is a consequence the system must clean up — not a
 * second, separately-permissioned action. Only `voidExpense` may call this.
 */
export async function retireAssetFromVoidedExpense(
  tx: Tx,
  actor: Actor,
  input: { expenseId: string; expenseBusinessDate: string; reason: string },
): Promise<RetireAssetFromVoidedExpenseResult> {
  const asset = await fixedAssetsRepo.findBySourceExpense(tx, actor.orgId, input.expenseId);
  if (!asset || asset.status !== 'active') {
    // No asset, or one already retired/pending for an unrelated reason — nothing for the void
    // to do. Refusing here would block a legitimate expense correction over a register state
    // this action did not cause.
    return { assetId: asset?.id ?? null, depreciationEntriesReversed: 0 };
  }

  const depreciationEntries = await journalRepo.findPostedEntriesBySource(
    tx,
    actor.orgId,
    'depreciation',
    asset.id,
  );
  for (const entry of depreciationEntries) {
    await reverseEntry(tx, {
      entryId: entry.id,
      reason: `Asset retired — originating expense voided: ${input.reason}`,
      reversedBy: actor.personId,
    });
  }

  await fixedAssetsRepo.markDisposed(tx, actor.orgId, asset.id, {
    disposedOn: input.expenseBusinessDate,
    disposalReason: `Retired — the expense that capitalised this asset was voided: ${input.reason}`,
    disposedBy: actor.personId,
  });

  return { assetId: asset.id, depreciationEntriesReversed: depreciationEntries.length };
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
