/**
 * editSalesDay — fix an UNVERIFIED sales day. T-369 S3 (DEF-479), `docs/tasks/369-unwired-money-screens.md`.
 *
 * `create.ts`'s header names this function as the carve-out that lets a blocked day be fixed; until
 * now it did not exist, so a day whose channels did not add up (Lipa, 2026-09-28: ₱1,000 of sales,
 * channels claiming ₱500) could not be verified and could not be corrected either.
 *
 * Rulings (the spec's R1-R5):
 *  - R1 the figures, channels and tenders change; the STORE and the DATE never do — the create-block
 *    and the unique index both key on them, so `storeId` / `businessDate` in the input are ignored;
 *  - R2 it never consults the create-block (it is not a new day);
 *  - R4 the status is kept: an `open` day stays open, a `submitted` day stays submitted, and the
 *    verifier then sees the edited figures;
 *  - R5 the day row is read `FOR UPDATE` before anything else, the same lock `verifySalesDay` takes,
 *    so a verify can never post figures an edit is half-way through changing.
 *
 * Who may edit: an `open` day needs `submit_sales_day` (the cashier who closed it); once `submitted`
 * it is the verifier's, so it needs `verify_sales_day` (segregation of duties, `verify.ts`).
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, salesDaysRepo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { money, type Money } from '@shareat/core/money';
import { parseSalesDayFigures, writeChannels, writeTenders, type CreateSalesDayInput } from './create';
import { assertStoreTakesTypedDays } from './create-block';

export interface EditSalesDayInput extends Omit<CreateSalesDayInput, 'storeId' | 'businessDate'> {
  salesDayId: string;
}

export async function editSalesDay(tx: Tx, actor: Actor, input: EditSalesDayInput): Promise<{ id: string }> {
  return runEdit(tx, actor, input);
}

async function runEdit(tx: Tx, actor: Actor, input: EditSalesDayInput): Promise<{ id: string }> {
  // R5: the row lock first — before any other read — so this and `runVerify` cannot interleave.
  const day = await salesDaysRepo.getByIdForUpdate(tx, actor.orgId, input.salesDayId);
  if (!day) throw gone(`editSalesDay: sales day ${input.salesDayId} does not exist in org ${actor.orgId}`, 'sales day');

  await authorize(tx, actor, day.status === 'submitted' ? 'verify_sales_day' : 'submit_sales_day', { storeId: day.storeId });

  // T-375 S3 (R13): a store linked to POS since the day was typed has its days imported, never edited here. Asked
  // BEFORE the status rule, so a verified typed day gets the same sentence as an open one.
  await assertStoreTakesTypedDays(tx, actor, day.storeId, 'editSalesDay');

  if (day.status !== 'open' && day.status !== 'submitted') {
    throw refuse(
      `editSalesDay: sales day ${input.salesDayId} is ${day.status} — only an open or submitted day can be edited`,
      `Only an unverified sales day can be edited — this one is ${day.status}.`,
    );
  }

  // T-371 R5/R6: parsed after authorize(). The three revenue figures are refused when blank; a blank
  // defaulted figure is left out of the patch, so the stored figure stands (never a guessed '0').
  const parsed = parseSalesDayFigures(input, 'editSalesDay');
  const figures: Partial<Record<keyof typeof parsed, Money>> = {};
  for (const key of Object.keys(parsed) as (keyof typeof parsed)[]) {
    const value = parsed[key];
    if (value !== undefined) figures[key] = value;
  }

  // Channels and tenders are validated against THIS store's own configuration by the same helpers
  // `createSalesDay` uses; both replace the day's rows when given. A refusal throws out of the one
  // transaction, so nothing — header included — is left half-written.
  const before = await snapshot(tx, day);

  if (input.channels) await writeChannels(tx, actor, day.storeId, day.id, input.channels);
  if (input.tenders) {
    // Only the wallets the edit NAMES are changed: a positive amount sets that wallet's row, a typed zero
    // clears it, and a wallet the edit does not mention keeps its row exactly as it was. The form offers
    // only ACTIVE wallets, so a wallet retired since the day was entered is never in `input.tenders` -
    // replace-everything semantics would silently delete a recorded fact.
    const mentioned = new Set(input.tenders.map((t) => t.moneyAccountId));
    const untouched = (await salesDaysRepo.getTendersForDay(tx, day.id)).filter((t) => !mentioned.has(t.moneyAccountId));
    await writeTenders(tx, actor, day.storeId, day.id, input.tenders);
    if (untouched.length > 0) {
      const written = await salesDaysRepo.getTendersForDay(tx, day.id);
      await salesDaysRepo.replaceTenders(tx, day.id, [...written, ...untouched].map((t) => ({ moneyAccountId: t.moneyAccountId, amount: money(t.amount) })));
    }
  }

  await salesDaysRepo.updateDraft(tx, actor.orgId, day.id, figures);

  // Audited in the table that already exists, same transaction: this changes what the ledger will be
  // told at verify (the figures a verifier signs off), so who changed what, and from what, is kept.
  const after = await snapshot(tx, { ...day, ...figures });
  // An edit that changed nothing leaves nothing to audit: a trail of non-changes is noise that hides the real ones.
  if (JSON.stringify(before) === JSON.stringify(after)) return { id: day.id };
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'edit_sales_day',
    storeId: day.storeId,
    entityId: day.id,
    before,
    after,
    // The ERP screen is this function's only caller today (the `setChannelPayoutDestination` precedent).
    source: 'web',
  });

  return { id: day.id };
}

/** The figures, channels and tenders a verifier would be signing, for the audit row. */
async function snapshot(
  tx: Tx,
  day: Awaited<ReturnType<typeof salesDaysRepo.getById>> & object,
): Promise<Record<string, unknown>> {
  const channels = await salesDaysRepo.getChannelsForDay(tx, day.id);
  const tenders = await salesDaysRepo.getTendersForDay(tx, day.id);
  return {
    status: day.status,
    posSourced: day.posSourced,
    totalSales: day.totalSales,
    unliSales: day.unliSales,
    alaCarteSales: day.alaCarteSales,
    seniorDiscount: day.seniorDiscount,
    pwdDiscount: day.pwdDiscount,
    otherDiscount: day.otherDiscount,
    comps: day.comps,
    serviceCharge: day.serviceCharge,
    otherCharges: day.otherCharges,
    cashCollected: day.cashCollected,
    onlineCollected: day.onlineCollected,
    creditSales: day.creditSales,
    channels: channels.map((c) => ({ channelId: c.channelId, amount: c.amount, noSales: c.noSales })),
    tenders: tenders.map((t) => ({ moneyAccountId: t.moneyAccountId, amount: t.amount })),
  };
}
