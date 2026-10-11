/**
 * Server-only helpers for the cutover screens. T-134.
 *
 * ⭐ Everything here is DERIVED on every read. There is no "wizard state" beyond the recorded
 * completions — the progress you see is the ledger's own answer, asked again.
 */
import { sql as dsql } from 'drizzle-orm';
import { cutoverRepo, itemsRepo } from '@shareat/db';
import { countedStockValue, cutoverProgress, openingGaps, type CutoverProgress, type OpeningGaps } from '@shareat/domain';
import type { OpeningDraft } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

/** The conversion date the double-counting guard measures "pre-cutover" against. */
export const CONVERSION_DATE = '2027-01-01';

export async function loadProgress(orgId: string, storeIds: string[]): Promise<CutoverProgress> {
  return withOrgPrincipal(orgId, (tx) => cutoverProgress(tx, orgId, storeIds));
}

export async function loadGaps(orgId: string): Promise<OpeningGaps> {
  return withOrgPrincipal(orgId, (tx) => openingGaps(tx, orgId, CONVERSION_DATE));
}

export interface CountRow {
  itemId: string;
  name: string;
  baseUnit: string;
  quantity: string | null;
  unitCost: string | null;
}

/**
 * Every active item at this store, with its count if one exists.
 *
 * ⭐ Items WITHOUT a count come back with `quantity: null` — and that is the whole point of the
 * screen. An item silently absent and an item counted as zero must not look the same, so the
 * blank is rendered as a blank and a zero is rendered as a zero.
 */
export async function loadCountSheet(orgId: string, storeId: string): Promise<CountRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const items = await itemsRepo.listItems(tx, orgId);
    // One query for the whole sheet, not a lookup per row.
    const counted = await tx.execute(dsql`
      select item_id, sum(quantity)::text as quantity, max(unit_cost)::text as unit_cost
      from opening_counts where org_id = ${orgId} and store_id = ${storeId}
      group by item_id
    `);
    const byItem = new Map(
      (counted as unknown as Record<string, string>[]).map((r) => [
        String(r.item_id),
        { quantity: r.quantity, unitCost: r.unit_cost },
      ]),
    );
    return items.map((i) => {
      const c = byItem.get(i.id);
      return {
        itemId: i.id,
        name: i.name,
        baseUnit: i.baseUnit,
        quantity: c?.quantity ?? null,
        unitCost: c?.unitCost ?? null,
      };
    });
  });
}

export async function countedValueFor(orgId: string, storeId: string): Promise<string> {
  return withOrgPrincipal(orgId, (tx) => countedStockValue(tx, orgId, storeId));
}

export const PHASE_TITLE: Record<string, string> = {
  A: 'Phase A — in the old system, during December',
  B: 'Phase B — the physical work, 31 December',
  C: 'Phase C — the switch, 1 January',
};

const KIND_LABEL: Record<string, string> = {
  verified: 'Checked automatically',
  attested: 'Stated by a person',
  performed: 'Run by the wizard',
};

/**
 * ⚠️ What the step actually is HERE, which is not always what it was declared.
 *
 * A1 and A2 are declared `verified`, and this database cannot verify them — the check is over v1
 * data v2 never holds. Rendering "Checked automatically · not machine-verifiable" side by side, as
 * the first cut did, is a contradiction a reader has to untangle. It says the true thing instead.
 */
export function kindLabel(kind: string, cannotVerifyHere?: string): string {
  if (kind === 'verified' && cannotVerifyHere) return 'Stated by a person';
  return KIND_LABEL[kind] ?? kind;
}

export async function loadOpeningDrafts(orgId: string): Promise<OpeningDraft[]> {
  return withOrgPrincipal(orgId, (tx) => cutoverRepo.openingDrafts(tx, orgId));
}

export interface PostableAccount {
  code: string;
  name: string;
  requiresParty: boolean;
}

/**
 * The accounts an opening figure can be entered against.
 *
 * ⛔ `3900` is excluded at the source, not just hidden: it is the other half of every figure, and
 * offering it in a dropdown is offering somebody a way to plug the difference to zero.
 */
export async function loadPostableAccounts(orgId: string): Promise<PostableAccount[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await tx.execute(dsql`
      select code, name, requires_party
      from accounts
      where org_id = ${orgId} and is_postable = true and status = 'active' and code <> '3900'
      order by code
    `);
    return (rows as unknown as Record<string, unknown>[]).map((r) => ({
      code: String(r.code),
      name: String(r.name),
      requiresParty: Boolean(r.requires_party),
    }));
  });
}
