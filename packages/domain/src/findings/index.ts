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
