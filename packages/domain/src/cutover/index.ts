/**
 * The 31 December conversion — a guided, verified switch. T-134.
 * `docs/tasks/134-cutover-wizard.md`.
 *
 * ⭐ **It is a CONVERSION, not an onboarding wizard**, and it runs twice: a November rehearsal
 * against a restored database, then the real thing.
 *
 * ⛔ **No rehearsal flag exists anywhere.** ADR-007 provides the isolation; a flag is a marker a
 * code path can forget to set, and a forgotten one produces a rehearsal attestation
 * indistinguishable from a real one.
 *
 * ⛔ **A 3900 residual HALTS.** There is no plug account and no code path that creates one.
 * Auto-plugging to suspense is the majority behaviour in the field — Xero's *"Ask My Accountant"*,
 * Odoo's balancing line, GnuCash's `Imbalance-` — and it is **scale-driven**: those vendors serve
 * millions of self-serve tenants who cannot get a human's attention for every mismatch. One
 * company, one cutover, Ian personally available: none of that constraint applies.
 *
 * ⭐ But borrow the useful half. C3 shows a **running residual the whole time you are entering** —
 * that is the early warning the plug account actually buys, without the escape hatch. *An
 * imbalance found on the tenth supplier is a typo; the same imbalance found after the last one is
 * an investigation.*
 */
import { cutoverRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { CUTOVER_STEPS, gatesBefore, stepDef, type StepDef } from './steps';

export * from './steps';
export * from './opening';

export interface StepState {
  def: StepDef;
  storeId: string | null;
  done: boolean;
  completion: 'verified' | 'attested' | 'performed' | null;
  completedBy: string | null;
  completedAt: Date | null;
  /** ⚠️ Rendered beside an attestation so it never reads like a verified tick. */
  machineVerifiable: boolean;
  /** Null when nothing blocks it. Otherwise the reason, phrased as what to go and do. */
  blockedBy: string | null;
  /** Why this check does not currently hold — the guide half, not just a red mark. */
  detail: string | null;
}

export interface CutoverProgress {
  steps: StepState[];
  doneCount: number;
  totalCount: number;
  byPhase: Record<string, { done: number; total: number }>;
  /** ⭐ Visible throughout C3, not revealed at C4. */
  openingResidual: string;
  trialBalanceDrift: string;
}

/**
 * Where the conversion stands, derived on every read.
 *
 * ⚠️ **Blocked steps show as BLOCKED with the reason** — *"B1 waits on A1"* tells you what to go
 * and do. Hidden steps do not.
 */
export async function cutoverProgress(
  tx: Tx,
  orgId: string,
  storeIds: string[],
): Promise<CutoverProgress> {
  const recorded = await cutoverRepo.recordedSteps(tx, orgId);
  const key = (code: string, storeId: string | null) => `${code}:${storeId ?? ''}`;
  const byKey = new Map(recorded.map((r) => [key(r.stepCode, r.storeId), r]));

  const residual = await cutoverRepo.openingEquityResidual(tx, orgId);
  const drift = await cutoverRepo.trialBalanceDrift(tx, orgId);

  const steps: StepState[] = [];
  for (const def of CUTOVER_STEPS) {
    const targets: (string | null)[] = def.perStore ? storeIds : [null];
    for (const storeId of targets) {
      const row = byKey.get(key(def.code, storeId));
      let done = Boolean(row);
      let detail: string | null = null;

      // ⭐ A verified step is decided by the QUERY, never by the row. A recorded row cannot make a
      // failing check pass — that is invariant 1, and the whole difference from a checklist.
      if (def.kind === 'verified' && !def.cannotVerifyHere) {
        const check = await evaluate(tx, orgId, def.code, storeId);
        done = check.holds;
        detail = check.detail;
      }

      steps.push({
        def,
        storeId,
        done,
        completion: row?.completion ?? null,
        completedBy: row?.completedBy ?? null,
        completedAt: row?.completedAt ?? null,
        machineVerifiable: def.kind === 'verified' && !def.cannotVerifyHere,
        blockedBy: null,
        detail,
      });
    }
  }

  // Gates, resolved after every step's own state is known.
  //
  // ⭐ **A blocked step is never done, even when its own check passes.** That is not bookkeeping
  // tidiness — it is the whole reason the gates exist. C4 asks whether 3900 nets to zero, and on an
  // EMPTY ledger it trivially does: nothing has been entered, so nothing is unbalanced. A vacuous
  // pass is exactly the false green the gate is there to prevent, and it is the same shape as
  // ADR-009's inversion, where counting before the backlog was cleared produced a confident wrong
  // number rather than an error.
  for (const s of steps) {
    for (const gate of gatesBefore(s.def.code)) {
      const prerequisites = steps.filter((x) => x.def.code === gate.after);
      const unmet = prerequisites.filter((x) => !x.done);
      if (unmet.length > 0) {
        s.blockedBy = `${s.def.code} waits on ${gate.after}. ${gate.because}`;
        s.done = false;
        break;
      }
    }
  }

  const byPhase: Record<string, { done: number; total: number }> = {};
  for (const s of steps) {
    const p = (byPhase[s.def.phase] ??= { done: 0, total: 0 });
    p.total += 1;
    if (s.done) p.done += 1;
  }

  return {
    steps,
    doneCount: steps.filter((s) => s.done).length,
    totalCount: steps.length,
    byPhase,
    openingResidual: residual,
    trialBalanceDrift: drift,
  };
}

/** The six ✅ checks, each a query over real state. */
async function evaluate(
  tx: Tx,
  orgId: string,
  code: string,
  storeId: string | null,
): Promise<{ holds: boolean; detail: string | null }> {
  if (code === 'B3') {
    if (!storeId) return { holds: false, detail: 'B3 is per store.' };
    const missing = await cutoverRepo.itemsWithoutCount(tx, orgId, storeId);
    return missing.length === 0
      ? { holds: true, detail: null }
      : {
          holds: false,
          detail:
            `${missing.length} active item(s) have no counted quantity here — ` +
            `${missing.slice(0, 3).map((m) => m.name).join(', ')}${missing.length > 3 ? '…' : ''}. ` +
            'Enter an explicit zero if that is the answer.',
        };
  }
  if (code === 'C4') {
    const residual = await cutoverRepo.openingEquityResidual(tx, orgId);
    return Math.abs(Number(residual)) < 0.005
      ? { holds: true, detail: null }
      : {
          holds: false,
          detail: `3900 carries ₱${residual}. ⛔ This halts — there is no plug account.`,
        };
  }
  return { holds: false, detail: null };
}

/**
 * ✍️ *"I state that this is done."*
 *
 * ⚠️ Records a named person and a timestamp, and the step renders as **not machine-verifiable**.
 * That honesty is the point: a green tick identical to a verified one would be a lie.
 */
export async function attestStep(
  tx: Tx | null,
  actor: Actor,
  input: { stepCode: string; storeId?: string | null; note?: string | null },
): Promise<void> {
  const run = async (trx: Tx) => {
    const def = stepDef(input.stepCode);
    if (!def) throw new Error(`attestStep: ${input.stepCode} is not a cutover step.`);

    // ⛔ A verified step cannot be ticked by hand. Invariant 1, enforced rather than described.
    if (def.kind === 'verified' && !def.cannotVerifyHere) {
      throw new Error(
        `attestStep: ${def.code} is a verified step — a query decides it, and it cannot be ticked ` +
          'by hand. Fix the thing it is checking.',
      );
    }
    if (def.perStore && !input.storeId) {
      throw new Error(`attestStep: ${def.code} is per store, and a single tick would hide a store nobody visited.`);
    }
    const storeId = def.perStore ? input.storeId! : null;
    await authorize(trx, actor, 'run_cutover', storeId ? { storeId } : {});

    await cutoverRepo.recordStep(trx, {
      orgId: actor.orgId,
      storeId,
      stepCode: def.code,
      completion: 'attested',
      note: input.note?.trim() || null,
      completedBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Enter, or correct, a counted quantity. ⭐ Zero is a real answer and must be entered on purpose. */
export async function recordOpeningCount(
  tx: Tx | null,
  actor: Actor,
  input: { storeId: string; itemId: string; quantity: string; unitCost?: string | null; note?: string | null },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_cutover', { storeId: input.storeId });
    if (Number(input.quantity) < 0) throw new Error('recordOpeningCount: a count cannot be negative.');
    await cutoverRepo.upsertOpeningCount(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      itemId: input.itemId,
      quantity: input.quantity,
      unitCost: input.unitCost ?? null,
      note: input.note?.trim() || null,
      countedBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface OpeningGaps {
  /** Counted, but nobody can value it. */
  countsWithoutCost: { itemId: string; name: string; storeId: string }[];
  /** ⛔ The same money entered twice — a lump opening balance AND a re-entered pre-cutover doc. */
  doubleCounted: { partyType: string; partyId: string }[];
  residual: string;
}

/**
 * ⭐ **What is still needed — computed, never a static list.**
 *
 * *This is the difference between a checklist and a guide.* A checklist says "enter opening AR". A
 * guide says "14 suppliers still have no opening figure — here they are."
 *
 * ⚠️ Audited figures are shown as a REFERENCE, never as a default. A pre-filled figure gets
 * accepted without being checked, and the whole point of the count is that someone checks.
 */
export async function openingGaps(
  tx: Tx,
  orgId: string,
  conversionDate: string,
): Promise<OpeningGaps> {
  return {
    countsWithoutCost: await cutoverRepo.countsWithoutCost(tx, orgId),
    doubleCounted: await cutoverRepo.partiesWithOpeningAndPreCutoverDocs(tx, orgId, conversionDate),
    residual: await cutoverRepo.openingEquityResidual(tx, orgId),
  };
}
