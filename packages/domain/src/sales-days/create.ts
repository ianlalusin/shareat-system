/**
 * createSalesDay — and **the create-block**, which is the interesting part.
 * docs/tasks/123-sales-day.md §4.2, bible row 126.
 *
 * ## The forcing function, and why it does not deadlock
 *
 * Ian: *"Block creating a new sales report when an older unverified one is already in place, so
 * the revenue is only hours late."* Without it, unrecognised revenue accumulates silently; with
 * it, **the pile cannot grow past one** and the person who must act cannot do their next job until
 * they do.
 *
 * ⚠️ **v1's three carve-outs are load-bearing and every one of them falls out of the design rather
 * than being special-cased:**
 *
 *   - **Editing an existing draft** — a different function (`editSalesDay`), which never consults
 *     the block. Otherwise the blocked day could never be fixed.
 *   - **Backfilling an OLDER date** — the query is *strictly before* the date being created, so an
 *     earlier date is not blocked by a later one. You can always fill the gap that caused the
 *     block.
 *   - **Starting a shift** — a different document entirely (T-136). **The block is about
 *     RECOGNITION, never about trading.**
 *
 * ## Admins bypass
 *
 * v1 flipped to this deliberately in June 2026 at Ian's request, having originally shipped with no
 * exemption. ⚠️ **Do not "restore" the stricter version** on the strength of reading the first
 * commit — the exemption is the newer decision.
 */
import { authorize, type Actor } from '@shareat/auth';
import { moneyAccountsRepo, salesDaysRepo, type Tx } from '@shareat/db';
import { add, compare, isZero, ZERO, type Money } from '@shareat/core/money';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SALES_DAY_CREATE_RULES } from '../field-rules/sales-days';
import { assertCanOpenDay, assertStoreTakesTypedDays, safeHumanDate } from './create-block';

// T-375 S3: the create-block moved to `create-block.ts`; its names stay importable from here.
export { SalesDayBlockedError, TransitShortfallBlockedError, canBypassBlock } from './create-block';

export interface CreateSalesDayChannelInput {
  channelId: string;
  amount: string;
  /** True = the reporter explicitly confirmed no sales on this channel, as opposed to leaving it
   *  blank. **An absent row and a confirmed zero must not mean the same thing** (v1's
   *  `noSalesChannelIds`, and the same distinction T-134 draws for a counted zero). */
  noSales?: boolean;
}

export interface CreateSalesDayTenderInput {
  moneyAccountId: string;
  amount: string;
}

export interface CreateSalesDayInput {
  storeId: string;
  businessDate: string;
  totalSales: string;
  unliSales: string;
  alaCarteSales: string;
  seniorDiscount?: string;
  pwdDiscount?: string;
  otherDiscount?: string;
  comps?: string;
  serviceCharge?: string;
  otherCharges?: string;
  cashCollected?: string;
  onlineCollected?: string;
  creditSales?: string;
  channels?: CreateSalesDayChannelInput[];
  /** ⭐ WHERE the online money landed — one row per wallet (DEF-068). Required whenever
   *  `onlineCollected` is non-zero: `1140` is a control account and `verifySalesDay` refuses to
   *  post a day whose wallets do not sum to its online total. */
  tenders?: CreateSalesDayTenderInput[];
}

export async function createSalesDay(
  tx: Tx,
  actor: Actor,
  input: CreateSalesDayInput,
): Promise<{ id: string }> {
  return runCreate(tx, actor, input);
}

async function runCreate(tx: Tx, actor: Actor, input: CreateSalesDayInput): Promise<{ id: string }> {
  await authorize(tx, actor, 'submit_sales_day', { storeId: input.storeId });
  // T-440 / S9: the screen's own rule judges the box AFTER the gate (T-364 order). Moved here from the action.
  // PostgreSQL and the existing duplicate-day refusal accept unpadded month/day spellings.
  // Pad only that spelling for the strict calendar check; the domain's existing input and refusal remain unchanged.
  const dateForCheck = typeof input.businessDate === 'string'
    ? input.businessDate.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_all, year: string, month: string, day: string) =>
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    )
    : input.businessDate;
  assertFieldRules(SALES_DAY_CREATE_RULES, { businessDate: dateForCheck });
  // T-375 S3 (R13): a LINKED store takes its sales from POS - the typed path refuses (store row FOR KEY SHARE first).
  await assertStoreTakesTypedDays(tx, actor, input.storeId, 'createSalesDay');

  const existing = await salesDaysRepo.findByBusinessDate(tx, actor.orgId, input.storeId, input.businessDate);
  if (existing) {
    throw refuse(
      `createSalesDay: a sales day already exists for store ${input.storeId} on ${input.businessDate} ` +
        `(status ${existing.status}) — edit it rather than creating a second`,
      `This store already has a sales day for ${safeHumanDate(input.businessDate)} ` +
        `(${existing.status}). Edit that one instead of starting a second.`,
    );
  }

  // T-375 S3: the voided-date rule, the create-block and the transit-shortfall block live in `create-block.ts`,
  // shared with `importSalesDay` (the one copy).
  await assertCanOpenDay(tx, actor, input, 'createSalesDay');

  // T-371 R5/R6: parsed after authorize(), and a blank follows its column — the three revenue figures
  // (NOT NULL, no default) are refused in words; the defaulted ones fall back to the column default.
  const parsed = parseSalesDayFigures(input, 'createSalesDay');
  // The defaulted figures stay optional: `insertSalesDay` omits a blank one, so the column's own DEFAULT applies (R13).
  const figures = parsed;

  const { id } = await salesDaysRepo.insertSalesDay(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    // T-375 S3: a typed day is never POS-sourced (the "From POS" box is gone); an old `posSourced` input is ignored.
    source: 'legacy_typed',
    posV1DayFeedId: null,
    posSourced: false,
    posSourcedAt: null,
    totalSales: figures.totalSales,
    unliSales: figures.unliSales,
    alaCarteSales: figures.alaCarteSales,
    seniorDiscount: figures.seniorDiscount,
    pwdDiscount: figures.pwdDiscount,
    otherDiscount: figures.otherDiscount,
    comps: figures.comps,
    serviceCharge: figures.serviceCharge,
    otherCharges: figures.otherCharges,
    cashCollected: figures.cashCollected,
    onlineCollected: figures.onlineCollected,
    creditSales: figures.creditSales,
    createdBy: actor.personId,
  });

  if (input.channels && input.channels.length > 0) {
    await writeChannels(tx, actor, input.storeId, id, input.channels);
  }
  if (input.tenders && input.tenders.length > 0) {
    await writeTenders(tx, actor, input.storeId, id, input.tenders);
  }

  return { id };
}

/**
 * Channel rows, validated against this store's OWN channel configuration.
 *
 * ⚠️ A channel id that does not belong to this store is refused rather than written — otherwise a
 * day could reference another store's channel and its money would be attributed to the wrong
 * receivable. Exported because `editSalesDay` needs exactly the same validation.
 */
export async function writeChannels(
  tx: Tx,
  actor: Actor,
  storeId: string,
  salesDayId: string,
  channels: CreateSalesDayChannelInput[],
): Promise<void> {
  const configured = await salesDaysRepo.listChannels(tx, actor.orgId, storeId);
  const byId = new Map(configured.map((c) => [c.id, c]));

  const rows = channels.map((c) => {
    const cfg = byId.get(c.channelId);
    if (!cfg) {
      throw refuse(
        `sales day channels: channel ${c.channelId} is not configured for store ${storeId} — ` +
          `a day may only report channels its own store has`,
        "One of the sales channels on this day isn't set up for this store. Reload the page and try again.",
      );
    }
    // T-371: parsed in words (was a raw `money()` whose TypeError is a developer message). The column is
    // NOT NULL DEFAULT '0', but a channel row is only sent when it carries a figure or a confirmed zero.
    const amount = parseMoneyInput(c.amount, `sales day channels: "${cfg.name}"'s amount`, `The amount for "${cfg.name}"`);
    const noSales = c.noSales ?? false;
    if (noSales && !isZero(amount)) {
      throw refuse(
        `sales day channels: "${cfg.name}" is marked "no sales" but carries ${amount} — ` +
          `a confirmed zero and an amount are different claims`,
        `"${cfg.name}" is marked "no sales" but carries ${amount} — a confirmed zero and an amount are different claims.`,
      );
    }
    return { channelId: c.channelId, amount, noSales };
  });

  await salesDaysRepo.replaceChannels(tx, salesDayId, rows);
}

/** Sum of a day's figures, for callers that want to show a total before writing. Pure. */
export function sumTender(input: {
  cashCollected: Money;
  onlineCollected: Money;
  creditSales: Money;
  discountsTotal: Money;
  comps: Money;
}): Money {
  return add(input.cashCollected, input.onlineCollected, input.creditSales, input.discountsTotal, input.comps);
}

/**
 * Persists the day's tender breakdown.
 *
 * ⚠️ Every wallet must belong to THIS store, checked the same way a channel is. A day reporting
 * money into another branch's wallet is either a typo or a cross-store leak, and both should stop
 * here rather than reach the ledger — where the line would still post, because
 * `journal_lines.party_id` carries no FK by design (DEF-040).
 */
export async function writeTenders(
  tx: Tx,
  actor: Actor,
  storeId: string,
  salesDayId: string,
  tenders: CreateSalesDayTenderInput[],
): Promise<void> {
  const available = await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId });
  const byId = new Map(available.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const rows: { moneyAccountId: string; amount: Money }[] = [];
  for (const t of tenders) {
    const cfg = byId.get(t.moneyAccountId);
    if (!cfg) {
      throw refuse(
        `sales day tenders: money account ${t.moneyAccountId} is not an active account for store ` +
          `${storeId} — a day may only report money into its own store's wallets`,
        "One of the wallets on this day isn't an active wallet of this store. Reload the page and try again.",
      );
    }
    if (seen.has(t.moneyAccountId)) {
      throw refuse(
        `sales day tenders: "${cfg.name}" appears twice — one row per wallet, summed by the caller`,
        `"${cfg.name}" appears twice — one row per wallet, summed by the caller.`,
      );
    }
    seen.add(t.moneyAccountId);
    // DEF-272: was a raw `money()` call — well-formed already, but its TypeError is a developer
    // message, not a written sentence. `parseMoneyInput` is the shared entry point that fixes that.
    // T-371 R6: a blank box is "nothing landed here" — no row, never a guessed '0'.
    const amount = parseDecimalInput(t.amount, '14,2', `sales day tenders: "${cfg.name}"'s amount`, `The amount for "${cfg.name}"`, {
      blank: 'omit',
    });
    // A typed zero says "nothing landed here", which is exactly what a blank box says: no row (a row of
    // zero would claim money moved). A negative is not a figure a wallet can receive.
    if (amount === undefined || isZero(amount)) continue;
    if (compare(amount, ZERO) < 0) {
      throw refuse(
        `sales day tenders: "${cfg.name}" carries ${amount} — a tender cannot be negative`,
        `The amount for "${cfg.name}" can't be negative. Leave it blank if no money landed there.`,
      );
    }
    rows.push({ moneyAccountId: t.moneyAccountId, amount });
  }

  await salesDaysRepo.replaceTenders(tx, salesDayId, rows);
}

/**
 * T-371 R6 — a sales day's twelve figures, parsed into `Money` in words. Shared by create and edit.
 *
 * The three revenue figures are NOT NULL with no default, so a blank is refused with a sentence. The
 * other nine are NOT NULL DEFAULT '0', so a blank (or an absent field) is `undefined`: the caller omits
 * it — the database default on insert, the stored figure kept on an edit. `'0'` is never invented here.
 */
export function parseSalesDayFigures(
  input: Omit<CreateSalesDayInput, 'storeId' | 'businessDate'>,
  fn: string,
): {
  totalSales: Money;
  unliSales: Money;
  alaCarteSales: Money;
  seniorDiscount: Money | undefined;
  pwdDiscount: Money | undefined;
  otherDiscount: Money | undefined;
  comps: Money | undefined;
  serviceCharge: Money | undefined;
  otherCharges: Money | undefined;
  cashCollected: Money | undefined;
  onlineCollected: Money | undefined;
  creditSales: Money | undefined;
} {
  const required = (value: string | undefined, label: string): Money =>
    parseDecimalInput(value, '14,2', `${fn}: ${label}`, label, { blank: 'refuse' });
  const defaulted = (value: string | undefined, label: string): Money | undefined =>
    parseDecimalInput(value, '14,2', `${fn}: ${label}`, label, { blank: 'omit' });
  return {
    totalSales: required(input.totalSales, 'Total sales'),
    unliSales: required(input.unliSales, 'Unli sales'),
    alaCarteSales: required(input.alaCarteSales, 'À la carte sales'),
    seniorDiscount: defaulted(input.seniorDiscount, 'Senior discount'),
    pwdDiscount: defaulted(input.pwdDiscount, 'PWD discount'),
    otherDiscount: defaulted(input.otherDiscount, 'Other discount'),
    comps: defaulted(input.comps, 'Comps'),
    serviceCharge: defaulted(input.serviceCharge, 'Service charge'),
    otherCharges: defaulted(input.otherCharges, 'Other charges'),
    cashCollected: defaulted(input.cashCollected, 'Cash collected'),
    onlineCollected: defaulted(input.onlineCollected, 'Online collected'),
    creditSales: defaulted(input.creditSales, 'Credit sales'),
  };
}
