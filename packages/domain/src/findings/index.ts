/**
 * Integrity findings — the standing books watchdog. T-135.
 * `docs/tasks/135-integrity-findings.md`.
 *
 * ⭐ **A finding is DERIVED on every read. Only the acknowledgement is stored.**
 *
 * v1 stores a finding's state, so resolving one suppresses the symptom while the cause survives —
 * and the longer it stays resolved, the more confident the suppression looks. Here a finding
 * disappears only when its condition does.
 *
 * ⛔ **This module never writes to the ledger.** Every detector is a question, not a correction.
 */
import { daysBetweenDates, findingsRepo, manilaToday, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
// ⭐ Reused, not redefined. T-140 already owns "the last COMPLETED month" and the scorecard must
// observe exactly the month the screen shows, or the two disagree about what was ever asked.
import { lastCompletedPeriod } from '../scheduler';
// ⛔ T-332 — `payoutIntervalTooLong` needs the real period/payout math, and a repo file may not
// import this package (ADR-004), so the arithmetic lives here rather than in `findings.ts`.
import { derivePeriods, payoutDateFor, type PeriodConfig, type PayoutConfig } from '../payroll/periods';
// T-345 §3.3 — one question ("does every active subject owing P have an effective entry for it"),
// shared with `bookMissedMonth`'s own screen list, so the close check and the screen can never
// disagree about which month still counts as missing.
import { periodFullyCovered } from '../missed-months';

/** ⭐ An accepted risk should be re-accepted, not forgotten. */
export const ACKNOWLEDGEMENT_DAYS = 30;

export type FindingStatus = 'open' | 'acknowledged';

export interface Finding {
  kind: string;
  key: string;
  storeId: string | null;
  severity: 'hard' | 'soft';
  detail: string;
  status: FindingStatus;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  acknowledgementExpiresAt: Date | null;
  /** ⚠️ Days since it was accepted. The number is the point: an ageing acceptance is a smell. */
  acknowledgementAgeDays: number | null;
}

export interface FindingsFeed {
  findings: Finding[];
  /** ⭐ Acknowledged findings are STILL COUNTED — that is the difference from "resolved". */
  openCount: number;
  acknowledgedCount: number;
  hardCount: number;
}

/**
 * `payoutIntervalTooLong` — T-332 §4.3, amended A1.1/A1.13. Not a spread of a `findingsRepo`
 * detector like every other entry below, and that asymmetry is deliberate: `findings.ts`'s
 * `liveCadenceConfigs` only fetches (ADR-004 — a repo may not import this package), and
 * `derivePeriods`/`payoutDateFor` live here, so the arithmetic that decides compliance has to run
 * on this side of the boundary. `findings.ts`'s `payoutIntervalFinding` still owns the ceiling
 * (Labor Code Art. 103) and the operator-facing wording, so that stays with every other
 * detector's, even though this one computes the number that function judges.
 *
 * ⭐ **Computed from the real functions, never from `payrollPeriodType` alone** (DEF-409): a
 * `semi_monthly` store on `fixed_days` with a single-entry `payoutDays` collapses both of a
 * month's periods onto the SAME payout day, 28+ days after the previous one — a label-only check
 * would call it compliant and be wrong.
 *
 * ⛔ **Twelve consecutive months, not two.** A two-month window gets the VERDICT right but not
 * the NUMBER: `maxGapDays` is a property of the CONFIGURED cadence — its worst case across a full
 * annual cycle — not of whichever two months happened to be examined. The same DEF-409 config
 * reports 31 in Sep/Oct and 28 in Jan/Feb under a two-month window; the configured worst case is
 * 31 (`t332-payday-compliance.test.ts` case 5, pre-registered). A stored acknowledgement is keyed
 * on `storeId` alone, with no window in it, so a number that moved with the calendar would let an
 * acknowledgement taken against one figure silently cover a different one. `periodIndex` resets
 * to 0 per calendar month, matching the convention case 5 states: how a per-store, per-month
 * detector actually calls `payoutDateFor`.
 *
 * ⭐ **The VERDICT (fires or not) genuinely is calendar-independent, and that is a separate,
 * narrower claim than the number — worth keeping, because it explains why any twelve-month
 * window agrees with any other.** In `lag` mode the two candidate gaps are `last − cutoff`
 * (inside a month) and `cutoff` (across the boundary, constant); the first is worst in a 31-day
 * month, and every pair of consecutive months contains one — so whether it fires never depends on
 * which months were checked, only the exact number does. Probed directly: cutoff 15 and 16 never
 * fire in any window; cutoff 14 fires in every window; cutoff 17 fires on the cross-boundary gap
 * alone; `[10]`, `[10,25]`, `[5,20]`, `[1,17]`, `[31]` all agreed in Sep/Oct and Jan/Feb. The
 * NUMBER those same configs report is exactly what moved, which is why it is now swept over all
 * twelve months rather than read off two.
 */
async function payoutIntervalFindings(tx: Tx, orgId: string): Promise<findingsRepo.DetectedFinding[]> {
  const [today, configs] = await Promise.all([
    manilaToday(tx),
    findingsRepo.liveCadenceConfigs(tx, orgId),
  ]);
  const [startYear, startMonth] = today.split('-').map(Number) as [number, number, number];

  // Twelve consecutive months from "now" — pure arithmetic, no extra query. ⭐ The starting point
  // is window-independent BY CONSTRUCTION, not merely observed to be: any twelve consecutive
  // months contain exactly one of each calendar month, so every window has the identical
  // multiset of month lengths — seven 31s, four 30s, one February. The only variation is a leap
  // February (29 rather than 28), and a longer February can only lengthen FEBRUARY'S OWN gaps,
  // which are never the maximum for any cadence that reaches the ceiling. So the reported number
  // cannot depend on which month is "now".
  const months: [number, number][] = [];
  let y = startYear;
  let m = startMonth;
  for (let i = 0; i < 12; i++) {
    months.push([y, m]);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  const findings: findingsRepo.DetectedFinding[] = [];
  for (const cfg of configs) {
    const periodConfig: PeriodConfig = {
      payrollPeriodType: cfg.payrollPeriodType,
      semiMonthlyCutoffDay: cfg.semiMonthlyCutoffDay,
    };
    const payoutConfig: PayoutConfig = {
      payoutMode: cfg.payoutMode,
      payoutLagDays: cfg.payoutLagDays,
      payoutDays: cfg.payoutDays,
    };

    const payoutDates: string[] = [];
    for (const [y2, m2] of months) {
      derivePeriods(periodConfig, y2, m2).forEach((period, periodIndex) => {
        payoutDates.push(payoutDateFor(period, payoutConfig, periodIndex));
      });
    }

    const distinct = [...new Set(payoutDates)].sort();
    let maxGapDays = 0;
    for (let i = 1; i < distinct.length; i++) {
      maxGapDays = Math.max(maxGapDays, daysBetweenDates(distinct[i - 1]!, distinct[i]!));
    }

    const finding = findingsRepo.payoutIntervalFinding({
      storeId: cfg.storeId,
      storeName: cfg.storeName,
      maxGapDays,
    });
    if (finding) findings.push(finding);
  }
  return findings;
}

/**
 * T-345 §3.3 — drops `depreciationNotBooked:P` / `amortisationNotBooked:P` once every active
 * subject that owes P has an effective entry keyed for it (the run's own posting, or an adjustment
 * naming P — `periodFullyCovered` does not care which). It is a filter over the ONE feed
 * `periodicPostingsMissed` already produced, never a second computation of the same question.
 */
async function periodicPostingsStillMissing(
  tx: Tx,
  orgId: string,
  findings: findingsRepo.DetectedFinding[],
): Promise<findingsRepo.DetectedFinding[]> {
  const out: findingsRepo.DetectedFinding[] = [];
  for (const f of findings) {
    const schedule =
      f.kind === 'depreciationNotBooked' ? 'depreciation' : f.kind === 'amortisationNotBooked' ? 'amortisation' : null;
    const period = schedule ? keyPeriod(f.key) : null;
    if (!schedule || !period || !(await periodFullyCovered(tx, orgId, schedule, period))) {
      out.push(f);
    }
  }
  return out;
}

/**
 * Every condition that currently holds, with its acknowledgement if it has a live one.
 *
 * ⚠️ `period` is the month the periodic-posting detectors ask about — normally the last completed
 * one. It is a parameter rather than derived here so a close checker can ask about the month it is
 * closing, which is the same machine looking at a different month (task spec: the close checker
 * and the findings feed are ONE machine, or they will disagree on the 15th).
 */
export async function listFindings(
  tx: Tx,
  orgId: string,
  options: { period: string },
): Promise<FindingsFeed> {
  const detected = [
    ...(await findingsRepo.trialBalanceDrift(tx, orgId)),
    ...(await findingsRepo.reciprocalDrift(tx, orgId)),
    ...(await findingsRepo.unpartiedControlLines(tx, orgId)),
    ...(await findingsRepo.openingBalanceResidual(tx, orgId)),
    ...(await findingsRepo.clearingNotAtRest(tx, orgId)),
    ...(await periodicPostingsStillMissing(
      tx,
      orgId,
      await findingsRepo.periodicPostingsMissed(tx, orgId, options.period),
    )),
    // T-152 — cash sitting somewhere it should not be. Row 129's ceiling and cadence, plus
    // DEF-082's service-charge float, which nothing can currently discharge.
    ...(await findingsRepo.unremittedCeilingBreached(tx, orgId)),
    ...(await findingsRepo.remittanceOverdue(tx, orgId)),
    ...(await findingsRepo.serviceChargeFloatAgeing(tx, orgId)),
    // T-153 — a till float not holding its configured amount.
    ...(await findingsRepo.tillFloatOffTarget(tx, orgId)),
    // T-186 — a CLOSED shift whose physical count did not match the ledger. ⚠️ Deliberately
    // adjacent to the line above: they look identical as a number and mean opposite things,
    // and only one of them names somebody who owes money.
    ...(await findingsRepo.tillCountVarianceOpen(tx, orgId)),
    // T-175 — a buyer store consuming items it has never set a reorder threshold for. ⭐ The
    // replacement for v1's forcing function: nag the manager who can act, never block the cook
    // who cannot.
    ...(await findingsRepo.itemsMissingThreshold(tx, orgId)),
    // T-167 — a room-to-room transfer dispatched but never received.
    ...(await findingsRepo.stuckStockTransfer(tx, orgId)),
    // T-170 — a supplier return credit sitting unspent.
    ...(await findingsRepo.supplierCreditAgeing(tx, orgId)),
    // ⭐ T-199 — the sweep's alarm. Detects the missing OUTCOME, not the missing run, so it is
    // true even when the sweep is dead. A "did the cron fire?" check needs a cron to ask it.
    ...(await findingsRepo.openShiftsStale(tx, orgId)),
    // ⭐ T-165 invariant 1 — Phase 3's own exit gate. `/inventory` renders the same comparison
    // per store; this is the org-wide sweep that does not need someone to open the screen.
    ...(await findingsRepo.inventoryControlDoesNotMatchValuation(tx, orgId)),
    // T-179 — a customer store credit sitting unredeemed. The AR mirror of supplierCreditAgeing.
    ...(await findingsRepo.customerCreditAgeing(tx, orgId)),
    // DEF-157 — a reimbursement owed to an employee, sitting unpaid on 2130.
    ...(await findingsRepo.reimbursablePayableAgeing(tx, orgId)),
    // DEF-159 — a cash-request float released and never liquidated.
    ...(await findingsRepo.cashRequestFloatAgeing(tx, orgId)),
    // ⭐ T-178 — the tell that the 15-day order-wastage backstop is not running: a wastage a
    // scheduled run should have closed and did not.
    ...(await findingsRepo.orderWastageOpenPastBackstop(tx, orgId)),
    // ⭐ T-177 §2 — the one Phase 3 failure inventoryControlDoesNotMatchValuation cannot catch: a
    // verified sales day with no finalized POS usage pull.
    ...(await findingsRepo.posUsagePullNotRun(tx, orgId)),
    // T-213 — OIL wave 2, the operational detectors Phases 2-5 made computable.
    ...(await findingsRepo.salesDayUnposted(tx, orgId)),
    ...(await findingsRepo.expenseCategoryUnpostable(tx, orgId)),
    ...(await findingsRepo.expenseInvoiceVoidedAfterLink(tx, orgId)),
    ...(await findingsRepo.receiptPriceSpike(tx, orgId)),
    ...(await findingsRepo.newVendorFirstPurchase(tx, orgId)),
    // Extends cashRequestFloatAgeing above — reads the 1230 account directly, not just the
    // cash_requests document, so a salary advance or a till-shortage charge ages too.
    ...(await findingsRepo.advanceUnliquidated(tx, orgId)),
    // The exact complement of posUsagePullNotRun above: a store with no active POS mapping at
    // all, so that detector's own gate never looks at it.
    ...(await findingsRepo.usageRecordMissing(tx, orgId)),
    ...(await findingsRepo.meatSlabStale(tx, orgId)),
    // ⭐ T-218 / DEF-176 — the receiving-dispute twin of orderWastageOpenPastBackstop above. The
    // phase-6 plan §6 Q3 closed one of Ian's open questions by promising this detector as part of
    // T-213; T-213 shipped without it, and the gap stayed invisible because both tasks read as
    // done. 4 of 9 live disputes are already past 15 days.
    ...(await findingsRepo.receivingDisputeOverdue(tx, orgId)),
    // ⛔ T-220 / DEF-184 — goods signed for that never reached a stock balance. `confirmReceipt`
    // detected this all along and returned it in `unitMismatches`, which every production caller
    // discarded; this is the surfacing that was specified in T-173 §6 and never built.
    ...(await findingsRepo.commissaryUnitMismatch(tx, orgId)),
    // ⭐ T-220 / DEF-185 — T-163's deferred detector. Its blocker ("no receipt document yet to age")
    // was removed when T-166 shipped delivery documents, and nothing re-checked the deferral.
    ...(await findingsRepo.grniNotAtRest(tx, orgId)),
    // ⭐ T-224 — DEF-186's durable half. T-223 wired the auto-order and reports a failure on the
    // screen of whoever posted; a screen message dies with the request. This is the persisted
    // consequence: below threshold, at a store that CAN order, with nothing on order for it.
    ...(await findingsRepo.lowStockOrderNotProposed(tx, orgId)),
    // ⭐ T-264 / DEF-284 slice 1 — periods are seeded a year at a time, on purpose (lazy/scheduled
    // creation are both rejected traps, see the task spec); this is what stops that from becoming
    // a silent outage twelve months out instead of today's.
    ...(await findingsRepo.fiscalPeriodRunwayLow(tx, orgId)),
    // ⭐ T-332 — DEF-409: a store's configured pay cycle cannot satisfy Labor Code Art. 103's
    // sixteen-day ceiling. Computed from `derivePeriods`/`payoutDateFor`, not the cadence label —
    // see `payoutIntervalFindings`'s own comment for why this is not a `findingsRepo` spread.
    ...(await payoutIntervalFindings(tx, orgId)),
    // The exact complement of the line above (A1.5): a store with no live config has no cadence
    // to judge, so DEF-249's state is a second detector, not a branch inside the first.
    ...(await findingsRepo.attendanceConfigMissing(tx, orgId)),
  ];

  const acks = await findingsRepo.liveAcknowledgements(tx, orgId);
  const now = Date.now();

  const findings: Finding[] = detected.map((d) => {
    const ack = acks.get(d.key);
    return {
      ...d,
      status: ack ? 'acknowledged' : 'open',
      acknowledgedBy: ack?.acknowledgedBy ?? null,
      acknowledgedAt: ack?.acknowledgedAt ?? null,
      acknowledgementExpiresAt: ack?.expiresAt ?? null,
      acknowledgementAgeDays: ack
        ? Math.floor((now - ack.acknowledgedAt.getTime()) / 86_400_000)
        : null,
    };
  });

  return {
    findings,
    openCount: findings.filter((f) => f.status === 'open').length,
    // ⭐ Counted, not hidden. An acknowledged finding is still a thing that is wrong.
    acknowledgedCount: findings.filter((f) => f.status === 'acknowledged').length,
    hardCount: findings.filter((f) => f.severity === 'hard').length,
  };
}

/**
 * *"I have seen this and accept it for now."*
 *
 * ⛔ Deliberately NOT called `resolve`. Nothing here makes the condition go away, and if the
 * condition goes away on its own the finding vanishes without this ever being called.
 */
export async function acknowledgeFinding(
  tx: Tx | null,
  actor: Actor,
  input: { findingKey: string; note?: string | null; period: string },
): Promise<{ expiresAt: Date }> {
  const run = async (trx: Tx) => {
    const feed = await listFindings(trx, actor.orgId, { period: input.period });
    const finding = feed.findings.find((f) => f.key === input.findingKey);
    // ⭐ You cannot acknowledge something that is not true. Without this, an acknowledgement could
    // be planted ahead of a condition and suppress it the moment it appeared.
    if (!finding) {
      throw new Error(
        `acknowledgeFinding: ${input.findingKey} is not currently a finding. Either it was already ` +
          'fixed, or it never held — there is nothing to accept.',
      );
    }

    // Manager for their store; an org-wide finding needs the org-wide gate.
    await authorize(trx, actor, 'close_period', finding.storeId ? { storeId: finding.storeId } : {});

    const expiresAt = new Date(Date.now() + ACKNOWLEDGEMENT_DAYS * 86_400_000);
    await findingsRepo.insertAcknowledgement(trx, {
      orgId: actor.orgId,
      storeId: finding.storeId,
      findingKey: finding.key,
      kind: finding.kind,
      note: input.note?.trim() || null,
      acknowledgedBy: actor.personId,
      expiresAt,
    });
    return { expiresAt };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ The close-readiness list is a FILTER over the same feed, never a second computation.
 *
 * Building them separately would give two rule engines that disagree — and the disagreement would
 * surface on the 15th, in the middle of a close.
 */
export async function closeReadiness(
  tx: Tx,
  orgId: string,
  period: string,
): Promise<{ ready: boolean; blocking: Finding[] }> {
  const feed = await listFindings(tx, orgId, { period });
  // ⚠️ An acknowledged HARD finding still blocks. Accepting a risk is not the same as the books
  // adding up, and a close is exactly the moment that distinction matters.
  const blocking = feed.findings.filter((f) => f.severity === 'hard');
  return { ready: blocking.length === 0, blocking };
}

// ---------------------------------------------------------------------------------------------
// T-214 — the observation job, the scorecard, and the view log
// ---------------------------------------------------------------------------------------------

/** v1's 14-day scale, kept verbatim: a finding cleared in 14+ days scores zero for speed. */
export const SPEED_HORIZON_DAYS = 14;
/** ⭐ v1's raw weights. Kept, and normalised over PRESENT parts — see `compositeScore`. */
export const WEIGHT_CLEAR_RATE = 0.4;
export const WEIGHT_SPEED = 0.3;

/**
 * The period a key is ABOUT, or null when it is not period-scoped.
 *
 * ⛔ This is what stops the month-boundary bug. Periodic detectors embed the month in the key
 * (`depreciationNotBooked:2026-08`), so a run asking about September never gets August's key back —
 * and closing it on that basis would record August's unbooked depreciation as FIXED. Nobody fixed
 * anything; the month stopped being asked about.
 *
 * ⚠️ A store-scoped key ends in a uuid, which cannot match a `YYYY-MM` suffix, so this test is
 * unambiguous against every key shape in `repo/findings.ts` today.
 */
export function keyPeriod(findingKey: string): string | null {
  const m = /:(\d{4}-\d{2})$/.exec(findingKey);
  return m ? m[1]! : null;
}

export interface ObservationResult {
  readonly periodsAsked: string[];
  readonly observed: number;
  readonly opened: number;
  readonly closed: number;
}

/**
 * ⭐ **T-214's daily job — record that each detector fired today, and close what stopped firing.**
 *
 * ⛔ **This is an observation, never finding state.** Nothing in the detection path reads what this
 * writes; `listFindings` is called here, not the other way round. Delete every row it produces and
 * the feed is identical — which an integration test asserts rather than this comment promising it.
 *
 * ## The closure rule, and the bug it exists to prevent
 *
 * A run asks about `lastCompletedPeriod()` **plus every earlier period that still has an open
 * period-scoped occurrence** — bounded, and it shrinks as things get booked. An occurrence is closed
 * only when the run **actually asked its question** and did not get it back. Without that, every
 * month boundary would silently mark the previous month's unbooked depreciation as cleared and
 * inflate the clear rate on exactly the `hard` findings that matter most.
 */
export async function recordFindingObservations(
  tx: Tx,
  orgId: string,
  now = new Date(),
): Promise<ObservationResult> {
  const open = await findingsRepo.openOccurrences(tx, orgId);

  // Ask about the current question, plus any older month still carrying an open occurrence.
  const periods = new Set<string>([lastCompletedPeriod(now)]);
  for (const o of open) {
    const p = keyPeriod(o.findingKey);
    if (p) periods.add(p);
  }
  const periodsAsked = [...periods].sort();

  const seen = new Map<string, { storeId: string | null; kind: string }>();
  for (const period of periodsAsked) {
    const feed = await listFindings(tx, orgId, { period });
    for (const f of feed.findings) seen.set(f.key, { storeId: f.storeId, kind: f.kind });
  }

  const openKeys = new Set(open.map((o) => o.findingKey));
  for (const [key, meta] of seen) {
    await findingsRepo.observeFinding(tx, {
      orgId,
      storeId: meta.storeId,
      findingKey: key,
      kind: meta.kind,
    });
  }

  let closed = 0;
  for (const o of open) {
    if (seen.has(o.findingKey)) continue;
    // ⛔ The guard. Only a run that asked this key's question may close it.
    const p = keyPeriod(o.findingKey);
    if (p && !periods.has(p)) continue;
    await findingsRepo.closeOccurrence(tx, o.id);
    closed += 1;
  }

  let opened = 0;
  for (const key of seen.keys()) if (!openKeys.has(key)) opened += 1;

  return { periodsAsked, observed: seen.size, opened, closed };
}

export interface StoreScore {
  readonly storeId: string | null;
  readonly raised: number;
  readonly cleared: number;
  readonly stillOpen: number;
  /** ⭐ Still open but too young to count against the store yet — see `GRACE_DAYS`. */
  readonly pending: number;
  readonly clearRate: number | null;
  readonly avgDaysToClear: number | null;
  readonly speedScore: number | null;
  /** ⚠️ **Null, never 0**, when there is nothing to judge. Zero says "responded badly". */
  readonly score: number | null;
  /** ⚠️ Reported, NEVER scored — see `managerScorecard`. */
  readonly acknowledged: number;
  readonly oldestAcknowledgementDays: number | null;
}

export interface Scorecard {
  readonly from: string;
  readonly to: string;
  /** ⛔ Null until the job has run once. The screen MUST disclose it — there is no backfill. */
  readonly recordBeganOn: string | null;
  readonly stores: StoreScore[];
  readonly lastViewedBy: string | null;
  readonly lastViewedDaysAgo: number | null;
}

/**
 * ⭐ v1's own normalisation, with the briefing part simply not pushed.
 *
 * v1 builds `parts` from whichever components are non-null and divides by their weight sum, so
 * "two components re-weighted, not three with a permanently-zero term" needs **no new arithmetic** —
 * it needs the third part left out. ⛔ Do NOT restate the weights as 0.5/0.5: that silently
 * re-decides a ratio nobody asked to change. Action is 1.33x speed, as it was in v1 — 57/43.
 */
export function compositeScore(clearRate: number | null, speedScore: number | null): number | null {
  const parts: Array<[number, number]> = [];
  if (clearRate != null) parts.push([WEIGHT_CLEAR_RATE, clearRate]);
  if (speedScore != null) parts.push([WEIGHT_SPEED, speedScore]);
  const wsum = parts.reduce((a, [w]) => a + w, 0);
  if (wsum === 0) return null;
  return Math.round((100 * parts.reduce((a, [w, v]) => a + w * v, 0)) / wsum);
}

/**
 * ⭐ **Scores what was FIXED, never what was accepted — and that is the whole design.**
 *
 * The naive port of v1 maps its `resolved` onto v2's `acknowledged`. ⛔ **That re-opens the hole
 * T-135 closed.** Acknowledging means the condition STILL HOLDS and the risk is accepted for 30
 * days; a score counting acknowledgements pays a manager to accept risk, and is maximised by
 * acknowledging everything having fixed nothing.
 *
 * A cleared occurrence needs honesty from nobody: the detector simply stopped returning the key.
 * ⚠️ It also has no actor — nobody clicks anything — which is why the unit of scoring is the STORE
 * and not a person. Acknowledgements are reported beside the score, with their age, because an
 * ageing acceptance is a smell (T-135) and not a credit.
 */
export async function managerScorecard(
  tx: Tx,
  orgId: string,
  range: { from: string; to: string },
): Promise<Scorecard> {
  const rows = await findingsRepo.scorecardByStore(tx, orgId, range.from, range.to);
  const acks = await findingsRepo.liveAcknowledgements(tx, orgId);

  // ⚠️ One clock, read once — the same shape `listFindings` uses for `acknowledgementAgeDays`.
  const now = Date.now();
  const ackByStore = new Map<string | null, { n: number; oldest: number | null }>();
  for (const a of acks.values()) {
    const k = a.storeId ?? null;
    const cur = ackByStore.get(k) ?? { n: 0, oldest: null };
    const age = Math.floor((now - a.acknowledgedAt.getTime()) / 86_400_000);
    ackByStore.set(k, {
      n: cur.n + 1,
      oldest: cur.oldest == null ? age : Math.max(cur.oldest, age),
    });
  }

  const stores: StoreScore[] = rows.map((r) => {
    // ⭐ Only findings that have had a FAIR CHANCE are judged. A finding raised this morning was
    // not ignored — it has not had time to be anything yet — and scoring it as a failure is how
    // the first render of this page told three innocent branches they had responded badly.
    const countable = r.cleared + r.openPastGrace;
    const clearRate = countable > 0 ? r.cleared / countable : null;
    const speedScore =
      r.avgDaysToClear == null
        ? null
        : Math.max(0, Math.min(1, 1 - r.avgDaysToClear / SPEED_HORIZON_DAYS));
    const ack = ackByStore.get(r.storeId) ?? { n: 0, oldest: null };
    return {
      storeId: r.storeId,
      raised: r.raised,
      cleared: r.cleared,
      stillOpen: r.stillOpen,
      pending: r.pending,
      clearRate,
      avgDaysToClear: r.avgDaysToClear,
      speedScore,
      score: compositeScore(clearRate, speedScore),
      acknowledged: ack.n,
      oldestAcknowledgementDays: ack.oldest,
    };
  });

  const view = await findingsRepo.lastFindingView(tx, orgId);
  return {
    from: range.from,
    to: range.to,
    recordBeganOn: await findingsRepo.firstObservationDate(tx, orgId),
    stores,
    lastViewedBy: view?.displayName ?? null,
    lastViewedDaysAgo: view?.daysAgo ?? null,
  };
}

/**
 * ⚠️ A write on a read path, so callers treat it as forgiving: the log is accountability, the page
 * is the work. A failure here must never cost someone the screen they came to use.
 */
export async function logFindingView(tx: Tx, orgId: string, personId: string): Promise<void> {
  await findingsRepo.recordFindingView(tx, { orgId, personId });
}
