/**
 * T-524 R6 - per-line discounts (bible rows 439, 440). docs/tasks/524-pos-v2-domain.md.
 *
 * Any cashier may add or remove one, no PIN (row 440); every one is audited. A discount covers `qty` units of ONE line, oldest first, and the active
 * discounts of a line never cover more units than it has (a bundle line has its heads): that single pool is also why a unit covered by senior/PWD
 * carries no other discount, and the reverse (row 439). The arithmetic is `priceSession`'s, never here.
 */
import { isZero, money, toCentavos } from '@shareat/core/money';
import { authorize, type Actor } from '@shareat/auth';
import { posV2Repo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { parseDecimalInput } from '../shared/money-input';
import { lockOpenSession } from './order';
import {
  audit,
  billedHeads,
  businessDateAndRules,
  capacityOf,
  coveredOf,
  deviceTime,
  loadLiveLines,
  percentText,
  recordedDifferently,
  requireContext,
  uuidInput,
  uuidv5,
  wholeNumber,
  type LoadedLine,
  type PosDeps,
} from './shared';

export interface AddLineDiscountInput {
  storeId: string;
  pairingId: string | null;
  discountId: string;
  lineId: string;
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  presetId?: string;
  valueType?: 'percent' | 'fixed';
  value?: string;
  qty: number;
  dinerNo?: number;
  appliedAtDevice: string | Date;
}

const freeSentence = (name: string, free: number): string =>
  free <= 0 ? `No unit of ${name} is free of discount.` : `Only ${free} ${free === 1 ? 'unit' : 'units'} of ${name} ${free === 1 ? 'is' : 'are'} free of discount.`;

/** The value a discount of this kind stores: a preset's own, a statutory rate (read through the injected reader), or the custom input within its limits. */
async function resolveValue(
  at: Date,
  tx: Tx,
  actor: Actor,
  input: AddLineDiscountInput,
  line: LoadedLine,
  deps: PosDeps | undefined,
): Promise<{ valueType: 'percent' | 'fixed'; value: string; presetId: string | null }> {
  if (input.kind === 'preset') {
    const preset = input.presetId ? await posV2Repo.getPreset(tx, actor.orgId, input.storeId, uuidInput(input.presetId, 'The discount')) : undefined;
    if (!preset || preset.status !== 'active') throw refuse('pos: preset not available', 'That discount is not available at this store.');
    return { valueType: preset.valueType, value: preset.value, presetId: preset.id };
  }
  if (input.kind === 'senior' || input.kind === 'pwd') {
    // The row keeps the statutory rate it was priced at (T-523 R13); the rate is a business rule, read, never typed.
    const { rules } = await businessDateAndRules(tx, actor.orgId, input.storeId, deps, at);
    return { valueType: 'percent', value: percentText(rules.scPwdPercentBasisPoints), presetId: null };
  }
  if (input.valueType !== 'percent' && input.valueType !== 'fixed') throw refuse('pos: custom discount type', 'Choose a percent or a peso amount.');
  const value = parseDecimalInput(String(input.value ?? ''), '14,2', 'pos: the discount value', 'The discount');
  const cents = toCentavos(money(value));
  const limit = input.valueType === 'percent' ? 10000n : toCentavos(money(line.unitPrice));
  if (cents <= 0n || cents > limit) {
    throw refuse('pos: custom discount out of range', input.valueType === 'percent' ? 'A percent discount is more than 0 and at most 100.' : 'A peso discount is more than 0 and at most the item price.');
  }
  return { valueType: input.valueType, value, presetId: null };
}

export async function addLineDiscount(tx: Tx, actor: Actor, input: AddLineDiscountInput, deps?: PosDeps): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const discountId = uuidInput(input.discountId, 'The discount id');
  const qty = wholeNumber(input.qty, { what: 'The number of units', min: 1, max: 999 });
  const at = deviceTime(input.appliedAtDevice, 'The time of the discount');
  if (!['senior', 'pwd', 'preset', 'custom'].includes(input.kind)) throw refuse('pos: bad discount kind', 'Choose a discount.');
  const statutory = input.kind === 'senior' || input.kind === 'pwd';
  const dinerNo = statutory ? wholeNumber(input.dinerNo, { what: 'The diner number', min: 1, max: 200 }) : null;

  const lineRow = await posV2Repo.getLine(tx, actor.orgId, input.storeId, uuidInput(input.lineId, 'The line id'));
  if (!lineRow) throw gone('pos: line not found', 'line');
  const prior = await posV2Repo.getLineDiscount(tx, actor.orgId, input.storeId, discountId);
  if (prior) {
    const sameValue =
      input.kind === 'preset'
        ? prior.presetId === (input.presetId ?? null)
        : input.kind !== 'custom' ||
          (prior.valueType === input.valueType &&
            toCentavos(money(prior.value)) === toCentavos(money(parseDecimalInput(String(input.value ?? ''), '14,2', 'pos: the discount value', 'The discount'))));
    if (prior.sessionLineId === lineRow.id && prior.kind === input.kind && prior.qty === qty && (prior.dinerNo ?? null) === dinerNo && sameValue) return { wrote: false };
    throw recordedDifferently();
  }
  const session = await lockOpenSession(tx, actor.orgId, input.storeId, lineRow.sessionId);

  const live = await loadLiveLines(tx, actor.orgId, input.storeId, session.id);
  const line = live.find((l) => l.id === lineRow.id);
  if (!line) throw refuse('pos: line cancelled', 'That line was cancelled.');
  if (isZero(money(line.unitPrice))) throw refuse('pos: free line', 'A free item takes no discount.');
  const free = capacityOf(line.qty, line.bundleHeads) - coveredOf(line.discounts.map((d) => d.qty));
  if (qty > free) throw refuse('pos: over coverage', freeSentence(line.name, free));

  if (statutory) {
    const all = live.flatMap((l) => l.discounts.map((d) => ({ ...d, lineKind: l.kind })));
    const sameDiner = all.filter((d) => (d.kind === 'senior' || d.kind === 'pwd') && d.dinerNo === dinerNo);
    if (sameDiner.some((d) => d.kind !== input.kind)) throw refuse('pos: diner has another card kind', `Diner ${dinerNo} already has a ${sameDiner[0]!.kind === 'pwd' ? 'PWD' : 'senior'} discount: one card per diner.`);
    if (line.kind === 'package') {
      // Ruling 10: one senior/PWD unit per diner on the package, and never more of them than the billed heads.
      if (qty !== 1 || sameDiner.some((d) => d.lineKind === 'package')) throw refuse('pos: one package head per diner', `Diner ${dinerNo} already has their own package head discounted.`);
      const onPackage = all.filter((d) => (d.kind === 'senior' || d.kind === 'pwd') && d.lineKind === 'package').reduce((a, d) => a + d.qty, 0);
      if (onPackage + qty > billedHeads(session.headsCashier, session.headsServer)) throw refuse('pos: more seniors than heads', 'There are more senior or PWD discounts than guests at this table.');
    }
  }
  const v = await resolveValue(at, tx, actor, input, line, deps);
  await posV2Repo.insertLineDiscounts(tx, [
    { id: discountId, orgId: actor.orgId, storeId: input.storeId, sessionLineId: line.id, kind: input.kind, presetId: v.presetId, valueType: v.valueType, value: money(v.value), qty, dinerNo, appliedBy: actor.personId, appliedAtDevice: at },
  ]);
  await audit(tx, actor, 'pos.discount_added', {
    storeId: input.storeId, entityId: discountId, pairingId, at,
    after: { lineId: line.id, kind: input.kind, qty, valueType: v.valueType, value: v.value, dinerNo, presetId: v.presetId },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

export async function removeLineDiscount(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; pairingId: string | null; discountId: string; removedAtDevice: string | Date },
): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const at = deviceTime(input.removedAtDevice, 'The time of the removal');
  const d = await posV2Repo.getLineDiscount(tx, actor.orgId, input.storeId, uuidInput(input.discountId, 'The discount id'));
  if (!d) throw gone('pos: discount not found', 'discount');
  if (d.status === 'removed') return { wrote: false };
  const line = await posV2Repo.getLine(tx, actor.orgId, input.storeId, d.sessionLineId);
  await lockOpenSession(tx, actor.orgId, input.storeId, line!.sessionId);
  await posV2Repo.removeLineDiscounts(tx, actor.orgId, input.storeId, [d.id], actor.personId, at);
  await audit(tx, actor, 'pos.discount_removed', {
    storeId: input.storeId, entityId: d.id, pairingId, at,
    before: { lineId: d.sessionLineId, kind: d.kind, qty: d.qty, dinerNo: d.dinerNo },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

/**
 * R6 "apply to all lines" (row 440): one discount per line covering every unit not already covered; a line with no free unit (or a free item) is
 * skipped and counted. Each discount's id is derived from the device's `applyId` and the line id (ruling 6), so a replay makes the same ids.
 */
export async function applyPresetToAllLines(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; pairingId: string | null; sessionId: string; presetId: string; applyId: string; appliedAtDevice: string | Date },
): Promise<{ wrote: boolean; applied: number; skipped: number }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const applyId = uuidInput(input.applyId, 'The apply id');
  const at = deviceTime(input.appliedAtDevice, 'The time of the discount');
  const preset = await posV2Repo.getPreset(tx, actor.orgId, input.storeId, uuidInput(input.presetId, 'The discount'));
  if (!preset || preset.status !== 'active') throw refuse('pos: preset not available', 'That discount is not available at this store.');
  const session = await lockOpenSession(tx, actor.orgId, input.storeId, uuidInput(input.sessionId, 'The table id'));
  const live = await loadLiveLines(tx, actor.orgId, input.storeId, session.id);
  const rows: posV2Repo.NewLineDiscount[] = [];
  let applied = 0;
  let skipped = 0;
  for (const l of live) {
    const id = uuidv5(l.id, applyId);
    if (await posV2Repo.getLineDiscount(tx, actor.orgId, input.storeId, id)) {
      applied++; // this very apply, replayed
      continue;
    }
    const free = capacityOf(l.qty, l.bundleHeads) - coveredOf(l.discounts.map((d) => d.qty));
    if (free <= 0 || isZero(money(l.unitPrice))) {
      skipped++;
      continue;
    }
    applied++;
    rows.push({ id, orgId: actor.orgId, storeId: input.storeId, sessionLineId: l.id, kind: 'preset', presetId: preset.id, valueType: preset.valueType, value: money(preset.value), qty: free, dinerNo: null, appliedBy: actor.personId, appliedAtDevice: at });
  }
  if (rows.length === 0) return { wrote: false, applied, skipped };
  await posV2Repo.insertLineDiscounts(tx, rows);
  for (const r of rows) {
    await audit(tx, actor, 'pos.discount_added', {
      storeId: input.storeId, entityId: r.id!, pairingId, at,
      after: { lineId: r.sessionLineId, kind: 'preset', qty: r.qty, valueType: r.valueType, value: r.value, presetId: preset.id, applyAll: true },
    });
  }
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true, applied, skipped };
}
