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
import { auditLogRepo, moneyAccountsRepo, salesDaysRepo, transaction, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { parseMoneyInput } from '../shared/money-input';
import { writeChannels, writeTenders, type CreateSalesDayInput } from './create';

export interface EditSalesDayInput extends Omit<CreateSalesDayInput, 'storeId' | 'businessDate'> {
  salesDayId: string;
}

export async function editSalesDay(tx: Tx | null, actor: Actor, input: EditSalesDayInput): Promise<{ id: string }> {
  if (tx) return runEdit(tx, actor, input);
  return transaction((trx) => runEdit(trx, actor, input));
}

async function runEdit(tx: Tx, actor: Actor, input: EditSalesDayInput): Promise<{ id: string }> {
  // R5: the row lock first — before any other read — so this and `runVerify` cannot interleave.
  const day = await salesDaysRepo.getByIdForUpdate(tx, actor.orgId, input.salesDayId);
  if (!day) throw gone(`editSalesDay: sales day ${input.salesDayId} does not exist in org ${actor.orgId}`, 'sales day');

  await authorize(tx, actor, day.status === 'submitted' ? 'verify_sales_day' : 'submit_sales_day', { storeId: day.storeId });

  if (day.status !== 'open' && day.status !== 'submitted') {
    throw refuse(
      `editSalesDay: sales day ${input.salesDayId} is ${day.status} — only an open or submitted day can be edited`,
      `Only an unverified sales day can be edited — this one is ${day.status}.`,
    );
  }

  const fig = (value: string | undefined, label: string): string =>
    String(parseMoneyInput(value ?? '0', `editSalesDay: ${label}`, label));
  const figures = {
    totalSales: fig(input.totalSales, 'Total sales'),
    unliSales: fig(input.unliSales, 'Unli sales'),
    alaCarteSales: fig(input.alaCarteSales, 'À la carte sales'),
    seniorDiscount: fig(input.seniorDiscount, 'Senior discount'),
    pwdDiscount: fig(input.pwdDiscount, 'PWD discount'),
    otherDiscount: fig(input.otherDiscount, 'Other discount'),
    comps: fig(input.comps, 'Comps'),
    serviceCharge: fig(input.serviceCharge, 'Service charge'),
    otherCharges: fig(input.otherCharges, 'Other charges'),
    cashCollected: fig(input.cashCollected, 'Cash collected'),
    onlineCollected: fig(input.onlineCollected, 'Online collected'),
    creditSales: fig(input.creditSales, 'Credit sales'),
  };

  // Channels and tenders are validated against THIS store's own configuration by the same helpers
  // `createSalesDay` uses; both replace the day's rows when given. A refusal throws out of the one
  // transaction, so nothing — header included — is left half-written.
  const before = await snapshot(tx, day);

  if (input.channels) await writeChannels(tx, actor, day.storeId, day.id, input.channels);
  if (input.tenders) {
    // A wallet retired since the day was entered is not offered on the form, so its tender row is not
    // in `input.tenders` - and replace semantics would silently delete a recorded fact. Rows for
    // wallets that are no longer active are kept as they are; blank active wallets still clear.
    const active = new Set((await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId: day.storeId })).map((a) => a.id));
    const retired = (await salesDaysRepo.getTendersForDay(tx, day.id)).filter((t) => !active.has(t.moneyAccountId));
    await writeTenders(tx, actor, day.storeId, day.id, input.tenders);
    if (retired.length > 0) {
      const written = await salesDaysRepo.getTendersForDay(tx, day.id);
      await salesDaysRepo.replaceTenders(tx, day.id, [...written, ...retired].map((t) => ({ moneyAccountId: t.moneyAccountId, amount: t.amount })));
    }
  }

  await salesDaysRepo.updateDraft(tx, actor.orgId, day.id, {
    ...figures,
    ...(input.posSourced === undefined
      ? {}
      : { posSourced: input.posSourced, posSourcedAt: input.posSourced ? (day.posSourcedAt ?? new Date()) : null }),
  });

  // Audited in the table that already exists, same transaction: this changes what the ledger will be
  // told at verify (the figures a verifier signs off), so who changed what, and from what, is kept.
  const after = await snapshot(tx, { ...day, ...figures });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'edit_sales_day',
    entity: 'sales_days',
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
