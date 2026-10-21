/**
 * T-375 S6 (R10) - `postPosCorrection`: the correcting entry for a VERIFIED POS day whose figures POS changed afterwards.
 * `docs/tasks/375-pos-v1-day-feed.md` S6, `docs/POSTING-PATTERNS.md` `sale.pos-correction`.
 *
 * The day's own figures, status and entry never change (the S4 lock forbids it, and history is a new fact, not an edit).
 * What is posted is the DIFFERENCE between what the ledger holds for the day and what the checked feed now says:
 *
 *   old   = the net per (account, party) of the day's entry plus its prior correction entries, read from `journal_lines`
 *           (V7: what was POSTED, never a re-derivation from today's tenders);
 *   new   = R4's derivation of the checked feed with the store's CURRENT tenders, composed with the day's current
 *           platform rows (R8, `routeInputForDay`) and routed, so a correction composes a day exactly as verify did;
 *   delta = new - old, per (account, party): positive posts as a debit, negative as a credit. All zero is refused.
 *
 * The correction row and its entry share an id: the entry's `source_id` IS the correction's id (so reports can pick up
 * corrections and the reversals of them by `source_id`, R14), hence the id is chosen here and the entry is posted first.
 * The correction row moves the day's basis to the checked feed (`posV1Repo.basisFor`), which is what clears the finding.
 */
import { authorize, type Actor } from '@shareat/auth';
import { moneyAccountsRepo, posV1Repo, salesDaysRepo, storesRepo, type Tx } from '@shareat/db';
import { add, compare, isZero, money, negate, subtract, type Money } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { deriveSalesDay } from '../pos/v1-derive';
import { gone, humanDate, internalFault, refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SALES_DAY_CORRECTION_RULES } from '../field-rules/sales-days';
import { routeInputForDay } from './compose';
import { routeSalesDay } from './routing';

export interface PostPosCorrectionInput {
  readonly salesDayId: string;
  /** The `sales` feed to correct to (the day's latest check). */
  readonly feedId: string;
  /** A Manila date in an open month, not before the day's own business date. */
  readonly entryDate: string;
  readonly reason: string;
}

export interface PostPosCorrectionResult {
  readonly correctionId: string;
  readonly journalEntryId: string;
}

function dayLabel(businessDate: string): string {
  try {
    return humanDate(parseBusinessDate(businessDate));
  } catch {
    return businessDate;
  }
}

const keyOf = (accountCode: string, partyType: string | null | undefined, partyId: string | null | undefined) =>
  `${accountCode}|${partyType ?? ''}|${partyId ?? ''}`;

export async function postPosCorrection(tx: Tx, actor: Actor, input: PostPosCorrectionInput): Promise<PostPosCorrectionResult> {
  const { orgId } = actor;
  // T-375 S6 audit: the day lock first, as import/usage take it, so a recheck, a usage pull and a correction serialize.
  const day = await salesDaysRepo.getByIdForUpdate(tx, orgId, input.salesDayId);
  if (!day) throw gone(`postPosCorrection: sales day ${input.salesDayId} does not exist in org ${orgId}`, 'sales day');

  await authorize(tx, actor, 'verify_sales_day', { storeId: day.storeId });
  // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
  assertFieldRules(SALES_DAY_CORRECTION_RULES, { entryDate: input.entryDate, reason: input.reason });

  const when = dayLabel(day.businessDate);
  if (day.status !== 'verified' || day.source !== 'pos_v1_day_feed' || !day.journalEntryId) {
    throw refuse(
      `postPosCorrection: sales day ${day.id} is ${day.status}/${day.source}, not a verified POS day`,
      `Only a verified day that came from POS can be corrected. ${when} is ${day.status === 'verified' ? 'a typed day' : day.status}.`,
    );
  }
  const reason = (input.reason ?? '').trim();
  if (!reason) throw refuse('postPosCorrection: reason is blank', 'Say why the correction is needed.');

  const feed = await posV1Repo.getFeedById(tx, orgId, input.feedId);
  if (!feed || feed.kind !== 'sales' || feed.storeId !== day.storeId || feed.businessDate !== day.businessDate) {
    throw refuse(
      `postPosCorrection: feed ${input.feedId} is not a sales feed of sales day ${day.id}`,
      `That isn't a POS check of ${when}'s sales.`,
    );
  }

  // The order is pinned: "already posted" is answered before "no change" (a repeat's basis is the feed itself).
  if (await posV1Repo.findCorrectionByToFeed(tx, orgId, day.id, feed.id)) {
    throw refuse(`postPosCorrection: feed ${feed.id} is already a correction of sales day ${day.id}`, 'That POS check has already been posted as a correction.');
  }
  const basis = await posV1Repo.basisFor(tx, orgId, day.id);
  if (!basis) throw internalFault(`postPosCorrection: verified feed day ${day.id} has no basis feed`);
  const newer =
    feed.fetchedAt.getTime() > basis.fetchedAt.getTime() ||
    (feed.fetchedAt.getTime() === basis.fetchedAt.getTime() && feed.id.localeCompare(basis.id) > 0);
  if (!newer) {
    throw refuse(
      `postPosCorrection: feed ${feed.id} is not newer than basis ${basis.id}`,
      feed.id === basis.id
        ? `POS's figures for ${when} haven't changed since they were posted.`
        : 'That POS check is older than the figures already posted.',
    );
  }

  try {
    parseBusinessDate(input.entryDate);
  } catch {
    throw refuse(`postPosCorrection: invalid entry date ${JSON.stringify(input.entryDate)}`, "That isn't a valid date. Use YYYY-MM-DD.");
  }
  if (input.entryDate.localeCompare(day.businessDate) < 0) {
    throw refuse(
      `postPosCorrection: entry date ${input.entryDate} is before business date ${day.businessDate}`,
      `A correction can't be dated before the day it corrects (${when}).`,
    );
  }

  // ---- old: what was POSTED ------------------------------------------------------------------------------------
  const priors = await posV1Repo.listCorrectionsForDay(tx, orgId, day.id);
  const oldRows = await posV1Repo.postedNetForEntries(tx, orgId, [day.journalEntryId, ...priors.map((c) => c.journalEntryId)]);
  const net = new Map<string, { accountCode: string; partyType: string | null; partyId: string | null; amount: Money }>();
  for (const r of oldRows) {
    net.set(keyOf(r.accountCode, r.partyType, r.partyId), {
      accountCode: r.accountCode, partyType: r.partyType, partyId: r.partyId, amount: money(r.net),
    });
  }
  // `net` starts as OLD in (debit - credit) terms; each new line then adds (credit - debit), so it ends as
  // (new credit-debit) - (old credit-debit) = new - old, in credit-minus-debit terms: positive posts as a credit.

  // ---- new: the checked feed, derived with today's tenders and composed as verify composes -----------------------
  const store = await storesRepo.getById(tx, orgId, day.storeId);
  const link = await posV1Repo.getLinkByStore(tx, orgId, day.storeId);
  if (!link) {
    throw refuse(
      `postPosCorrection: store ${day.storeId} has no POS link`,
      `${store?.name ?? 'This store'} isn't linked to a POS store, so its POS figures can't be read.`,
    );
  }
  // T-382 R9a (REV-2, I6): a day imported under an earlier link is never re-derived under this one. After an unlink and
  // a relink, the live link may name another POS store, or carry a tax type or tenders the day was never sold under.
  if (basis.posStoreId !== link.posStoreId || (link.updatedAt !== null && basis.fetchedAt.getTime() < link.updatedAt.getTime())) {
    throw refuse(
      `postPosCorrection: day ${day.id} was imported under an earlier link of store ${day.storeId}`,
      `${store?.name ?? 'This store'} isn't linked to a POS store, so its POS figures can't be read.`,
    );
  }
  const tenders = await posV1Repo.listTendersByStore(tx, orgId, day.storeId);
  const dayChannels = await salesDaysRepo.getChannelsForDay(tx, day.id);
  // The DAY's own remitted channel row, not the link's current channel: a link channel change after verify must not
  // break a correction. (The link's tax type is kept; VAT-exclusive is refused anyway.)
  const remitted = dayChannels.find((c) => c.isRemittedDaily);
  const derived = deriveSalesDay(feed.payload, {
    channelId: remitted?.channelId ?? link.salesChannelId,
    taxType: link.posTaxType,
    tenders,
    businessDate: day.businessDate,
    storeName: store?.name,
  });
  if (!derived.ok) throw refuse(derived.raw, derived.sentence);

  // A wallet whose money account was retired since the tender was set up is caught here, by the tender's name (as import.ts).
  for (const t of derived.tenders) {
    const account = await moneyAccountsRepo.getById(tx, orgId, t.moneyAccountId);
    if (!account || !account.isActive) {
      const name = tenders.find((x) => x.moneyAccountId === t.moneyAccountId)?.name ?? 'A wallet tender';
      throw refuse(
        `postPosCorrection: money account ${t.moneyAccountId} of tender "${name}" is retired or missing`,
        `${name}'s money account is no longer active, so ${when} can't be corrected. An admin sets ${name}'s account under Settings › POS link.`,
      );
    }
  }

  const channels = dayChannels.map((c) =>
    c.isRemittedDaily && c.channelId === derived.channel.channelId ? { ...c, amount: derived.channel.amount, noSales: false } : c,
  );
  const f = derived.figures;
  const routed = routeSalesDay(
    routeInputForDay(
      {
        ...day,
        totalSales: f.totalSales,
        unliSales: f.unliSales,
        alaCarteSales: f.alaCarteSales,
        seniorDiscount: f.seniorDiscount,
        pwdDiscount: f.pwdDiscount,
        otherDiscount: f.otherDiscount,
        comps: f.comps,
        serviceCharge: f.serviceCharge,
        otherCharges: f.otherCharges,
        cashCollected: f.cashCollected,
        onlineCollected: f.onlineCollected,
        creditSales: f.creditSales,
        refunds: f.refunds,
      },
      channels,
      derived.tenders.map((t) => ({ id: '', moneyAccountId: t.moneyAccountId, moneyAccountName: '', custodian: '', amount: String(t.amount) })),
    ),
  );
  if (!routed.ok) {
    throw refuse(
      `postPosCorrection: sales day ${day.id} cannot be routed from feed ${feed.id} - ${routed.reason}`,
      `POS's new figures for ${when} can't be posted: ${routed.reason}.`,
    );
  }
  for (const l of routed.lines) {
    const k = keyOf(l.accountCode, l.partyType, l.partyId);
    const cur = net.get(k) ?? { accountCode: l.accountCode, partyType: l.partyType ?? null, partyId: l.partyId ?? null, amount: money('0') };
    // a routed credit adds, a routed debit subtracts.
    net.set(k, { ...cur, amount: l.side === 'credit' ? add(cur.amount, l.amount) : subtract(cur.amount, l.amount) });
  }
  // Each entry is (new - old) in credit-minus-debit terms; the sign picks the side.
  const lines: PostEntryLine[] = [];
  for (const e of [...net.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    if (isZero(e.amount)) continue;
    const credit = compare(e.amount, money('0')) > 0;
    const amountText = String(credit ? e.amount : negate(e.amount));
    lines.push({
      accountCode: e.accountCode,
      storeId: day.storeId,
      partyType: (e.partyType ?? null) as PostEntryLine['partyType'],
      partyId: e.partyId,
      debit: credit ? '0' : amountText,
      credit: credit ? amountText : '0',
      lineMemo: 'POS correction',
    });
  }
  if (lines.length === 0) {
    throw refuse(
      `postPosCorrection: feed ${feed.id} posts the same as sales day ${day.id} already holds`,
      `POS's figures for ${when} haven't changed since they were posted.`,
    );
  }

  // ---- post, then record ------------------------------------------------------------------------------------------
  const correctionId = crypto.randomUUID();
  const posted = await postEntry(tx, {
    orgId,
    entryDate: input.entryDate,
    sourceType: 'sale',
    sourceId: correctionId,
    idempotencyKey: `sales_day:${day.id}:pos_correction:${feed.id}`,
    memo: `POS correction for ${day.businessDate}: ${reason}`,
    postedBy: actor.personId,
    lines,
  });
  if (!posted.created) {
    throw refuse(`postPosCorrection: idempotency key already used for feed ${feed.id}`, 'That POS check has already been posted as a correction.');
  }
  await posV1Repo.insertCorrection(tx, {
    id: correctionId,
    orgId,
    storeId: day.storeId,
    salesDayId: day.id,
    fromFeedId: basis.id,
    toFeedId: feed.id,
    entryDate: input.entryDate,
    journalEntryId: posted.entryId,
    reason,
    postedBy: actor.personId,
  });
  return { correctionId, journalEntryId: posted.entryId };
}
