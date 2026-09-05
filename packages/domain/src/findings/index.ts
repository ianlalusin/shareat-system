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
import { findingsRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';

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
    ...(await findingsRepo.periodicPostingsMissed(tx, orgId, options.period)),
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
