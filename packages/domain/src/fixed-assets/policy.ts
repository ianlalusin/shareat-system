/**
 * The capitalisation policy — and the one refusal this task exists to port.
 * docs/tasks/124-fixed-assets-and-depreciation.md §8.
 *
 * ## ⛔ ABSENT and UNREADABLE are not the same thing
 *
 * This is the whole point of the file, and v1 learned it the expensive way. Its
 * `readCapitalizationPolicy` originally collapsed both cases into one `return DEFAULTS`, and its
 * own code comment records the cost (`ERP-rebuild/src/lib/actions/expense.actions.ts:57-89`):
 *
 * > *"Live values are life 2 / salvage 100; the defaults are 5 / 0, so a silent fallback
 * > understates depreciation by ~60% on everything capitalized afterwards, and editing the
 * > expense deliberately does not re-price the asset."*
 *
 * The last clause is the sharp end. The wrong terms are not a display bug that a later edit
 * corrects — they are **stamped onto the asset permanently**, and every period it charges for the
 * rest of its life is wrong by that margin, silently.
 *
 *   - **Absent** — no policy row exists. That is a real, knowable state: nobody has set one yet.
 *     Defaulting is right, and the defaults below are the answer.
 *   - **Unreadable** — the read threw. We do **not know** the policy, and guessing writes the
 *     wrong depreciation terms forever. **The posting STOPS.**
 *
 * ⚠️ Do not "simplify" this into a try/catch that returns the defaults. That is precisely the
 * shape v1 had, and the reason this file carries an essay instead of three lines.
 */
import { fixedAssetsRepo, type AssetCategory, type Tx } from '@shareat/db';

/** The default life, in MONTHS, when neither the asset nor its category names one.
 *  Ian, 2026-08-26 (bible row 140): *"default to 24 months, make configurable by months."* */
export const DEFAULT_USEFUL_LIFE_MONTHS = 24;

/**
 * Applied only when NO policy row exists for the org.
 *
 * ⚠️ The threshold is ₱10,000, not v1's ₱5,000 — Ian doubled it on 2026-08-26 (bible row 139).
 * It is a materiality judgement whose cost is physical: every asset over the line is a row
 * somebody walks up to and counts in December.
 */
export const CAPITALISATION_DEFAULTS = {
  threshold: '10000.00',
  salvageValue: '0.00',
} as const;

export interface CapitalisationPolicy {
  threshold: string;
  defaultSalvageValue: string;
  /** True when no row existed and the constants above were used, so a caller (or a screen) can
   *  say so rather than presenting a default as a decision somebody made. */
  isDefault: boolean;
}

export class PolicyUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      'Could not read the capitalisation policy, so this purchase was not recorded — ' +
        'posting it now would capitalise the asset on default terms instead of yours, and those ' +
        'terms are permanent: every period it charges for the rest of its life would be wrong. ' +
        `Try again. (${cause instanceof Error ? cause.message : 'unknown error'})`,
    );
    this.name = 'PolicyUnreadableError';
  }
}

/**
 * The org's policy, defaulting when absent and **refusing when unreadable**.
 *
 * ⭐ The `catch` here re-throws; it never returns. It exists only to replace a bare Postgres
 * error with a message that says what was not recorded and why — because the person who sees it
 * is a manager approving an expense, not an engineer reading a stack trace.
 */
export async function readPolicyOrRefuse(tx: Tx, orgId: string): Promise<CapitalisationPolicy> {
  let row;
  try {
    row = await fixedAssetsRepo.findPolicy(tx, orgId);
  } catch (err) {
    throw new PolicyUnreadableError(err);
  }

  if (!row) {
    return {
      threshold: CAPITALISATION_DEFAULTS.threshold,
      defaultSalvageValue: CAPITALISATION_DEFAULTS.salvageValue,
      isDefault: true,
    };
  }

  return {
    threshold: row.capitalizationThreshold,
    defaultSalvageValue: row.defaultSalvageValue,
    isDefault: false,
  };
}

/**
 * The useful life to stamp on a new asset of this category, in months.
 *
 * Resolution order: the category's configured default, then {@link DEFAULT_USEFUL_LIFE_MONTHS}.
 *
 * ⚠️ **Copied onto the asset at capitalisation, never looked up at depreciation time.** Changing
 * the org's default afterwards must not silently rewrite the schedule of every asset already on
 * the books — a life is a decision made once, about one asset (schema comment, spec §2). The
 * category table is a source of DEFAULTS, not a live lookup.
 */
export async function resolveUsefulLifeMonths(
  tx: Tx,
  orgId: string,
  category: AssetCategory,
): Promise<number> {
  const configured = await fixedAssetsRepo.findCategoryLife(tx, orgId, category);
  return configured ?? DEFAULT_USEFUL_LIFE_MONTHS;
}
