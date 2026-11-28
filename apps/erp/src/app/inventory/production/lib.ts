/**
 * Server-only reads for the production screen — T-176.
 *
 * Every rule lives in `packages/domain/src/production`; this file only reads.
 */
import { itemsRepo, productionRepo, stockUsageRepo } from '@shareat/db';
import { cookLabourFor, sliceLabourView } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { quantity } from '@shareat/domain';
import { peso } from '../../../lib/format';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption };

export interface ProductionItemOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly baseUnit: string;
}

export interface ProductionScreenData {
  readonly locations: { id: string; code: string; name: string }[];
  readonly items: ProductionItemOption[];
  /** T-383 S2b: INPUT options only: also a retired item that still has stock here, labelled "(retired)". */
  readonly inputItems: ProductionItemOption[];
  readonly recipes: Awaited<ReturnType<typeof productionRepo.listRecipes>>;
  readonly records: Awaited<ReturnType<typeof productionRepo.listProductionRecords>>;
  /** T-635: the people who hold the Slicer position at this store today, for the "who sliced" picker. */
  readonly slicers: { personId: string; personName: string }[];
}

/** "Labour: ₱84.00 from the slicer rate, 12 kg × ₱7.00" - or why it is 0, or that it was typed. */
export function sliceLabourSentence(stored: string, status: string, auto: Awaited<ReturnType<typeof sliceLabourView>> | null): string {
  const isZero = /^0+([.]0+)?$/.test(stored);
  // Audit fix: the per-kg pay rate is payroll data. Without run_payroll the sentence names the source and the total, never the rate.
  const how = (a: Extract<NonNullable<typeof auto>, { ok: true }>) => (a.ratesHidden ? '' : ` (${a.kg} kg${a.rate === null ? ' at the slicer rates' : ` × ${peso(a.rate)}`})`);
  const fromRate = (a: Extract<NonNullable<typeof auto>, { ok: true }>) => (a.ratesHidden ? ' (from the slicer rate)' : ` from the slicer rate, ${a.kg} kg${a.rate === null ? ' at the slicer rates' : ` × ${peso(a.rate)}`}`);
  // No slicer is named on the record: payroll would never pay it, so no labour is added (the same condition payroll pays on).
  if (auto === null) return isZero ? 'No slicer named: labour not added.' : `Labour: ${peso(stored)} as typed`;
  if (auto.ok && stored === auto.pay) return `Labour: ${peso(stored)}${fromRate(auto)}`;
  if (isZero && auto.ok) return status === 'draft' ? `Labour: ₱0.00. The slicer rate would give ${peso(auto.pay)}${how(auto)}: leave the box blank when you record it to use that.` : 'Labour: ₱0.00';
  if (isZero) return `Labour: ₱0.00. ${auto.ok ? '' : auto.reason}`;
  return `Labour: ${peso(stored)} as typed`;
}

/** Everything the register + "New record" form needs, in one org-scoped transaction. */
export async function productionScreenData(orgId: string, storeId: string): Promise<ProductionScreenData> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [locations, itemRows, usableRows, allRecipes, records, slicers, limited] = await Promise.all([
      stockUsageRepo.listOperatingLocations(tx, storeId),
      itemsRepo.listItems(tx, orgId, { includeInactive: false, stockedOnly: true }),
      itemsRepo.listUsableItems(tx, orgId, storeId),
      productionRepo.listRecipes(tx, orgId),
      productionRepo.listProductionRecords(tx, storeId),
      productionRepo.listSlicersAtStore(tx, orgId, storeId),
      productionRepo.recipeStoreMap(tx, orgId),
    ]);
    // T-650 S2: a recipe limited to some stores is not offered at the others (a recipe with no list is offered everywhere).
    const recipes = allRecipes.filter((r) => !limited.has(r.id) || limited.get(r.id)!.includes(storeId));
    return {
      locations,
      items: itemRows.map((i) => ({ id: i.id, code: i.code, name: i.name, kind: i.kind, baseUnit: i.baseUnit })),
      inputItems: usableRows.map((i) => ({
        id: i.id,
        code: i.code,
        name: i.status === 'inactive' ? `${i.name} (retired)` : i.name,
        kind: i.kind,
        baseUnit: i.baseUnit,
      })),
      recipes,
      records,
      slicers,
    };
  });
}

export interface ProductionLineView {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unit: string;
  readonly movementId: string | null;
  readonly revision: number;
  readonly reversedAt: Date | null;
  /** T-635: an output line the slicer is paid for. */
  readonly isPaid: boolean;
}

export interface ProductionRecordDetail {
  readonly record: NonNullable<Awaited<ReturnType<typeof productionRepo.getProductionRecord>>>;
  readonly locationName: string;
  readonly lines: ProductionLineView[];
  /** T-635 */
  readonly slicerName: string | null;
  readonly confirmedByName: string | null;
  readonly slicers: { personId: string; personName: string }[];
  /** T-650 S1: one sentence on where a slice record's labour figure comes from (null for a cook / convert). */
  readonly labourNote: string | null;
}

export async function productionRecordDetail(actor: Actor, id: string): Promise<ProductionRecordDetail | null> {
  const orgId = actor.orgId;
  return withOrgPrincipal(orgId, async (tx) => {
    const record = await productionRepo.getProductionRecord(tx, id);
    if (!record || record.orgId !== orgId) return null;

    const [rows, itemRows, locationName, names, slicers] = await Promise.all([
      productionRepo.listProductionRecordLines(tx, id),
      itemsRepo.listItems(tx, orgId, { includeInactive: true, stockedOnly: true }),
      stockUsageRepo.locationName(tx, record.locationId),
      productionRepo.personNames(tx, orgId, [record.performedByPersonId, record.confirmedByPersonId].filter((x): x is string => !!x)),
      record.kind === 'slice' && record.status === 'draft' ? productionRepo.listSlicersAtStore(tx, orgId, record.storeId) : Promise.resolve([]),
    ]);
    const itemsById = new Map(itemRows.map((i) => [i.id, i]));
    const lines: ProductionLineView[] = rows.map((r) => {
      const item = itemsById.get(r.itemId);
      return {
        id: r.id,
        direction: r.direction,
        itemId: r.itemId,
        itemCode: item?.code ?? r.itemId,
        itemName: item?.name ?? '(unknown item)',
        quantity: r.quantity,
        unit: r.unit,
        movementId: r.movementId,
        revision: r.revision,
        reversedAt: r.reversedAt,
        isPaid: r.isPaid,
      };
    });

    const outputsForLabour = rows.filter((r) => r.direction === 'in' && r.reversedAt === null && r.revision === record.revision);
    // T-650 S2: a cook's labour, when it came from the recipe's standard per batch.
    let cookNote: string | null = null;
    if (record.kind === 'cook' && record.status !== 'void' && record.recipeId) {
      const recipe = await productionRepo.getRecipe(tx, orgId, record.recipeId);
      const made = outputsForLabour[0];
      if (recipe?.standardLabourCost && made) {
        const std = cookLabourFor(recipe.standardLabourCost, recipe.outputQuantity, quantity(made.quantity));
        if (std && record.labourCost === std.pay) cookNote = `Labour: ${peso(std.pay)} from the recipe (${std.batches} ${std.batches === '1' ? 'batch' : 'batches'} × ${peso(recipe.standardLabourCost)})`;
      }
    }
    const labourNote =
      cookNote ??
      (record.kind === 'slice' && record.status !== 'void'
        ? sliceLabourSentence(
            record.labourCost,
            record.status,
            record.performedByPersonId === null
              ? null
              : await sliceLabourView(tx, actor, record.storeId, record.producedOn, outputsForLabour.map((r) => ({ itemId: r.itemId, itemName: itemsById.get(r.itemId)?.name ?? 'This item', quantity: r.quantity, unit: r.unit, isPaid: r.isPaid }))),
          )
        : null);
    return {
      record,
      labourNote,
      locationName,
      lines,
      slicerName: record.performedByPersonId ? (names.get(record.performedByPersonId) ?? null) : null,
      confirmedByName: record.confirmedByPersonId ? (names.get(record.confirmedByPersonId) ?? null) : null,
      slicers,
    };
  });
}
