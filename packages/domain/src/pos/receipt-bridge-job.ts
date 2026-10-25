/**
 * `posReceiptBridgeSweep` - the 06:30 Manila nightly POS receipt bridge. T-472 S2, `docs/tasks/472-pos-nightly-receipt-bridge.md`.
 *
 * ## What it does
 *
 * For every store with a LIVE POS link it copies each receipt POS rang (lines, payments, discounts, voids, refunds) from POS's
 * Firebase into `pos_bridge_receipts` and its children: a faithful, READ-ONLY copy. Nothing is posted to the books, `sales_days`
 * is untouched, and Firebase is never written (the port has no write member). It then compares each store-day's receipts with
 * the POS day feed and says so (`pos_bridge_day_checks`): a check, not truth.
 *
 * ## The Firestore read budget (Opus ruling, 25 Oct)
 *
 * A night reads YESTERDAY plus any day of the 7-day window that has no `pos_bridge_day_checks` row for that store yet (a host
 * that was down, a store linked late), the same idea as the day-import catch-up. Days before the write floor never get a check,
 * so they are never "missing": a December night reads yesterday only. The change-time queries (voidedAt/editedAt/createdAt since
 * the last ok run minus 2h) pick up later voids, edits and offline syncs. ⚠️ `gone` is therefore detected only on days that are
 * actually re-read (yesterday and missed days); a receipt deleted from an older day is not noticed. Accepted.
 * Expected reads, per store-day read: the day list + the T-478 server-day walk (about 2 reads per receipt) + 2 counts, so about
 * 8.4k reads a night for all stores, against the 50k/day free tier that POS's live traffic shares. Re-reading all 7 days was ~118k.
 * A dry run reads yesterday only; `date` (the `--date` flag) reads exactly that day, live or dry.
 *
 * ## The rules that are easy to break
 *
 *  - ⛔ Every read and write of our tables runs under `withOrgPrincipal`, never a bare transaction (RLS fails closed). Domain
 *    functions here take `tx: Tx`; `systemTransaction` appears only inside `runJobForOrg`/`listOrgsToRun` (run rows, org list).
 *  - READS are never floored; WRITES are. Nothing dated before 2027-01-01 is written (older POS data is test data, bible row
 *    379), but it is still read, so the December rehearsal (`--dry-run`) works. A dry run writes nothing at all (no receipts, no
 *    checks, no `scheduler_runs` row) and ignores the floor so it can show what 1 Jan would copy.
 *  - A new version only when the hash differs (Ruling 3); a document seen before and missing from a re-read day gets a `gone`
 *    version; a lost race for the same version is a skip, never a failure.
 *  - Money: whole centavos, `money_flag` when POS's float was not one. A receipt is NEVER dropped for its money.
 *  - ⛔ NO personal data (Ruling 7): `raw` goes through the ALLOW-LIST (`scrubReceiptRaw`) here again, whatever the port handed over.
 *  - Database errors are said without row values (the repo sanitises them before they get here).
 *  - Stores come from LIVE links only. There is no hard-coded exclusion list.
 */
import { posBridgeRepo, posV1Repo, schedulerRepo, withOrgPrincipal, type SchedulerFailure, type Tx } from '@shareat/db';
import { decimal, toBusinessDate, toCentavos, type Money } from '@shareat/core';
import { addDays as addBusinessDays, businessDayRange, parseBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { runJobForOrg, listOrgsToRun, type JobOutcome } from '../scheduler';
import { safeHumanDate } from '../sales-days/create-block';
import { scrubReceiptRaw } from './receipt-bridge-scrub';
import type { BridgeChangeField, BridgeSourceReceipt, PosReceiptBridgePort } from './receipt-bridge-port';

/** Nothing before this Manila date is written (bible row 379). Reads are not floored. */
export const POS_BRIDGE_WRITE_FLOOR = '2027-01-01';

/** The re-read window: yesterday and the six days before it, so a host down for a week still fills in and `gone` can be seen. */
export const POS_BRIDGE_CATCH_UP_DAYS = 7;

/** The change-time queries start this long before the last successful run, so a receipt stamped while it ran is not missed. */
const SINCE_OVERLAP_MS = 2 * 3_600_000;

const CHANGE_FIELDS: readonly BridgeChangeField[] = ['voidedAt', 'editedAt', 'createdAt'];

export interface PosReceiptBridgeOutcome extends JobOutcome {
  /** Receipts read from POS this run (before the floor and the hash decide what is written). */
  readonly read?: number;
}

export interface PosReceiptBridgeSweepResult {
  readonly outcomes: PosReceiptBridgeOutcome[];
  readonly hadFailures: boolean;
}

interface OrgWork {
  posted: number;
  skipped: number;
  failures: SchedulerFailure[];
  detail: string;
  read: number;
}

// ---- small helpers ------------------------------------------------------------------------------------------------

function addDays(iso: string, n: number): string {
  return addBusinessDays(parseBusinessDate(iso), n);
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d.localeCompare(to) <= 0 && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The error text for a screen: a database refusal already carries no row values; anything quoting a query is replaced. */
function reasonOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Failed query|params:|insert into|select .* from/i.test(msg)) return 'a database call failed';
  return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
}

const pesos = (centavos: number): string => `${centavos < 0 ? '-' : ''}P${(Math.abs(centavos) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- mapping a port receipt to repo rows ---------------------------------------------------------------------------------

/**
 * THE one integer rounding for every derived centavo figure: half AWAY from zero, so a sale line and its refund mirror each other.
 * Never `Math.round` (it rounds -0.5 toward zero) and never a float into a column.
 */
export function roundHalfAway(x: number): number {
  const r = Math.floor(Math.abs(x) + 0.5);
  return x < 0 ? -r : r;
}

/** Money string -> centavos. A missing figure is 0 and FLAGGED: the receipt is still copied. */
function cents(m: Money | null): { c: number; flag: boolean } {
  if (m === null) return { c: 0, flag: true };
  return { c: Number(toCentavos(m)), flag: false };
}

function toRows(
  ctx: { orgId: string; storeId: string; posStoreId: string },
  r: BridgeSourceReceipt,
  date: string,
  tenderIds: ReadonlyMap<string, string>,
): { header: posBridgeRepo.BridgeHeaderInput; lines: posBridgeRepo.BridgeLineInput[]; tenders: posBridgeRepo.BridgeTenderInput[] } {
  const h = r.header;
  const total = cents(h.total);
  const disc = h.discountsTotal === null ? { c: 0, flag: false } : cents(h.discountsTotal);

  // POS writes a refund's lines with POSITIVE quantities and a NEGATIVE header total, so a refund line is stored with the refund
  // sign (quantity, discount and total negative) and a plain refund's lines add up to its header. A line that already carries a
  // negative quantity keeps its sign.
  const lines: posBridgeRepo.BridgeLineInput[] = r.lines.map((l) => {
    const unit = cents(l.unitPrice);
    const mods = l.modifiersTotal === null ? { c: 0, flag: false } : cents(l.modifiersTotal);
    const ordered = l.qtyOrdered ?? 0;
    const sign = h.kind === 'refund' || ordered < 0 ? -1 : 1;
    const voided = Math.abs(l.voidedQty ?? 0);
    const free = Math.abs(l.freeQty ?? 0);
    // What the line physically used (stock use later) vs what it bills: free quantity is used but not billed.
    const physical = Math.max(0, Math.abs(ordered) - voided);
    const billable = Math.max(0, Math.abs(ordered) - voided - free);
    const discQty = Math.min(Math.abs(l.discountQty ?? 0), billable);
    let flag = l.moneyFlag || unit.flag || mods.flag;
    const whole = (x: number): number => {
      const r2 = roundHalfAway(x);
      if (Math.abs(x - r2) > 1e-6) flag = true;
      return r2;
    };
    let discount = 0;
    if (discQty > 0) {
      if (l.discountType === 'fixed' && l.discountFixed !== null) discount = whole(Number(toCentavos(l.discountFixed)) * discQty);
      else if (l.discountType === 'percent' && l.discountPercent !== null) discount = whole((unit.c * discQty * l.discountPercent) / 100);
    }
    const gross = whole((unit.c + mods.c) * billable);
    return {
      lineNo: l.lineNo,
      posItemId: l.itemId,
      itemName: l.itemName ?? '(unnamed item)',
      quantity: decimal((sign * physical).toFixed(3), '14,3'),
      unitPriceCentavos: unit.c,
      discountCentavos: sign * discount,
      lineTotalCentavos: sign * (gross - discount),
      moneyFlag: flag,
    };
  });

  const tenders: posBridgeRepo.BridgeTenderInput[] = r.tenders.map((t, i) => {
    const a = cents(t.amount);
    return {
      seq: i + 1,
      methodAlias: t.methodName,
      tenderId: tenderIds.get(t.alias) ?? null,
      amountCentavos: a.c,
      moneyFlag: t.moneyFlag || a.flag,
    };
  });

  const header: posBridgeRepo.BridgeHeaderInput = {
    orgId: ctx.orgId,
    storeId: ctx.storeId,
    posStoreId: ctx.posStoreId,
    firestoreDocId: r.id,
    kind: h.kind,
    status: h.status === 'voided' || h.voidedAt !== null ? 'voided' : 'final',
    receiptNumber: h.receiptNumber,
    terminalNo: h.terminalNo === null ? null : String(h.terminalNo),
    parentDocId: h.parentReceiptId,
    clientAt: h.createdAtClientMs === null ? null : new Date(h.createdAtClientMs),
    posCalendarDate: date,
    subtotalCentavos: total.c + disc.c,
    discountCentavos: disc.c,
    totalCentavos: total.c,
    moneyFlag: h.moneyFlag || total.flag || disc.flag || lines.some((l) => l.moneyFlag) || tenders.some((t) => t.moneyFlag),
    raw: scrubReceiptRaw(h.raw),
    docHash: r.docHash,
  };
  return { header, lines, tenders };
}

// ---- the sweep ----------------------------------------------------------------------------------------------------------

export async function posReceiptBridgeSweep(options: {
  orgId?: string;
  now: Date;
  trigger?: 'cron' | 'manual';
  dryRun?: boolean;
  /** Read exactly this Manila day (YYYY-MM-DD) instead of yesterday plus missed days. */
  date?: string;
  port: PosReceiptBridgePort;
}): Promise<PosReceiptBridgeSweepResult> {
  const { now, port } = options;
  const trigger = options.trigger ?? 'cron';
  const dryRun = options.dryRun === true;
  const today = toBusinessDate(now);
  // `scheduler_runs.period` is a `YYYY-MM` shape: a daily job records the Manila month it ran in.
  const period = today.slice(0, 7);

  const orgs = await listOrgsToRun(options.orgId);
  const outcomes: PosReceiptBridgeOutcome[] = [];

  for (const org of orgs) {
    const work = () => bridgeForOrg(org, { today, dryRun, port, date: options.date });
    if (dryRun) {
      const base = { orgId: org.id, orgName: org.name, job: 'pos_receipt_bridge' as const, period };
      try {
        const w = await work();
        outcomes.push({
          ...base,
          posted: w.posted,
          skipped: w.skipped,
          failed: w.failures.filter((f) => f.kind !== 'notice').length,
          failures: w.failures,
          detail: w.detail,
          read: w.read,
        });
      } catch (err) {
        outcomes.push({ ...base, posted: 0, skipped: 0, failed: 0, failures: [], error: reasonOf(err) });
      }
    } else {
      outcomes.push(await runJobForOrg(org, 'pos_receipt_bridge', period, trigger, work, now));
    }
  }

  return { outcomes, hadFailures: outcomes.some((o) => o.failed > 0 || o.error) };
}

type WriteResult = 'written' | 'unchanged' | 'raced' | 'below_floor' | 'unplaceable';

async function bridgeForOrg(
  org: { id: string; name: string },
  ctx: { today: string; dryRun: boolean; port: PosReceiptBridgePort; date: string | undefined },
): Promise<OrgWork> {
  const { today, dryRun, port } = ctx;
  if (ctx.date !== undefined) parseBusinessDate(ctx.date);
  const failures: SchedulerFailure[] = [];
  let posted = 0;
  let unchanged = 0;
  let raced = 0;
  let belowFloor = 0;
  let goneCount = 0;
  let checksWritten = 0;
  let read = 0;
  let storesVisited = 0;

  const yesterday = addDays(today, -1);
  const windowStart = addDays(yesterday, -(POS_BRIDGE_CATCH_UP_DAYS - 1));
  const windowDates = dateRange(windowStart, yesterday);

  // Read BEFORE this run opens its own row, so "the last successful run" is really the previous one.
  const prev = await withOrgPrincipal(org.id, (tx) => schedulerRepo.lastOkRunFor(tx, org.id, 'pos_receipt_bridge'));

  const links = await withOrgPrincipal(org.id, (tx) => posV1Repo.listLiveLinks(tx, org.id));

  for (const link of links) {
    storesVisited += 1;
    const line = (reason: string, kind?: 'notice'): SchedulerFailure => ({
      subjectId: link.storeId,
      subjectName: link.storeName,
      reason,
      ...(kind ? { kind } : {}),
    });
    // Which days to read: see the read-budget note in the file header.
    let dates: string[];
    if (ctx.date !== undefined) dates = [ctx.date];
    else if (dryRun) dates = [yesterday];
    else {
      const have = await withOrgPrincipal(org.id, (tx) => posBridgeRepo.datesWithChecks(tx, org.id, link.storeId, windowStart, yesterday));
      dates = windowDates.filter((d) => d === yesterday || (d.localeCompare(POS_BRIDGE_WRITE_FLOOR) >= 0 && !have.has(d)));
    }
    // The change-time cutoff: after a successful run, 2 h before it. A dry run and a FIRST live run have no such run to lean on, so
    // they cut off at the start of the earliest day they actually read: never the 7-day window start (a wider net than the budget).
    const earliestRead = [...dates].sort()[0]!;
    const since =
      prev && !dryRun ? new Date(prev.startedAt.getTime() - SINCE_OVERLAP_MS) : businessDayRange(parseBusinessDate(earliestRead)).start;
    const store = { orgId: org.id, storeId: link.storeId, posStoreId: link.posStoreId };
    const tenderIds = await withOrgPrincipal(org.id, (tx) => posBridgeRepo.activeTenderIdsByAlias(tx, org.id, link.storeId));

    const seen = new Set<string>();
    const readOk = new Set<string>();
    let stopped = false;

    /** Writes (or, in a dry run, counts) one day's worth of receipts; one transaction, each receipt on its own savepoint. */
    const writeAll = async (docs: readonly BridgeSourceReceipt[], fallbackDate: string | null, label: string): Promise<void> => {
      if (docs.length === 0) return;
      await withOrgPrincipal(org.id, async (tx) => {
        for (const r of docs) {
          try {
            // Each receipt on its own savepoint: one statement error rolls back that receipt only, never the day's transaction.
            const res = await tx.transaction((sp) => writeOne(sp, store, r, fallbackDate, tenderIds, dryRun));
            if (res === 'written') posted += 1;
            else if (res === 'unchanged') unchanged += 1;
            else if (res === 'raced') raced += 1;
            else if (res === 'below_floor') belowFloor += 1;
            else failures.push(line(`${label}: receipt ${r.id} has no usable date from POS, so it was not copied.`));
          } catch (e) {
            failures.push(line(`${label}: receipt ${r.id} was not copied: ${reasonOf(e)}`));
          }
        }
      });
    };

    // 1. Each Manila day of the window: by client time, plus the receipts that lack it (T-478).
    for (const date of dates) {
      if (stopped) break;
      const when = safeHumanDate(date);
      try {
        const cross = await port.crossCheckDay(link.posStoreId, date);
        const docs: BridgeSourceReceipt[] = [];
        const inDay = new Set<string>();
        const take = (r: BridgeSourceReceipt): void => {
          if (!inDay.has(r.id)) {
            inDay.add(r.id);
            docs.push(r);
          }
        };
        let byClient = 0;
        for await (const r of port.listDay(link.posStoreId, date)) {
          take(r);
          byClient += 1;
        }
        const missingRead = new Set<string>();
        for await (const r of port.listMissingClientTime(link.posStoreId, date)) {
          take(r);
          missingRead.add(r.id);
        }
        const notRead = cross.missingClientMsIds.filter((id) => !missingRead.has(id));
        if (notRead.length > 0) {
          failures.push(line(`${when}: POS names ${notRead.length} receipt(s) without a client time that could not be read (${notRead.slice(0, 5).join(', ')}).`));
        }
        if (byClient < cross.byClientMs) {
          failures.push(line(`${when}: POS counted ${cross.byClientMs} receipts by client time but only ${byClient} were read.`));
        }
        for (const id of inDay) seen.add(id);
        read += docs.length;
        await writeAll(docs, date, when);
        // Only a COMPLETE read may feed `gone` and the day check: an incomplete one would mint false `gone` versions.
        if (notRead.length === 0 && byClient >= cross.byClientMs) readOk.add(date);
      } catch (e) {
        failures.push(line(`${when}: ${reasonOf(e)} The rest of this store's days wait for tomorrow.`));
        stopped = true;
      }
    }

    // 2. Receipts changed since the last good run (voids, edits, offline syncs older than the window).
    if (!stopped) {
      for (const field of CHANGE_FIELDS) {
        try {
          const docs: BridgeSourceReceipt[] = [];
          for await (const r of port.listChangedSince(link.posStoreId, field, since)) docs.push(r);
          for (const r of docs) seen.add(r.id);
          read += docs.length;
          await writeAll(docs, null, `changed (${field})`);
        } catch (e) {
          failures.push(line(`changes by ${field}: ${reasonOf(e)}`));
          break;
        }
      }
    }

    if (dryRun) continue;

    // 3. Gone versions, then the day checks, for each day that was read in full and is on or after the floor.
    for (const date of dates) {
      if (!readOk.has(date) || date.localeCompare(POS_BRIDGE_WRITE_FLOOR) < 0) continue;
      const when = safeHumanDate(date);
      try {
        const result = await withOrgPrincipal(org.id, async (tx) => {
          const gone = await posBridgeRepo.markGone(tx, { ...store, posCalendarDate: date, seenDocIds: seen });
          const net = await posBridgeRepo.dayNet(tx, org.id, link.storeId, date);
          const feed = await posBridgeRepo.dayFeedTotalCentavos(tx, org.id, link.storeId, date);
          const diff = feed === null ? null : net.netSalesCentavos - feed;
          const outcome = diff === null ? 'pending' : Math.abs(diff) > Math.max(1, net.receiptCount) ? 'mismatch' : 'match';
          await posBridgeRepo.upsertDayCheck(tx, {
            orgId: org.id,
            storeId: link.storeId,
            posStoreId: link.posStoreId,
            posCalendarDate: date,
            receiptCount: net.receiptCount,
            netSalesCentavos: net.netSalesCentavos,
            feedTotalCentavos: feed,
            differenceCentavos: diff,
            result: outcome,
          });
          return { gone, outcome, net: net.netSalesCentavos, feed, diff };
        });
        goneCount += result.gone;
        checksWritten += 1;
        if (result.outcome === 'mismatch') {
          failures.push(
            line(
              `${when}: the receipts copied from POS add up to ${pesos(result.net)} but POS's day total is ${pesos(result.feed!)} (${pesos(result.diff!)} apart). ` +
                `This is a note, not a failure: the day feed stays the figure until someone checks it.`,
              'notice',
            ),
          );
        }
      } catch (e) {
        logger.warn({ storeId: link.storeId, date, err: reasonOf(e) }, 'posReceiptBridgeSweep: the gone/check step failed');
        failures.push(line(`${when}: the day check could not be written: ${reasonOf(e)}`));
      }
    }
  }

  const realFailures = failures.filter((f) => f.kind !== 'notice').length;
  return {
    posted,
    skipped: unchanged + raced + belowFloor,
    failures,
    read,
    detail:
      `${dryRun ? 'dry run - would write' : 'wrote'} ${posted} - already there ${unchanged}` +
      `${raced > 0 ? ` - ${raced} written by another run first` : ''}` +
      ` - before 1 Jan 2027 (read, not written) ${belowFloor} - gone ${goneCount} - day checks ${checksWritten} - read ${read} - stores ${storesVisited} - refused ${realFailures}`,
  };
}

async function writeOne(
  tx: Tx,
  store: { orgId: string; storeId: string; posStoreId: string },
  r: BridgeSourceReceipt,
  fallbackDate: string | null,
  tenderIds: ReadonlyMap<string, string>,
  dryRun: boolean,
): Promise<WriteResult> {
  const date = r.header.posCalendarDate ?? fallbackDate;
  if (!date) return 'unplaceable';
  // The floor applies to WRITES only; a dry run shows what 1 Jan would copy, so it ignores it.
  if (!dryRun && date.localeCompare(POS_BRIDGE_WRITE_FLOOR) < 0) return 'below_floor';
  const { header, lines, tenders } = toRows(store, r, date, tenderIds);
  if (dryRun) return (await posBridgeRepo.wouldWrite(tx, header)) ? 'written' : 'unchanged';
  return posBridgeRepo.writeVersion(tx, header, lines, tenders);
}
