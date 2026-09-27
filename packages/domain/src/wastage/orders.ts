/**
 * Order/channel wastage — T-178. `docs/tasks/178-channel-wastage-disposition.md`.
 *
 * ## ⚠️ Read this first: this is NOT stock wastage (T-168)
 *
 * A wasted or refunded CHANNEL ORDER — a Foodpanda order refunded, a dine-in dish remade. This
 * module writes NO stock movement and consumes NO layer. If a future change here touches
 * `stock_layers` or `stock_movements`, the two unrelated "wastage" systems have been conflated —
 * see the schema file's own warning.
 *
 * ## `1220` is the credit in every case that posts (§6)
 *
 * The order was recognised as revenue with a channel receivable behind it (T-123); a wastage
 * answers who ends up bearing it. `platform_paid` posts NOTHING — T-150's settlement already
 * clears `1220` for the day, and posting here too would double-clear it (test 8).
 *
 * ## Phase 5 (staff advances) — the graceful degradation (§6, §11 invariant 10)
 *
 * `charged` (and a multi-person "split" charge — see the schema file's note on why that is the
 * `charged` disposition with several allocations, not a fourth enum value) is refused while
 * `isPhase5StaffAdvancesAvailable()` reads `false`, and the 15-day backstop degrades what would
 * have been a charge to store-absorbed instead — recorded on the posted entry's own memo, never
 * silently. ⚠️ **Read the flag's own comment** — the mechanical pieces it gates (the `1230`
 * control account and payroll's `outstandingAdvance` recovery) already exist and are already live
 * via T-174's identical charge shape; this is a deliberate policy gate, not a missing capability,
 * and is called out in the task report as a finding for the coordinator to weigh.
 */
import { add, multiply, subtract, ZERO, money, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import {
  channelSettlementsRepo,
  orderWastageRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import type { Outcome } from '../commissary/outcome';

/** T-164/T-174's account for a real cost, straight against the channel receivable. */
export const WASTAGE_ABSORBED_ACCOUNT = '5300';
/** ⚠️ A receivable FROM the staffer, `party_type = 'employee'` — never a P&L account. Same
 *  account and party shape T-174 already posts to, live. */
export const WASTAGE_STAFF_CHARGE_ACCOUNT = '1230';

/**
 * ⛔ **Deliberately `false` today.** The spec's own dependency (§6, §11): *"the staff-charge leg
 * needs Phase 5's advance module... refused with a named error"*, and this flag is the ONE place
 * that decision lives — flip it, and `charged`/the backstop's charge tier work with no other
 * change, because the posting shape (`Dr 1230` party=employee) is already exactly what T-174 (a
 * shipped, live module) posts for its own `charge` disposition, and `packages/domain/src/payroll`
 * already recovers whatever sits on `1230` regardless of which module put it there
 * (`PAYROLL_ADVANCE_ACCOUNT`, `outstandingAdvance`). There is no separate "advance disbursement"
 * module missing — the account is a control account whose balance IS the advance. This is
 * recorded here, rather than acted on unilaterally, because the spec's own named test (§9) and
 * done-when item explicitly require the refusal to exist and be tested; see the T-178 task report.
 *
 * ⚠️ A function, not a plain `const` export — test 6 needs to prove the `charged` POSTING SHAPE
 * is correct (`Dr 1230 / Cr 1220`, split by percentage) while test 9 needs to prove the gate
 * REFUSES with Phase 5 absent, and a live-binding ESM const cannot be flipped per-test. The real,
 * production value is the literal `false` immediately below — `__setPhase5AvailableForTests` is
 * for the test file only.
 */
let phase5StaffAdvancesAvailable = false;

export function isPhase5StaffAdvancesAvailable(): boolean {
  return phase5StaffAdvancesAvailable;
}

/**
 * ⚠️ TEST-ONLY. Flips the gate for exactly as long as the caller needs, and returns a function
 * that restores it — call that in a `finally` or `afterEach`. Never called from production code;
 * the module's own logic only ever READS the flag through `isPhase5StaffAdvancesAvailable()`.
 */
export function __setPhase5AvailableForTests(value: boolean): () => void {
  const previous = phase5StaffAdvancesAvailable;
  phase5StaffAdvancesAvailable = value;
  return () => {
    phase5StaffAdvancesAvailable = previous;
  };
}

const CHANNEL_RECEIVABLE_CODE = channelSettlementsRepo.CHANNEL_RECEIVABLE_CODE;
const CHANNEL_PARTY_TYPE = channelSettlementsRepo.PARTY_TYPE;

/** The 15-day clock (invariant 4 — uniform across `open` AND `disputed`). */
export const BACKSTOP_DAYS = 15;
/** Invariant 6 — a manager may undo an auto-charge within this window. */
export const AUTO_CHARGE_REVERSAL_DAYS = 30;

export interface AllocationInput {
  personId: string;
  percent: string;
}

/**
 * Split `amount` by percentage. ⭐ The LAST share is the remainder, never its own multiply — so
 * the shares always sum to EXACTLY `amount`, whatever rounding the earlier shares needed. A
 * single-allocation case (length 1) skips the loop and returns `[amount]` untouched.
 */
function splitByPercent(amount: Money, allocations: AllocationInput[]): Money[] {
  const shares: Money[] = [];
  let running = ZERO;
  for (let i = 0; i < allocations.length - 1; i++) {
    // percent is numeric(5,2) — at most 2 decimal places — so `/100` needs at most 4, well
    // inside toFixed(6)'s safety margin against binary floating-point noise.
    const rate = (Number(allocations[i]!.percent) / 100).toFixed(6);
    const share = multiply(amount, rate);
    shares.push(share);
    running = add(running, share);
  }
  shares.push(subtract(amount, running));
  return shares;
}

interface PostDispositionParams {
  orgId: string;
  storeId: string;
  /** ⭐ T-230 — the party is found BY ID. A rename must not strand an open wastage. */
  channelId: string;
  /** The name as recorded, for the memo only. */
  channel: string;
  amount: string;
  disposition: 'absorbed' | 'charged';
  allocations: AllocationInput[];
  entryDate: string;
  sourceId: string;
  /** `null` for the backstop's own system-triggered postings — `journal_entries.posted_by` is
   *  nullable and reads as "posted by nobody named" (`fixed-assets/depreciate.ts`'s own precedent). */
  postedBy: string | null;
  idempotencySuffix: string;
  memoSuffix: string;
}

/**
 * The one place the posting lives — shared by an `instant` wastage's create-time posting and a
 * `tracked` wastage's resolve-time posting, so the two can never drift into two implementations
 * of the same shape. `platform_paid` never reaches this function — it posts nothing (§6).
 */
async function postDisposition(trx: Tx, p: PostDispositionParams): Promise<{ journalEntryId: string }> {
  const channelRow = await orderWastageRepo.channelById(trx, p.orgId, p.channelId);
  if (!channelRow) {
    throw new Error(
      `order wastage: the '${p.channel}' channel this wastage was recorded against no longer ` +
        'exists — there is nowhere to book the 1220 leg.',
    );
  }

  const amount = money(p.amount);
  const memo = `Order wastage (${p.channel}) — ${p.memoSuffix}`;
  const lines: Parameters<typeof postEntry>[1]['lines'] = [];

  if (p.disposition === 'absorbed') {
    lines.push({ accountCode: WASTAGE_ABSORBED_ACCOUNT, storeId: p.storeId, debit: amount, lineMemo: memo });
  } else {
    if (!isPhase5StaffAdvancesAvailable()) {
      throw new Error(
        "order wastage: 'charged' requires Phase 5 (staff advances), which is not yet available — " +
          'refused rather than posting a person into an account nothing can draw down.',
      );
    }
    if (p.allocations.length === 0) {
      throw new Error('order wastage: a charged disposition needs at least one allocation.');
    }
    const shares = splitByPercent(amount, p.allocations);
    p.allocations.forEach((a, i) => {
      lines.push({
        accountCode: WASTAGE_STAFF_CHARGE_ACCOUNT,
        storeId: p.storeId,
        debit: shares[i]!,
        partyType: 'employee',
        partyId: a.personId,
        lineMemo: memo,
      });
    });
  }

  lines.push({
    accountCode: CHANNEL_RECEIVABLE_CODE,
    storeId: p.storeId,
    credit: amount,
    partyType: CHANNEL_PARTY_TYPE,
    partyId: channelRow.id,
    lineMemo: memo,
  });

  const posted = await postEntry(trx, {
    orgId: p.orgId,
    entryDate: p.entryDate,
    sourceType: 'order_wastage',
    sourceId: p.sourceId,
    idempotencyKey: `order_wastage:${p.sourceId}:${p.idempotencySuffix}`,
    memo,
    postedBy: p.postedBy,
    lines,
  });
  return { journalEntryId: posted.entryId };
}

export interface RecordOrderWastageInput {
  storeId: string;
  salesDayId: string;
  /** The channel's NAME as picked on the form. Resolved to a real `sales_channels` row here, at
   *  creation — which is what supplies `channel_id` AND the wastage policy below. */
  channel: string;
  orderRef?: string | null;
  // ⛔ `typeMode` IS DELETED, and its absence is the feature. Bible §13 row 180, Ian 2026-09-07:
  //    the CHANNEL carries the policy and the person recording a loss no longer picks it. While
  //    this field existed, a staffer could mark their own Foodpanda wastage `instant` +
  //    `absorbed` and skip the Wastage Monitor, the 48-hour dispute window and the 15-day
  //    auto-charge backstop in a single click — the control was optional to the person it
  //    controls. ⚠️ Do not re-add it "for tests": `sales_channels.wastage_type_mode` is where a
  //    test says what the policy is, because that is where a store says it.
  amount: string;
  reason: string;
  /** Business date the posting (instant) or the eventual resolution dates against. */
  openedOn: string;
  /** Tracked: an optional explicit seed, overriding the Monitor default (invariant 2). Instant +
   *  `charged`: required. Ignored for instant `absorbed`/`platform_paid`. */
  allocations?: AllocationInput[];
  /**
   * Required exactly when the RESOLVED CHANNEL's policy is `instant`; refused when it is
   * `tracked` (§3 — a tracked wastage awaits a human's disposition decision).
   *
   * ⭐ The recorder still states this, and that is not a hole. A disposition is a FACT about what
   * happened to the money; the mode is the POLICY about whether that fact may be decided on the
   * spot. Row 180 moved the policy, not the fact.
   */
  disposition?: 'platform_paid' | 'absorbed' | 'charged';
}

export interface RecordOrderWastageResult {
  id: string;
  status: 'open' | 'resolved';
  journalEntryId: string | null;
}

/**
 * Create a wastage. Invariant 2: a TRACKED wastage always has a chargeable owner from the moment
 * it exists — the allocated staff if supplied, else the store's Wastage Monitor, seeded here.
 */
export async function recordOrderWastage(
  tx: Tx | null,
  actor: Actor,
  input: RecordOrderWastageInput,
): Promise<RecordOrderWastageResult> {
  const run = async (trx: Tx): Promise<RecordOrderWastageResult> => {
    await authorize(trx, actor, 'record_order_wastage', { storeId: input.storeId });
    if (input.disposition === 'charged') {
      await authorize(trx, actor, 'charge_staff_for_wastage', { storeId: input.storeId });
    }

    // ⭐ T-230 — the channel is resolved HERE, at creation, and this one move does three things:
    // it supplies the `channel_id` pointer, it derives the wastage policy (bible §13 row 180), and
    // it refuses a channel name nothing configured at the moment somebody types it rather than
    // days later when a human tries to resolve the row.
    const channelRow = await orderWastageRepo.findChannelByName(trx, actor.orgId, input.storeId, input.channel);
    if (!channelRow) {
      throw new Error(
        `recordOrderWastage: no '${input.channel}' channel is configured for this store — ` +
          'add it under Settings › Sales channels before recording a wastage against it.',
      );
    }
    if (!channelRow.isActive) {
      throw new Error(
        `recordOrderWastage: '${channelRow.name}' is no longer an active channel at this store, ` +
          'so a new wastage cannot be recorded against it.',
      );
    }

    // ⭐ DERIVED, never supplied — bible §13 row 180.
    const typeMode = channelRow.wastageTypeMode;

    if (typeMode === 'instant' && !input.disposition) {
      throw new Error(
        `recordOrderWastage: '${channelRow.name}' is an instant channel, so this wastage must be ` +
          'recorded with its disposition already decided.',
      );
    }
    if (typeMode === 'tracked' && input.disposition) {
      throw new Error(
        `recordOrderWastage: '${channelRow.name}' is a tracked channel — a tracked wastage awaits ` +
          'a disposition decision and does not take one at creation. Change the wastage policy on ' +
          'that channel under Settings › Sales channels if it should be decided on the spot.',
      );
    }
    const reason = input.reason.trim();
    if (!reason) throw new Error('recordOrderWastage: say why this wastage happened.');
    // DEF-272: was a raw `money()` call — well-formed already, but its TypeError is a developer
    // message, not a written sentence. `parseMoneyInput` is the shared entry point that fixes that.
    const amount = parseMoneyInput(input.amount, 'recordOrderWastage: the amount', 'The wastage amount');
    if (Number(amount) <= 0) throw new Error('recordOrderWastage: amount must be greater than zero.');

    const { id } = await orderWastageRepo.create(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      salesDayId: input.salesDayId,
      channelId: channelRow.id,
      // ⭐ The channel's OWN name, not the string the caller typed — `findChannelByName` matches
      // case- and whitespace-insensitively, so this is what normalises "  foodpanda " to the name
      // the memo will show.
      channel: channelRow.name,
      orderRef: input.orderRef ?? null,
      typeMode,
      amount: input.amount,
      reason,
      createdBy: actor.personId,
    });

    // Invariant 2 — seed the responsible party for a TRACKED wastage. An explicit allocation
    // wins; otherwise the store's Monitor gets 100%. No Monitor configured is the documented
    // exception the backstop's own third fallback tier exists for — not created "ownerless" by
    // omission, just left for that tier to resolve at day 15.
    let allocations = input.allocations ?? [];
    if (typeMode === 'tracked' && allocations.length === 0) {
      const monitor = await orderWastageRepo.wastageMonitorFor(trx, actor.orgId, input.storeId);
      if (monitor) allocations = [{ personId: monitor, percent: '100.00' }];
    }
    if (allocations.length > 0) {
      await orderWastageRepo.replaceAllocations(trx, id, allocations);
    }

    if (typeMode === 'instant') {
      let journalEntryId: string | null = null;
      if (input.disposition !== 'platform_paid') {
        const posted = await postDisposition(trx, {
          orgId: actor.orgId,
          storeId: input.storeId,
          channelId: channelRow.id,
          channel: channelRow.name,
          amount: input.amount,
          disposition: input.disposition as 'absorbed' | 'charged',
          allocations,
          entryDate: input.openedOn,
          sourceId: id,
          postedBy: actor.personId,
          idempotencySuffix: 'create',
          memoSuffix: reason,
        });
        journalEntryId = posted.journalEntryId;
      }
      await orderWastageRepo.resolve(trx, {
        id,
        disposition: input.disposition!,
        journalEntryId,
        settlementId: null,
        autoCharged: false,
        resolvedBy: actor.personId,
      });
      return { id, status: 'resolved', journalEntryId };
    }

    return { id, status: 'open', journalEntryId: null };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface DisputeOrderWastageInput {
  wastageId: string;
  storeId: string;
}

/** Marks a tracked wastage `disputed`. ⛔ Does NOT reset `opened_at` — invariant 4: the 15-day
 *  clock is uniform, including disputed records, and a carve-out here is exactly what was
 *  deliberately removed and must not be restored. */
export async function disputeOrderWastage(
  tx: Tx | null,
  actor: Actor,
  input: DisputeOrderWastageInput,
): Promise<Outcome<{ id: string }>> {
  const run = async (trx: Tx): Promise<Outcome<{ id: string }>> => {
    await authorize(trx, actor, 'resolve_order_wastage', { storeId: input.storeId });
    const row = await orderWastageRepo.findById(trx, actor.orgId, input.wastageId);
    if (!row) return { ok: false, reason: `order wastage ${input.wastageId} does not exist` };
    if (row.storeId !== input.storeId) return { ok: false, reason: 'order wastage belongs to another store' };
    if (row.status === 'resolved') {
      return { ok: false, reason: `order wastage ${row.id} is already resolved as ${row.disposition}` };
    }
    await orderWastageRepo.markDisputed(trx, actor.orgId, row.id);
    return { ok: true, id: row.id };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface ResolveOrderWastageInput {
  wastageId: string;
  storeId: string;
  disposition: 'platform_paid' | 'absorbed' | 'charged';
  /** `charged` only. Omitted: reuses whatever allocation the row already carries (invariant 2's
   *  seed, or a prior explicit one). Supplied: REPLACES the row's allocations wholesale. */
  allocations?: AllocationInput[];
  /** T-150 settlement this was matched and confirmed against, if any (§4). Provenance — carried
   *  forward from the row when omitted. */
  settlementId?: string | null;
  resolvedOn: string;
}

export interface ResolveOrderWastageResult {
  journalEntryId: string | null;
}

/**
 * A human's decision. Invariant 7/9: the settlement matcher only PROPOSES (see
 * `settlement-match.ts`) — this is the one function that actually disposes, always by a person
 * (never called by the backstop, which posts through its own path below so `auto_charged` is set
 * truthfully).
 */
export async function resolveOrderWastage(
  tx: Tx | null,
  actor: Actor,
  input: ResolveOrderWastageInput,
): Promise<Outcome<ResolveOrderWastageResult>> {
  const run = async (trx: Tx): Promise<Outcome<ResolveOrderWastageResult>> => {
    await authorize(trx, actor, 'resolve_order_wastage', { storeId: input.storeId });
    if (input.disposition === 'charged') {
      await authorize(trx, actor, 'charge_staff_for_wastage', { storeId: input.storeId });
    }

    const row = await orderWastageRepo.findById(trx, actor.orgId, input.wastageId);
    if (!row) return { ok: false, reason: `order wastage ${input.wastageId} does not exist` };
    if (row.storeId !== input.storeId) return { ok: false, reason: 'order wastage belongs to another store' };
    if (row.status === 'resolved') {
      return {
        ok: false,
        reason: `order wastage ${row.id} is already resolved as ${row.disposition} — reverse it and resolve again`,
      };
    }

    if (input.allocations) {
      await orderWastageRepo.replaceAllocations(trx, row.id, input.allocations);
    }
    let allocations = input.allocations;
    if (input.disposition === 'charged' && !allocations) {
      allocations = (await orderWastageRepo.listAllocations(trx, row.id)).map((a) => ({
        personId: a.personId,
        percent: a.percent,
      }));
    }

    let journalEntryId: string | null = null;
    if (input.disposition !== 'platform_paid') {
      const posted = await postDisposition(trx, {
        orgId: actor.orgId,
        storeId: row.storeId,
        channelId: row.channelId,
        channel: row.channel,
        amount: row.amount,
        disposition: input.disposition,
        allocations: allocations ?? [],
        entryDate: input.resolvedOn,
        sourceId: row.id,
        postedBy: actor.personId,
        idempotencySuffix: 'resolve',
        memoSuffix: row.reason,
      });
      journalEntryId = posted.journalEntryId;
    }

    await orderWastageRepo.resolve(trx, {
      id: row.id,
      disposition: input.disposition,
      journalEntryId,
      settlementId: input.settlementId !== undefined ? input.settlementId : row.settlementId,
      autoCharged: false,
      resolvedBy: actor.personId,
    });
    return { ok: true, journalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface ReverseAutoChargeInput {
  wastageId: string;
  storeId: string;
  reason: string;
  reversedOn: string;
}

/**
 * Invariant 6: undo an auto-charge as a reversal PLUS a new resolution, never an edit. Puts the
 * row back to `open`, so a manager calls `resolveOrderWastage` next with the correct disposition
 * — there is no separate "un-resolve" shape.
 */
export async function reverseAutoCharge(
  tx: Tx | null,
  actor: Actor,
  input: ReverseAutoChargeInput,
): Promise<Outcome<{ reversalEntryId: string }>> {
  const run = async (trx: Tx): Promise<Outcome<{ reversalEntryId: string }>> => {
    await authorize(trx, actor, 'reverse_auto_charge', { storeId: input.storeId });
    const row = await orderWastageRepo.findById(trx, actor.orgId, input.wastageId);
    if (!row) return { ok: false, reason: `order wastage ${input.wastageId} does not exist` };
    if (row.storeId !== input.storeId) return { ok: false, reason: 'order wastage belongs to another store' };
    if (!row.autoCharged) {
      return {
        ok: false,
        reason: `order wastage ${row.id} was not auto-charged — only a backstop decision is reversible here`,
      };
    }
    if (!row.journalEntryId || !row.resolvedAt) {
      return { ok: false, reason: `order wastage ${row.id} has no posting to reverse — data inconsistency` };
    }
    const ageDays = (Date.now() - row.resolvedAt.getTime()) / 86_400_000;
    if (ageDays > AUTO_CHARGE_REVERSAL_DAYS) {
      return {
        ok: false,
        reason:
          `order wastage ${row.id} was auto-charged on ${row.resolvedAt.toISOString().slice(0, 10)}, ` +
          `more than ${AUTO_CHARGE_REVERSAL_DAYS} days ago — no longer reversible here`,
      };
    }
    const reason = input.reason.trim();
    if (!reason) return { ok: false, reason: 'say why this auto-charge is being reversed' };

    const reversal = await reverseEntry(trx, {
      entryId: row.journalEntryId,
      reason,
      reversedBy: actor.personId,
    });
    await orderWastageRepo.reopenAfterReversal(trx, row.id);
    return { ok: true, reversalEntryId: reversal.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

// =====================================================================================
// The 15-day backstop — T-140's scheduler, never a human boundary (no authorize() below).
// =====================================================================================

export interface BackstopOutcome {
  wastageId: string;
  storeId: string;
  disposition: 'absorbed' | 'charged';
  /** True when this WOULD have charged a person but Phase 5 is unavailable, so it degraded to
   *  store-absorbed instead — §6/§11 invariant 10's "never silently". */
  degraded: boolean;
  journalEntryId: string;
}

export interface BackstopResult {
  outcomes: BackstopOutcome[];
  /** Ones the backstop looked at and could not close at all — e.g. the store's channel is not
   *  configured, so there is nowhere to post. Named rather than thrown, so one bad row does not
   *  stop the rest (T-140's own per-subject failure precedent).
   *
   * ⭐ T-343 S4 — `label` names the wastage a human can act on (`channel`, per the schema's own
   * comment, is already the display name AS RECORDED, never a key — no extra lookup needed to
   * read it), never the raw id: `${channel} order ${orderRef ?? 'without an order number'} · ₱
   * ${amount}`. `storeId` rides along so the caller (`scheduler/index.ts`, which already knows
   * every store in this org) can prefix `Name (CODE)` without a second per-row query here. */
  failures: { wastageId: string; storeId: string; label: string; reason: string }[];
}

/**
 * Invariant 4/5/12: fires uniformly for `open` AND `disputed` tracked wastages whose `opened_at`
 * is more than 15 days old, in the fallback order allocated split -> Monitor 100% -> store
 * absorbs net-zero — idempotent, because a row this closes is `resolved` and the query above
 * never sees it again.
 *
 * ⚠️ Invariant 11: period lock applies here exactly as it does to a human resolution —
 * `postDisposition` -> `postEntry` refuses a closed period the same way for both callers, because
 * there is only the one `postEntry`.
 */
export async function runOrderWastageBackstop(
  trx: Tx,
  orgId: string,
  options: { now?: Date; postedBy?: string | null } = {},
): Promise<BackstopResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - BACKSTOP_DAYS * 86_400_000);
  const due = await orderWastageRepo.pastBackstop(trx, orgId, cutoff);

  const outcomes: BackstopOutcome[] = [];
  const failures: { wastageId: string; storeId: string; label: string; reason: string }[] = [];
  const entryDate = now.toISOString().slice(0, 10);

  for (const row of due) {
    try {
      const allocationRows = await orderWastageRepo.listAllocations(trx, row.id);
      const hasAllocation = allocationRows.length > 0;
      let monitor: string | null = null;
      if (!hasAllocation) monitor = await orderWastageRepo.wastageMonitorFor(trx, orgId, row.storeId);

      // Fallback order — invariant 5.
      const wouldCharge = hasAllocation || monitor !== null;
      const allocations: AllocationInput[] = hasAllocation
        ? allocationRows.map((a) => ({ personId: a.personId, percent: a.percent }))
        : monitor
          ? [{ personId: monitor, percent: '100.00' }]
          : [];

      // ⛔ Invariant 10 — never charge into an account nothing can draw down. A would-be charge
      // degrades to store-absorbed, RECORDED on the posted entry's own memo (there is no
      // resolution-note column on the row itself — see the schema file's comment).
      const degraded = wouldCharge && !isPhase5StaffAdvancesAvailable();
      const disposition: 'absorbed' | 'charged' = wouldCharge && !degraded ? 'charged' : 'absorbed';

      const memoSuffix = degraded
        ? `15-day backstop — would have charged ${allocations.length > 1 ? 'a split' : 'a person'}, ` +
          'degraded to store-absorbed: Phase 5 (staff advances) is not available'
        : disposition === 'charged'
          ? `15-day backstop — charged ${allocations.length > 1 ? 'the split' : 'the allocated person'}`
          : monitor === null && !hasAllocation
            ? '15-day backstop — no allocation and no Wastage Monitor configured, store absorbs net-zero'
            : '15-day backstop — store absorbs';

      const posted = await postDisposition(trx, {
        orgId,
        storeId: row.storeId,
        channelId: row.channelId,
        channel: row.channel,
        amount: row.amount,
        disposition,
        allocations: disposition === 'charged' ? allocations : [],
        entryDate,
        sourceId: row.id,
        postedBy: options.postedBy ?? null,
        idempotencySuffix: `backstop:${entryDate}`,
        memoSuffix,
      });

      await orderWastageRepo.resolve(trx, {
        id: row.id,
        disposition,
        journalEntryId: posted.journalEntryId,
        settlementId: row.settlementId,
        autoCharged: true,
        resolvedBy: options.postedBy ?? null,
      });

      outcomes.push({
        wastageId: row.id,
        storeId: row.storeId,
        disposition,
        degraded,
        journalEntryId: posted.journalEntryId,
      });
    } catch (err) {
      failures.push({
        wastageId: row.id,
        storeId: row.storeId,
        label: `${row.channel} order ${row.orderRef ?? 'without an order number'} · ₱${row.amount}`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { outcomes, failures };
}
