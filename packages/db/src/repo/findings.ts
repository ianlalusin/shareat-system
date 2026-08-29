/**
 * The only place SQL is written for integrity findings. T-135.
 *
 * ⭐ **Every function here is a DETECTOR: it asks the ledger a question and returns what is
 * wrong.** Nothing here stores a finding, because a stored finding can disagree with reality —
 * which is v1's one real defect in this feature, where resolving a finding suppressed the symptom
 * while the cause stayed broken.
 *
 * ⛔ **This module never writes to the ledger**, and invariant 6 of the task spec asserts it.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { findingAcknowledgements } from '../../schema/findings';
// ⛔ The ONE definition of how long each cadence allows. A private copy here would be a second
// source of truth for a number the screen also shows — bible §6.3.
import { CADENCE_DAYS } from '../../schema/stores';
import { formatMoney, money } from '@shareat/core/money';

/**
 * ⛔ **Never interpolate the symbol by hand.** A hand-rolled peso plus `toFixed(2)` renders a
 * negative as `₱-21,450.00` — symbol first, sign
 * second — which is precisely the misreading `apps/erp/src/lib/format.ts` was created to stop
 * after five screens each grew their own broken copy. A finding is read in a hurry, by someone
 * deciding whether to act, so the sign has to be where the eye expects it: `-₱21,450.00`.
 *
 * ⭐ One formatter, `@shareat/core`'s — not a fourth copy of the `Intl` options.
 */
const peso = (n: number): string => formatMoney(money(n.toFixed(2)));

export interface DetectedFinding {
  kind: string;
  /** Stable identity — kind plus whatever the kind is about. Derived, never chosen by a person. */
  key: string;
  storeId: string | null;
  severity: 'hard' | 'soft';
  detail: string;
}

/**
 * ⭐ Debits must equal credits in aggregate.
 *
 * Per entry this is already impossible — a CHECK enforces it — so this is the aggregate assertion
 * that catches the thing a per-entry rule cannot: a leg that vanished, or a partial write.
 */
export async function trialBalanceDrift(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as drift
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where je.org_id = ${orgId} and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  const drift = Number(row?.drift ?? 0);
  if (Math.abs(drift) < 0.005) return [];
  return [{
    kind: 'trialBalanceDoesNotTie',
    key: 'trialBalanceDoesNotTie',
    storeId: null,
    severity: 'hard',
    detail: `Debits and credits differ by ${peso(drift)} across the whole ledger.`,
  }];
}

/**
 * ⭐ Σ `1250 Due from related store` must equal Σ `2150 Due to related store`.
 *
 * Bible invariant 6's reciprocal check. Two features now depend on it — inter-store transfers
 * (T-133) and cross-store loan deductions in channel settlement (T-150) — so a break here means a
 * transfer went missing rather than that somebody mistyped.
 */
export async function reciprocalDrift(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select
      coalesce(sum(case when a.code = '1250' then jl.debit - jl.credit end), 0)::text as due_from,
      coalesce(sum(case when a.code = '2150' then jl.credit - jl.debit end), 0)::text as due_to
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  const drift = Number(row?.due_from ?? 0) - Number(row?.due_to ?? 0);
  if (Math.abs(drift) < 0.005) return [];
  return [{
    kind: 'dueFromDueToNotReciprocal',
    key: 'dueFromDueToNotReciprocal',
    storeId: null,
    severity: 'hard',
    detail:
      `Due-from totals ${peso(Number(row!.due_from))} but due-to totals ` +
      `${peso(Number(row!.due_to))}. An inter-store movement went missing.`,
  }];
}

/**
 * ⭐ Every control account's subledger must sum to its control balance.
 *
 * A `requires_party` account whose lines carry no party is money owed by nobody — the exact shape
 * that makes an aged report lie.
 */
export async function unpartiedControlLines(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select a.code, count(*)::text as n, coalesce(sum(abs(jl.debit - jl.credit)), 0)::text as amount
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.requires_party = true and jl.party_id is null
    group by a.code order by a.code
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    kind: 'subledgerDoesNotMatchControl',
    key: `subledgerDoesNotMatchControl:${r.code}`,
    storeId: null,
    severity: 'hard' as const,
    detail:
      `${r.n} line(s) on ${r.code} carry no party, worth ${peso(Number(r.amount))}. ` +
      'That balance belongs to nobody, so it can never be aged or collected.',
  }));
}

/**
 * ⭐ `3900 Opening balance equity` must net to zero once the cutover is done (ADR-005).
 * A residual is the conversion not adding up, and it halts.
 */
export async function openingBalanceResidual(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '3900'
  `)) as unknown as Record<string, string>[];
  const balance = Number(row?.balance ?? 0);
  if (Math.abs(balance) < 0.005) return [];
  return [{
    kind: 'openingBalanceEquityNonZero',
    key: 'openingBalanceEquityNonZero',
    storeId: null,
    severity: 'hard',
    detail: `3900 carries ${peso(balance)}. The opening conversion does not add up.`,
  }];
}

/**
 * ⭐ The channel clearing accounts are ZERO AT REST (T-150).
 * A balance here means a settlement is mid-flight or broken — a different alarm from `1220` ageing.
 */
export async function clearingNotAtRest(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select a.code, coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code in ('1221','1222')
    group by a.code having abs(coalesce(sum(jl.debit - jl.credit), 0)) >= 0.005
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    kind: 'clearingAccountNotAtRest',
    key: `clearingAccountNotAtRest:${r.code}`,
    storeId: null,
    severity: 'soft' as const,
    detail: `${r.code} holds ${peso(Number(r.balance))}. Something did not finish.`,
  }));
}

/**
 * ⭐ **DEF-044 and DEF-078, made visible.**
 *
 * v1's depreciation stopped silently for two months — ₱35,483.98 a month unbooked — and only a
 * data capture found it. v2's month-end runner exists but nothing on any host fires it yet.
 *
 * ⚠️ **Compared against OPEN BALANCES, never against last month's activity.** That is DEF-044's
 * actual lesson: a schedule that simply FINISHED and a schedule that DIED look identical if you
 * only ask "was there activity last month". Only Ian could tell those apart, so the check asks
 * whether there is anything left to post instead.
 */
export async function periodicPostingsMissed(
  tx: Tx,
  orgId: string,
  period: string,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with work as (
      select
        (select count(*) from fixed_assets fa
          where fa.org_id = ${orgId} and fa.status = 'active') as depreciable,
        (select count(*) from prepaid_items pi
          where pi.org_id = ${orgId} and pi.status = 'active') as prepaid
    ),
    ran as (
      select job, count(*)::int as n
      from scheduler_runs sr
      where sr.org_id = ${orgId} and sr.period = ${period}
      group by job
    )
    select
      (select depreciable from work)::text as depreciable,
      (select prepaid from work)::text as prepaid,
      coalesce((select n from ran where job = 'depreciation'), 0)::text as depreciation_runs,
      coalesce((select n from ran where job = 'amortisation'), 0)::text as amortisation_runs
  `)) as unknown as Record<string, string>[];
  const r = rows[0];
  if (!r) return [];
  const out: DetectedFinding[] = [];
  if (Number(r.depreciable) > 0 && Number(r.depreciation_runs) === 0) {
    out.push({
      kind: 'depreciationNotBooked',
      key: `depreciationNotBooked:${period}`,
      storeId: null,
      severity: 'hard',
      detail:
        `${r.depreciable} asset(s) are still depreciating and nothing ran for ${period}. ` +
        'DEF-044: this stopped for two months in v1 and only a capture found it.',
    });
  }
  if (Number(r.prepaid) > 0 && Number(r.amortisation_runs) === 0) {
    out.push({
      kind: 'amortisationNotBooked',
      key: `amortisationNotBooked:${period}`,
      storeId: null,
      severity: 'hard',
      detail:
        `${r.prepaid} prepaid item(s) still have a balance and nothing ran for ${period}. ` +
        '⚠️ Measured against OPEN BALANCES, not last month’s activity — a finished schedule and a ' +
        'dead one look identical the other way round.',
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------
// T-152 — cash that is sitting somewhere it should not be
// -------------------------------------------------------------------------------------

/** RA 11360: service charge is distributed at intervals not exceeding sixteen days. */
const SERVICE_CHARGE_MAX_DAYS = 16;

interface StorePositionRow {
  store_id: string;
  store_name: string;
  cadence: string;
  ceiling: string | null;
  /** Net cashier movement not yet settled by any posted remittance. */
  outstanding: string;
  /** Of that, the part sitting on VERIFIED days — the only part that can be remitted today. */
  remittable: string;
  /** Oldest date still carrying an unsettled positive balance. */
  oldest_date: string | null;
  age_days: string | null;
}

/**
 * The un-remitted position per store, and how old the oldest unsettled day is.
 *
 * ⭐ **This mirrors `remittance.endDayReports` deliberately and must stay in step with it** — same
 * custodian resolution, same `source_type <> 'transfer'` exclusion, same "movement less
 * allocations" arithmetic. The difference is only that this asks it of every store at once.
 *
 * ⚠️ **It is ONE figure, not two tracks.** Bible row 144 split cash from online; **row 157
 * superseded it** (Ian: *"it must be END DAY REPORT"*), and T-143 §3 records the consequence —
 * *"rows 144 and 145 turn out to be one figure."* `remittance_allocations` carries no track
 * column, so splitting here would invent a division the ledger does not hold.
 */
async function storePositions(tx: Tx, orgId: string): Promise<StorePositionRow[]> {
  return (await tx.execute(sql`
    with cashier_movement as (
      select jl.store_id,
             je.entry_date,
             coalesce(sum(jl.debit - jl.credit), 0) as movement
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a        on a.id = jl.account_id
      left join money_accounts ma
        on ma.id::text = jl.party_id and jl.party_type = 'money_account'
      left join (values ('1110','cashier'), ('1120','staff'), ('1130','office'))
        as ca(code, custodian) on ca.code = a.code
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and a.code ~ '^11[0-9]{2}$'
        and coalesce(ma.custodian, ca.custodian) = 'cashier'
        -- Custody movement, not a transaction of the day. Same exclusion as endDayReports.
        and je.source_type <> 'transfer'
      group by jl.store_id, je.entry_date
    ),
    settled as (
      select r.store_id, ra.business_date, coalesce(sum(ra.amount), 0) as allocated
      from remittance_allocations ra
      join remittances r on r.id = ra.remittance_id
      where r.org_id = ${orgId} and r.status = 'posted'
      group by r.store_id, ra.business_date
    ),
    per_day as (
      select m.store_id,
             m.entry_date,
             (m.movement - coalesce(s.allocated, 0)) as owed,
             (sd.status = 'verified')                as is_verified
      from cashier_movement m
      left join settled s
        on s.store_id = m.store_id and s.business_date = m.entry_date
      left join sales_days sd
        on sd.org_id = ${orgId} and sd.store_id = m.store_id
       and sd.business_date = m.entry_date and sd.status <> 'voided'
    )
    select st.id::text                                              as store_id,
           st.name                                                  as store_name,
           st.remittance_cadence                                    as cadence,
           st.unremitted_ceiling::text                              as ceiling,
           -- ⛔ POSITIVE DAYS ONLY, and this is not a detail. A day the cashier paid MORE out of
           -- than came in owes nothing -- remittanceStateOf calls it "the office is out of pocket,
           -- not the till" -- so it is not negative cash in a drawer and must not net off a day
           -- that IS. Summing raw owed reported "-P21,450.00 is un-remitted" for a store holding
           -- P9,400 from three weeks earlier: the alarm fired correctly, then printed a figure
           -- that read like a rounding artefact. This matches the screen's "Ready to remit".
           coalesce(sum(pd.owed) filter (where pd.owed > 0.005), 0)::text as outstanding,
           coalesce(sum(pd.owed) filter (where pd.is_verified and pd.owed > 0.005), 0)::text
                                                                    as remittable,
           min(pd.entry_date) filter (where pd.owed > 0.005)::text   as oldest_date,
           (current_date - min(pd.entry_date) filter (where pd.owed > 0.005))::text as age_days
    from stores st
    left join per_day pd on pd.store_id = st.id
    where st.org_id = ${orgId} and st.is_active = true
    group by st.id, st.name, st.remittance_cadence, st.unremitted_ceiling
  `)) as unknown as StorePositionRow[];
}

/**
 * ⭐ **The guard T-143 shipped without.** Bible row 129.
 *
 * T-143 gave stores the ability to pool remittance across days and its §7 rule 5 says it
 * *"does not enforce the ceiling"*. So cash could accumulate unbounded with nothing watching.
 *
 * ⚠️ **The position counts ALL un-remitted cashier movement, not only the verifiable part.** The
 * risk row 129 names is *money sitting in a drawer*, and an unverified day's cash is sitting there
 * exactly as much as a verified day's. The detail reports the remittable portion separately,
 * because that is what changes what somebody should do about it.
 *
 * ⛔ **This never blocks anything.** Row 129: *"the pile becomes visible and unignorable to the
 * person who can clear it, never a blocked till."*
 */
export async function unremittedCeilingBreached(
  tx: Tx,
  orgId: string,
): Promise<DetectedFinding[]> {
  const rows = await storePositions(tx, orgId);
  const out: DetectedFinding[] = [];
  for (const r of rows) {
    if (r.ceiling === null) continue; // a `daily` store may have none — that is lawful (T-152 §2)
    const ceiling = Number(r.ceiling);
    const outstanding = Number(r.outstanding);
    if (!(outstanding > ceiling)) continue;
    const remittable = Number(r.remittable);
    const held = outstanding - remittable;
    out.push({
      kind: 'unremittedCeilingBreached',
      key: `unremittedCeilingBreached:${r.store_id}`,
      storeId: r.store_id,
      severity: 'soft',
      detail:
        `${r.store_name} is holding ${peso(outstanding)} un-remitted against a ceiling of ` +
        `${peso(ceiling)}. ${peso(remittable)} of that can be remitted now` +
        (held > 0.005
          ? `; ${peso(held)} sits on days that are not verified yet, so it cannot.`
          : '.'),
    });
  }
  return out;
}

/**
 * ⭐ The cadence half of row 129 — the clock rather than the amount.
 *
 * ⚠️ **Age is the signal, not just amount** (row 147): *"₱200 outstanding for 40 days is a worse
 * finding than ₱9,000 since yesterday."* A store within its ceiling can still be far past the day
 * it should have carried the money in.
 */
export async function remittanceOverdue(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = await storePositions(tx, orgId);
  const out: DetectedFinding[] = [];
  for (const r of rows) {
    if (r.oldest_date === null || r.age_days === null) continue;
    const age = Number(r.age_days);
    const limit = CADENCE_DAYS[r.cadence as keyof typeof CADENCE_DAYS] ?? 1;
    if (!(age > limit)) continue;
    const outstanding = Number(r.outstanding);
    out.push({
      kind: 'remittanceOverdue',
      key: `remittanceOverdue:${r.store_id}`,
      storeId: r.store_id,
      severity: 'soft',
      detail:
        `${r.store_name} has cash outstanding from ${r.oldest_date}, ${age} day(s) ago, on a ` +
        `${r.cadence.replace(/_/g, ' ')} cadence that allows ${limit}. ` +
        `${peso(outstanding)} is un-remitted.`,
    });
  }
  return out;
}

/**
 * ⭐ **T-153 — a till float that is not holding its configured amount.**
 *
 * > **Ian, 2026-08-29:** *"the staff just makes sure if the configured budget is 20k, every day
 * > opening and closing it is 20k."*
 *
 * ⭐ **This is the imprest self-check, and it is why the float got its own account.** The pot's
 * balance should ALWAYS equal its target, so the discrepancy is two figures compared — not a
 * history to reconstruct. The control is arithmetic rather than diligence.
 *
 * ⚠️ **Below target and above target are both findings, and they are different accidents.**
 * Below means the float was spent and not topped back up. Above means something was paid INTO the
 * pot that belongs in the takings drawer — which quietly removes money from what must be
 * remitted, so it is the more expensive of the two to leave alone.
 *
 * ⛔ **What this CANNOT catch, stated so nobody assumes it does:** a cashier counting ₱19,500
 * some morning. That is a physical count against the ledger, and v2 has no shift record to hold
 * one (CAPABILITY-GAPS, 2026-08-29). This compares the LEDGER to the target, which catches a float
 * spent, never funded, or overfunded — not one quietly short in the drawer.
 */
export async function tillFloatOffTarget(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select ma.id::text                                   as account_id,
           ma.name                                       as name,
           ma.store_id::text                             as store_id,
           ma.float_target::text                         as target,
           coalesce(sum(jl.debit - jl.credit), 0)::text   as balance
    from money_accounts ma
    -- Scoped by (gl code, store), mirroring balanceOf exactly. A float pot is NOT
    -- requires_party, so its lines carry no money-account party and a party join would read
    -- zero for every pot. One pot per store (unique index) is what keeps this unambiguous.
    left join accounts a
      on a.org_id = ma.org_id and a.code = ma.gl_account_code
    left join journal_lines jl
      on jl.account_id = a.id and jl.store_id = ma.store_id
    left join journal_entries je
      on je.id = jl.entry_id and je.status <> 'draft'
    where ma.org_id = ${orgId} and ma.float_target is not null and ma.is_active
      and (jl.id is null or je.id is not null)
    group by ma.id, ma.name, ma.store_id, ma.float_target
  `)) as unknown as Record<string, string>[];

  const out: DetectedFinding[] = [];
  for (const r of rows) {
    const target = Number(r.target);
    const balance = Number(r.balance);
    const drift = balance - target;
    if (Math.abs(drift) < 0.005) continue;
    out.push({
      kind: 'tillFloatOffTarget',
      key: `tillFloatOffTarget:${r.account_id}`,
      storeId: String(r.store_id),
      severity: 'soft',
      detail:
        `${r.name} holds ${peso(balance)} against a float of ${peso(target)} — ` +
        (drift < 0
          ? `${peso(-drift)} short. The float was drawn on and not topped back up.`
          : `${peso(drift)} over. Something was paid into the float that belongs in the takings ` +
            'drawer, which takes it out of what has to be remitted.'),
    });
  }
  return out;
}

/**
 * ⛔ **DEF-082 — the service-charge float can only ever grow.**
 *
 * Every sales day carrying a service charge credits `2160`, and **nothing in this codebase debits
 * it**: there is no distribution document, and T-136 §6 still owns building one. RA 11360 requires
 * distribution to rank-and-file staff at intervals not exceeding sixteen days.
 *
 * ⭐ **Why this alarm exists before the document it demands.** Ian, 2026-08-29: *"for now no we
 * dont charge but im planning."* That is the answer that needs a guard — `2160` reads zero today,
 * so it looks healthy, and the day a store first enables a service charge in POS the accrual starts
 * with **nothing to announce it**. The only symptom would be a liability quietly growing, which
 * looks exactly like a normal balance sheet.
 *
 * ⚠️ **It will fire permanently once service charge is switched on, and that is the point.** T-135
 * forbids resolving a finding while it is still true, and *"we are accruing an obligation we have
 * no way to discharge"* stays true until §6 is built. The alarm is a standing demand, not a nag.
 *
 * ⭐ **Ageing is FIFO, not "oldest line"** — credits consumed oldest-first by the debits total — so
 * it stays correct the day §6 starts posting distributions instead of needing a rewrite.
 */
export async function serviceChargeFloatAgeing(
  tx: Tx,
  orgId: string,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select je.entry_date::text                     as entry_date,
           coalesce(sum(jl.credit), 0)::text       as credited,
           coalesce(sum(jl.debit), 0)::text        as debited
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a        on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '2160'
    group by je.entry_date
    order by je.entry_date asc
  `)) as unknown as Record<string, string>[];

  if (rows.length === 0) return [];

  const balance = rows.reduce((n, r) => n + Number(r.credited) - Number(r.debited), 0);
  if (balance < 0.005) return []; // nothing held — silent, which is today's state

  // FIFO: consume the oldest credits with everything that has ever been debited.
  let remainingDebits = rows.reduce((n, r) => n + Number(r.debited), 0);
  let oldestUncleared: string | null = null;
  for (const r of rows) {
    const credited = Number(r.credited);
    if (credited <= 0) continue;
    if (remainingDebits >= credited - 0.005) {
      remainingDebits -= credited;
      continue;
    }
    oldestUncleared = String(r.entry_date);
    break;
  }
  if (oldestUncleared === null) return [];

  const ageDays = Math.floor(
    (Date.now() - new Date(`${oldestUncleared}T00:00:00Z`).getTime()) / 86_400_000,
  );
  if (ageDays <= SERVICE_CHARGE_MAX_DAYS) return [];

  return [{
    kind: 'serviceChargeFloatAgeing',
    key: 'serviceChargeFloatAgeing',
    storeId: null,
    /**
     * ⚠️ **`soft`, and the reasoning is worth keeping.** `hard` blocks a period close and an
     * acknowledgement does not lift it — so with no distribution document in existence, `hard`
     * would block **every** close, permanently, with no legitimate remedy. A control nobody can
     * satisfy is one people route around, which is how it stops being a control at all.
     *
     * ⭐ And severity here tracks *"do the books add up"*, not *"is this serious"*. Every `hard`
     * detector above is a ledger that does not tie. This one's ledger is **correct** — the
     * liability is recorded exactly as it should be. What is overdue is the **payment**, which is a
     * business fact the books are reporting faithfully. It stays loud and unresolvable instead.
     */
    severity: 'soft',
    detail:
      `${peso(balance)} of service charge has been held since ${oldestUncleared}, ` +
      `${ageDays} days — RA 11360 requires distribution at intervals of at most ` +
      `${SERVICE_CHARGE_MAX_DAYS} days. ⛔ Nothing in this system can pay it out yet ` +
      '(DEF-082); the distribution document is T-136 §6.',
  }];
}

// -------------------------------------------------------------------------------------
// Acknowledgements — the only thing this feature stores
// -------------------------------------------------------------------------------------

export interface AcknowledgementRow {
  findingKey: string;
  acknowledgedBy: string;
  acknowledgedAt: Date;
  expiresAt: Date;
  note: string | null;
}

/**
 * The LIVE acknowledgement for each finding key, newest first.
 *
 * ⚠️ Expired ones are kept and simply stop suppressing — who accepted what, and when, is the
 * accountability record.
 */
export async function liveAcknowledgements(
  tx: Tx,
  orgId: string,
): Promise<Map<string, AcknowledgementRow>> {
  const rows = (await tx.execute(sql`
    select distinct on (finding_key)
      finding_key, acknowledged_by, acknowledged_at, expires_at, note
    from finding_acknowledgements
    where org_id = ${orgId} and expires_at > now()
    order by finding_key, acknowledged_at desc
  `)) as unknown as Record<string, string>[];
  return new Map(
    rows.map((r) => [
      String(r.finding_key),
      {
        findingKey: String(r.finding_key),
        acknowledgedBy: String(r.acknowledged_by),
        acknowledgedAt: new Date(String(r.acknowledged_at)),
        expiresAt: new Date(String(r.expires_at)),
        note: r.note ?? null,
      },
    ]),
  );
}

export async function insertAcknowledgement(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string | null;
    findingKey: string;
    kind: string;
    note: string | null;
    acknowledgedBy: string;
    expiresAt: Date;
  },
): Promise<void> {
  await tx.insert(findingAcknowledgements).values(input);
}

/** Every acknowledgement ever made for a key — the accountability history. */
export async function acknowledgementHistory(
  tx: Tx,
  orgId: string,
  findingKey: string,
): Promise<AcknowledgementRow[]> {
  const rows = await tx
    .select()
    .from(findingAcknowledgements)
    .where(
      and(
        eq(findingAcknowledgements.orgId, orgId),
        eq(findingAcknowledgements.findingKey, findingKey),
      ),
    );
  return rows as unknown as AcknowledgementRow[];
}
