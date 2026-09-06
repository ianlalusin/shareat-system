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
// ⛔ T-218 — the ONE definition of "today" for the repo layer. Never bare `current_date`.
import { MANILA_TODAY, daysBetweenDates } from './sql-time';

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
           (${MANILA_TODAY} - min(pd.entry_date) filter (where pd.owed > 0.005))::text as age_days
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
 *
 * ## ⛔ And the distinction is not academic — it decides whether somebody gets charged
 *
 * > **Ian, 2026-08-29:** *"charge to cashier, then office will replenish on the day it is counted
 * > as short."*
 *
 * That rule is about a **counted** shortage: cash that should be in the pocket and is not.
 * **A ledger shortfall is a different event with the same shape** — the float was spent on a
 * delivery, posted correctly, and simply not topped back up. Nobody is answerable for that.
 *
 * ⚠️ **Reading this finding as "the cashier owes this" would charge somebody for a legitimate
 * expense**, which is why the message says which kind it is in as many words. The chargeable
 * version is `tillCountVarianceOpen` below — T-186 built the shift count this one lacked, so
 * the two now sit side by side on the same page and the wording is what keeps them apart.
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
          ? `${peso(-drift)} short in the LEDGER. The float was spent and not topped back up; ` +
            'the office replenishes it. ⛔ This is NOT a counted shortage and must not be charged ' +
            'to a cashier — it is money that was legitimately paid out and posted.'
          : `${peso(drift)} over in the LEDGER. Something was posted INTO the float that belongs ` +
            'in the takings drawer, which quietly removes it from what has to be remitted. ' +
            '⚠️ Not a counted overage: a physical over goes to the tip box and never reaches the ' +
            'books at all.'),
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
           coalesce(sum(jl.debit), 0)::text        as debited,
           -- ⭐ T-218. Today, from POSTGRES, in Manila — carried back so the age below is measured
           -- against the same clock the rest of this module gates on. now() references no
           -- grouped column, so it is legal beside the aggregates.
           ${MANILA_TODAY}::text                   as manila_today
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

  const ageDays = daysBetweenDates(oldestUncleared, String(rows[0]!.manila_today));
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
  /** ⚠️ Null for an ORG-wide finding. Added by T-214 so the scorecard can group by store. */
  storeId: string | null;
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
      finding_key, store_id, acknowledged_by, acknowledged_at, expires_at, note
    from finding_acknowledgements
    where org_id = ${orgId} and expires_at > now()
    order by finding_key, acknowledged_at desc
  `)) as unknown as Record<string, string | null>[];
  return new Map(
    rows.map((r) => [
      String(r.finding_key),
      {
        findingKey: String(r.finding_key),
        storeId: r.store_id == null ? null : String(r.store_id),
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

/**
 * ⭐ **T-224 — the durable half of DEF-186.**
 *
 * T-223 gave the low-stock auto-order its first caller and made a failure visible as a clause on the
 * success message of the post that triggered it. ⚠️ **A screen message dies with the request**:
 * nobody sees it twice, nobody sees it who was not the person posting, and a *repeated* failure looks
 * exactly like a first one.
 *
 * The consequence, though, is persisted — an item at or below its threshold, at a store that can
 * order, with nothing on order for it. That survives a lost log line and the cook who posted at 11pm
 * and went home, which is the difference between a message and a control.
 *
 * ## ⛔ It mirrors `ensureAutoOrderLines`' gates rather than inventing its own
 *
 * A finding that disagrees with the thing it watches is worse than no finding, so the three gates are
 * the same three, in the same order: an **active commissary link** (a store that cannot order is
 * never nagged for not ordering), **at or below threshold** on an **active** item, and **not already
 * on the open order**.
 *
 * ⭐ **"Open" means `draft`, `confirmed` OR `dispatched`, and dispatched is the one that matters.**
 * `openOrderFor`'s own comment: *"a dispatched order is goods-in-transit not yet received, so it
 * BLOCKS."* ⛔ A detector checking only `draft` would fire on every item currently in a truck — stock
 * already ordered and physically on its way. That is the noise failure this must not ship.
 *
 * ⚠️ And the line must carry `requested_quantity is not null`, matching `itemsAlreadyOnOrder`: a
 * `commissary_added` substitution is the commissary's proposal, not the branch's ask.
 *
 * ⚠️ **`soft`, deliberately.** Nothing is wrong with the books — stock is low and nothing is on
 * order. `hard` blocks a period close, and a close should not be held for a reorder.
 */
export async function lowStockOrderNotProposed(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with linked as (
      -- Gate 1: only stores that can actually order. Mirrors lowStockRepo.commissaryFor.
      select cl.branch_store_id as store_id, cl.commissary_store_id, s.name as store_name
      from commissary_links cl
      join stores s on s.id = cl.branch_store_id
      where cl.org_id = ${orgId} and cl.status = 'active'
    ),
    on_hand as (
      select sm.store_id, sm.item_id, coalesce(sum(sm.quantity), 0) as qty
      from stock_movements sm
      where sm.org_id = ${orgId}
      group by sm.store_id, sm.item_id
    ),
    low as (
      -- Gate 2: the same predicate lowStockRepo.lowStock uses, including the <= and active items.
      select ln.store_id, ln.store_name, ln.commissary_store_id,
             t.item_id, i.name as item_name,
             (t.low_stock_threshold - coalesce(h.qty, 0)) as shortfall
      from store_item_thresholds t
      join linked ln on ln.store_id = t.store_id
      join items i on i.id = t.item_id
      left join on_hand h on h.store_id = t.store_id and h.item_id = t.item_id
      where t.org_id = ${orgId}
        and i.status = 'active'
        and coalesce(h.qty, 0) <= t.low_stock_threshold
    )
    select low.store_id::text as store_id,
           low.store_name     as store_name,
           count(*)::int      as n_items,
           round(max(low.shortfall), 3)::text as deepest,
           (array_agg(low.item_name order by low.shortfall desc))[1:3] as sample
    from low
    -- Gate 3: not already on the open order. draft | confirmed | DISPATCHED -- goods in a truck are
    -- ordered, and requested_quantity is what separates the branch's ask from a commissary proposal.
    where not exists (
      select 1
      from trade_orders o
      join trade_order_lines tl on tl.order_id = o.id
      where o.org_id = ${orgId}
        and o.requested_by_store_id = low.store_id
        and o.store_id = low.commissary_store_id
        and o.status in ('draft', 'confirmed', 'dispatched')
        and tl.item_id = low.item_id
        and tl.requested_quantity is not null
    )
    group by low.store_id, low.store_name
  `)) as unknown as {
    store_id: string; store_name: string; n_items: number; deepest: string; sample: string[];
  }[];

  return rows.map((r) => ({
    kind: 'lowStockOrderNotProposed',
    key: `lowStockOrderNotProposed:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n_items} item${r.n_items === 1 ? '' : 's'} at or below threshold with ` +
      `nothing on order — ${(r.sample ?? []).join(', ')}${r.n_items > (r.sample ?? []).length ? ', …' : ''}. ` +
      `The deepest is ${r.deepest} below its threshold. The auto-order proposes these lines when a ` +
      'usage record is posted, so either none has been posted since the stock fell, or the ordering ' +
      'path failed and only said so on the screen of whoever posted it.',
  }));
}

/**
 * ⭐ T-175 — items being consumed in a store that has never had a reorder threshold set.
 *
 * ⚠️ **This is the replacement for v1's forcing function.** v1 blocked a usage post until somebody
 * filled the setting in, which puts the demand on a cook at 11pm who cannot answer it and is not
 * paid to. The same information as a finding reaches a manager, who can — *nag the person who can
 * act, never block the person who cannot.*
 *
 * ⛔ `soft`. A missing threshold makes the books no less true; it makes a REPLENISHMENT blind. That
 * is worth being loud about and is not worth blocking a period close over.
 */
export async function itemsMissingThreshold(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select m.store_id::text as store_id, s.name as store_name, count(distinct m.item_id)::int as n,
           min(i.name) as example
    from stock_movements m
    join items i on i.id = m.item_id
    join stores s on s.id = m.store_id
    left join store_item_thresholds t on t.store_id = m.store_id and t.item_id = m.item_id
    where m.org_id = ${orgId} and i.status = 'active' and t.id is null
      and exists (select 1 from commissary_links cl
                  where cl.branch_store_id = m.store_id and cl.status = 'active')
    group by m.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; example: string }[];

  return rows.map((r) => ({
    kind: 'itemHasNoThreshold',
    key: `itemHasNoThreshold:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} moves ${r.n} item${r.n === 1 ? '' : 's'} with no reorder threshold ` +
      `(e.g. ${r.example}). ⚠️ They can never appear on the low-stock list, and nothing else ` +
      'will say so — the store simply runs out.',
  }));
}

/**
 * ⭐ T-170: a supplier credit (`1240`) nobody has spent is money sitting with a supplier — the
 * exact gap Ian's answer closed by making a return a spendable credit instead of a silent
 * write-off. `1240` is pooled per supplier, not tracked per return (invariant 6: a query, never a
 * stored balance), so this does not attempt FIFO ageing of individual returns against later
 * spends — it flags a supplier whose CURRENT balance is positive AND whose oldest still-open
 * `supplier_advance` return is older than the threshold, which is the practical question
 * ("has this been sitting a while with nobody drawing it down") without needing to reconstruct
 * which peso of a fungible balance came from which return.
 */
export async function supplierCreditAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select s.id as supplier_id, s.name as supplier_name,
           coalesce(sum(jl.debit - jl.credit), 0)::text as balance,
           min(sr.returned_on)::text as oldest_return
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join suppliers s on s.id::text = jl.party_id and jl.party_type = 'supplier'
    left join supplier_returns sr on sr.supplier_id = s.id and sr.credit_basis in ('supplier_advance', 'mixed')
      and sr.status = 'posted'
    where je.org_id = ${orgId} and a.code = '1240' and je.status <> 'draft'
    group by s.id, s.name
    having coalesce(sum(jl.debit - jl.credit), 0) > 0
       and min(sr.returned_on) < (${MANILA_TODAY} - (${thresholdDays} || ' days')::interval)
  `)) as unknown as { supplier_id: string; supplier_name: string; balance: string; oldest_return: string }[];

  return rows.map((r) => ({
    kind: 'supplierCreditAgeing',
    key: `supplierCreditAgeing:${r.supplier_id}`,
    storeId: null,
    severity: 'soft' as const,
    detail:
      `${r.supplier_name} holds a ${peso(Number(r.balance))} return credit, unspent since at ` +
      `least ${r.oldest_return}. Apply it on the next AP payment or it goes unnoticed until the ` +
      'relationship ends.',
  }));
}

/**
 * ⭐ T-179's own Done-when — the AR mirror of `supplierCreditAgeing`. An unredeemed `2140`
 * balance is a liability the customer may have forgotten and we have not.
 */
export async function customerCreditAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select c.id as customer_id, c.name as customer_name,
           coalesce(sum(jl.credit - jl.debit), 0)::text as balance,
           min(cr.returned_on)::text as oldest_return
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join customers c on c.id::text = jl.party_id and jl.party_type = 'customer'
    left join customer_returns cr on cr.customer_id = c.id and cr.settlement in ('store_credit', 'mixed')
      and cr.status = 'posted'
    where je.org_id = ${orgId} and a.code = '2140' and je.status <> 'draft'
    group by c.id, c.name
    having coalesce(sum(jl.credit - jl.debit), 0) > 0
       and min(cr.returned_on) < (${MANILA_TODAY} - (${thresholdDays} || ' days')::interval)
  `)) as unknown as { customer_id: string; customer_name: string; balance: string; oldest_return: string }[];

  return rows.map((r) => ({
    kind: 'customerCreditAgeing',
    key: `customerCreditAgeing:${r.customer_id}`,
    storeId: null,
    severity: 'soft' as const,
    detail:
      `${r.customer_name} holds a ${peso(Number(r.balance))} return credit, unspent since at ` +
      `least ${r.oldest_return}. Apply it on their next order or refund it before it is forgotten.`,
  }));
}

/**
 * DEF-157 — `2130 Reimbursements payable to employees` is credited on every reimbursable
 * expense (`expenses/routing.ts`) and, until `payReimbursement` (T-208), had no clearing path at
 * all. Same shape as `supplierCreditAgeing`/`customerCreditAgeing`, but with no companion table
 * to read an originating date from — so the "since" date is FIFO'd from the entries themselves,
 * the same technique `serviceChargeFloatAgeing` uses for a single control account, applied here
 * per employee.
 */
export async function reimbursablePayableAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.party_id as employee_id, coalesce(p.display_name, jl.party_id) as employee_name,
           je.entry_date::text as entry_date,
           coalesce(sum(jl.credit), 0)::text as credited,
           coalesce(sum(jl.debit), 0)::text as debited,
           -- ⭐ T-218. See serviceChargeFloatAgeing — the FIFO walk below picks the date to age
           -- from, so the age cannot be computed here, but the "today" it is measured against is
           -- still Postgres's, in Manila, read once with the data.
           ${MANILA_TODAY}::text as manila_today
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    left join persons p on p.id::text = jl.party_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code = '2130' and jl.party_type = 'employee'
    group by jl.party_id, p.display_name, je.entry_date
    order by jl.party_id, je.entry_date asc
  `)) as unknown as {
    employee_id: string; employee_name: string; entry_date: string; credited: string;
    debited: string; manila_today: string;
  }[];

  const byEmployee = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEmployee.get(r.employee_id) ?? [];
    list.push(r);
    byEmployee.set(r.employee_id, list);
  }

  const findings: DetectedFinding[] = [];
  for (const [employeeId, entries] of byEmployee) {
    const balance = entries.reduce((n, r) => n + Number(r.credited) - Number(r.debited), 0);
    if (balance < 0.005) continue;

    // FIFO: consume the oldest credits with everything ever debited for this employee.
    let remainingDebits = entries.reduce((n, r) => n + Number(r.debited), 0);
    let oldestUncleared: string | null = null;
    for (const r of entries) {
      const credited = Number(r.credited);
      if (credited <= 0) continue;
      if (remainingDebits >= credited - 0.005) {
        remainingDebits -= credited;
        continue;
      }
      oldestUncleared = r.entry_date;
      break;
    }
    if (oldestUncleared === null) continue;

    const ageDays = daysBetweenDates(oldestUncleared, String(rows[0]!.manila_today));
    if (ageDays <= thresholdDays) continue;

    findings.push({
      kind: 'reimbursablePayableAgeing',
      key: `reimbursablePayableAgeing:${employeeId}`,
      storeId: null,
      severity: 'soft',
      detail:
        `${entries[0]!.employee_name} is owed ${peso(balance)} in reimbursements, unpaid since ` +
        `${oldestUncleared} (${ageDays} days). Settle it with a reimbursement payout.`,
    });
  }
  return findings;
}

/**
 * DEF-159 / bible §16.10 — "age unliquidated advances; they are a standing control risk." Unlike
 * the ageing detectors above, `cash_requests` already carries its own status and release date
 * directly — no ledger FIFO needed, the row itself says whether it is still open.
 */
export async function cashRequestFloatAgeing(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select cr.id as request_id, coalesce(p.display_name, cr.requested_for::text) as person_name,
           cr.approved_amount::text as amount, cr.released_on::text as released_on,
           -- ⭐ T-218. The age comes from the SAME statement, and the SAME clock, as the threshold
           -- on the next line. It used to be recomputed in JS from Date.now() against a date
           -- parsed as UTC midnight, so the badge could say "31 days" about a row the gate admitted
           -- on Postgres's reckoning of 30 -- two clocks, disagreeing exactly when it mattered.
           (${MANILA_TODAY} - cr.released_on)::int as age_days
    from cash_requests cr
    left join persons p on p.id = cr.requested_for
    where cr.org_id = ${orgId} and cr.status = 'released'
      and cr.released_on < (${MANILA_TODAY} - (${thresholdDays} || ' days')::interval)
  `)) as unknown as {
    request_id: string; person_name: string; amount: string; released_on: string; age_days: number;
  }[];

  return rows.map((r) => {
    const ageDays = Number(r.age_days);
    return {
      kind: 'cashRequestFloatAgeing',
      key: `cashRequestFloatAgeing:${r.request_id}`,
      storeId: null,
      severity: 'soft' as const,
      detail:
        `${r.person_name} has held a ${peso(Number(r.amount))} float since ${r.released_on} ` +
        `(${ageDays} days) with no liquidation. Settle it before releasing anything further to them.`,
    };
  });
}

/**
 * ⭐ T-167's stuck-transfer report, as a finding rather than a screen someone has to remember to
 * open. Per store, matching `stuckTransfers`'s own default — a room-to-room transfer that has sat
 * `in_transit` for more than the threshold is either forgotten or the goods never actually moved.
 */
export async function stuckStockTransfer(
  tx: Tx,
  orgId: string,
  thresholdDays = 3,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select t.store_id::text as store_id, s.name as store_name, count(*)::int as n,
           min(t.dispatched_at)::text as oldest
    from stock_transfers t
    join stores s on s.id = t.store_id
    where t.org_id = ${orgId} and t.status = 'in_transit'
      and t.dispatched_at < now() - (${thresholdDays} || ' days')::interval
    group by t.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'stuckStockTransfer',
    key: `stuckStockTransfer:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n} stock transfer${r.n === 1 ? '' : 's'} dispatched but never ` +
      `received, the oldest from ${r.oldest}. Goods that are neither on the shelf nor moving.`,
  }));
}

/**
 * ⭐ T-165 invariant 1 — Phase 3's exit gate, as a finding rather than only a screen someone has
 * to remember to open (`/inventory` renders the same comparison, one store at a time; this walks
 * every store in the org). `1340` in-transit is deliberately EXCLUDED — goods on a truck are in
 * no FIFO layer, and conflating the two is DEF-098.
 */
export async function inventoryControlDoesNotMatchValuation(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with layers as (
      select store_id, coalesce(sum(remaining_quantity * unit_cost), 0) as layer_value
      from stock_layers where org_id = ${orgId} group by store_id
    ), acct as (
      select l.store_id, sum(l.debit - l.credit) as account_value
      from journal_lines l join accounts a on a.id = l.account_id
      where a.org_id = ${orgId} and a.code in ('1310','1320','1330') and l.store_id is not null
      group by l.store_id
    )
    select coalesce(layers.store_id, acct.store_id) as store_id, s.name as store_name,
           coalesce(layers.layer_value, 0)::text as layer_value,
           coalesce(acct.account_value, 0)::text as account_value
    from layers full outer join acct on layers.store_id = acct.store_id
    join stores s on s.id = coalesce(layers.store_id, acct.store_id)
    where abs(coalesce(layers.layer_value, 0) - coalesce(acct.account_value, 0)) > 0.005
  `)) as unknown as { store_id: string; store_name: string; layer_value: string; account_value: string }[];

  return rows.map((r) => ({
    kind: 'inventoryControlDoesNotMatchValuation',
    key: `inventoryControlDoesNotMatchValuation:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name}: FIFO layers total ${peso(Number(r.layer_value))} but 1310+1320+1330 total ` +
      `${peso(Number(r.account_value))}. Inventory does not tie to the ledger.`,
  }));
}

/**
 * ⭐ T-186's question: a CLOSED shift whose closing count did not match the ledger.
 *
 * ⛔ **This is the COUNTED variance, and it is the one that DOES name a person.** Its sibling
 * `tillFloatOffTarget` compares the LEDGER to a target and means the office should replenish;
 * this compares a PHYSICAL COUNT to the ledger and means cash is missing from the pocket.
 * T-153 §13.4 exists because reading one as the other charges somebody for a delivery they paid
 * for correctly — so both messages say which kind they are, in as many words.
 *
 * Soft, not hard: the trial balance ties either way. A shortage is a business problem, not a
 * ledger imbalance, and blocking a close on it would push people to fudge a count to keep
 * trading — the same reasoning T-143 records for not blocking on an open remittance variance.
 */
export async function tillCountVarianceOpen(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select l.id::text                          as line_id,
           s.store_id::text                    as store_id,
           s.business_date::text               as business_date,
           s.shift_no::text                    as shift_no,
           ma.name                             as name,
           (l.counted - l.expected)::text      as variance,
           coalesce(p.display_name, '')           as closed_by_name
    from till_count_lines l
    join till_custody_shifts s on s.id = l.shift_id
    join money_accounts ma on ma.id = l.money_account_id
    left join persons p on p.id = s.closed_by
    where s.org_id = ${orgId}
      and s.status = 'closed'
      and l.moment = 'close'
      and l.counted <> l.expected
      -- Already charged: a posted shortage is answered, and re-reporting it would have
      -- somebody chase a debt that is already on the books against a named person.
      and not exists (
        select 1 from journal_entries je
        where je.org_id = s.org_id
          and je.source_type = 'tillcountshortage'
          and je.source_id = l.id::text
          and je.status <> 'draft'
      )
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => {
    const variance = Number(r.variance);
    const who = r.closed_by_name ? ` Closed by ${r.closed_by_name}.` : '';
    // ⚠️ The magnitude is formatted, never the signed number — `peso(-500)` renders "₱-500.00",
    // which has bitten this file's siblings three times. The DIRECTION is a word, not a minus sign.
    const magnitude = peso(Math.abs(variance));
    return {
      kind: 'tillCountVarianceOpen',
      key: `tillCountVarianceOpen:${r.line_id}`,
      storeId: String(r.store_id),
      severity: 'soft' as const,
      detail:
        `${r.name}, ${r.business_date} shift ${r.shift_no}.${who} ` +
        (variance < 0
          ? `⭐ ${magnitude} SHORT ON A PHYSICAL COUNT — cash that should have been in the pocket ` +
            'was not. ⚠️ This one IS chargeable to the cashier who held it, unlike a ledger ' +
            'shortfall. Charge it or write it off; it will not clear on its own.'
          : `${magnitude} OVER on a physical count. ⛔ An overage posts nothing at all — it is ` +
            'money that was never in the books, and it goes to the tip box. Record the decision ' +
            'so the count stops being reported as unanswered.'),
    };
  });
}

/**
 * ⭐ **T-199 — the alarm that notices the sweep stopped, and the cheapest reliability here.**
 *
 * ⛔ A check that asks *"did the cron run?"* needs something else scheduled to ask it. Turtles.
 * So this detects the missing **OUTCOME** instead: *"three shifts from two days ago are still
 * open"* is sitting in the data, is derived on read, and is true whether or not anything is
 * scheduled — **including when the sweep itself is dead**.
 *
 * ⚠️ It is the control that would have caught all three of this business's historical failures:
 * v1's depreciation cron that never existed, POS's holiday calendar that shipped unscheduled, and
 * POS's weather job. In every case the code was fine and nobody noticed for months.
 *
 * ⛔ **`hard` severity, and deliberately so.** An open day is unpayable and unpaid — `payableDays`
 * excludes it and `resolveStatus` refuses to promote it — so closing a period over one books a
 * month that still owes somebody wages.
 */
/**
 * ⭐ T-178 — the tell that the 15-day order-wastage backstop is not running (DEF-044's shape,
 * restated for a new module). A tracked wastage still `open` or `disputed` well past its own
 * 15-day clock is exactly what the backstop exists to close; if one is sitting here, either the
 * scheduler job (`order_wastage_backstop`) is not firing, or it fired and failed on that row.
 *
 * ⚠️ A generous default threshold (`20`, not `15`) — a wastage genuinely closed ON day 15 by a
 * scheduled run that fires once a day should not flap this finding every single time it is a few
 * hours late; this is a "the job looks dead" alarm, not a live restatement of the SLA itself.
 */
export async function orderWastageOpenPastBackstop(
  tx: Tx,
  orgId: string,
  thresholdDays = 20,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select w.store_id::text as store_id, s.name as store_name, count(*)::int as n,
           min(w.opened_at)::text as oldest, coalesce(sum(w.amount), 0)::text as amount
    from order_wastages w
    join stores s on s.id = w.store_id
    where w.org_id = ${orgId} and w.type_mode = 'tracked'
      and w.status in ('open', 'disputed')
      and w.opened_at < now() - (${thresholdDays} || ' days')::interval
    group by w.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string; amount: string }[];

  return rows.map((r) => ({
    kind: 'orderWastageOpenPastBackstop',
    key: `orderWastageOpenPastBackstop:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n} order wastage${r.n === 1 ? '' : 's'} worth ${peso(Number(r.amount))} still ` +
      `open past the 15-day backstop, the oldest opened ${r.oldest}. ⚠️ If this keeps appearing, ` +
      'the `order_wastage_backstop` scheduler job is not running: check that its timer is installed on the host.',
  }));
}

/**
 * ⭐ **T-220 / DEF-184 — goods signed for that never reached a stock balance, and nobody was told.**
 *
 * `confirmReceipt` correctly refuses to add a branch item denominated in `g` from a commissary
 * dispatch in `kg`: it skips the line entirely — no movement, no layer. ⛔ **Skipping is right and
 * must not be "fixed":** adding commissary-denominated quantity onto a branch balance the branch
 * reads in its own unit is the corruption the check exists to prevent, and debiting `1310` for goods
 * the stock ledger never received puts account and subledger permanently out of tie (T-173).
 *
 * ⚠️ **The defect was the silence, not the skip.** The line pushed an explanation onto
 * `unitMismatches`, which `confirmReceipt` returns and **every production caller discarded**.
 *
 * ## ⛔ DEF-188 — this shipped WRONG once, and the corrections are the interesting part
 *
 * The first version asked *"has this LINE got a `stock_movements` row?"* and reported two Lipa lines
 * as never received. **Both had their stock.** `confirmReceipt` writes
 * `source_id = orderLineIdByLineId[lineId] ?? orderId`, and DEF-140's comment claims "every real
 * path" supplies the map — dev data carries **both shapes at once**, across seven orders. Every
 * finding it produced was false, and its tests agreed with it because they used line-keyed fixtures.
 *
 * ⚠️ The obvious repair — *also accept a movement under the order id* — has a **live** blind spot,
 * not a theoretical one: multi-line orders exist today, so one order-keyed `transfer_in` would
 * suppress the finding for every line of that order, including one that genuinely never arrived.
 * That trades a false positive for a silent miss at `hard` severity, on exactly the case this
 * detector exists for.
 *
 * ⭐ **So it compares QUANTITIES per order, not the existence of a row.** What the branch signed for
 * across an order's countable lines, against what actually moved into its ledger under *either*
 * `source_id` shape. A shortfall is real regardless of which shape the writer used, and a multi-line
 * order stays detectable.
 *
 * ⛔ **And it reports no peso figure at all, deliberately.** The first version said the amount was
 * *"sitting in 1340 Inventory in transit"* — `1340` is carried at COST and held ₱180.00 while the
 * detector reported ₱1,400.00 at the transfer rate. That is DEF-175's wrong-basis mistake committed
 * in a detector written *after* DEF-175 was filed. A quantity short and the orders it happened on
 * are what a manager acts on; a synthetic peso number here would be a third basis nobody asked for.
 *
 * ⛔ **`hard`.** Goods are physically at the branch, paid for, and absent from its stock ledger, so
 * every valuation and usage figure for that item is wrong until it is fixed.
 */
export async function commissaryUnitMismatch(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    with countable as (
      select o.id                              as order_id,
             c.counterparty_store_id           as branch_id,
             s.name                            as store_name,
             o.received_at                     as received_at,
             sum(l.received_quantity)          as signed_for
      from trade_order_lines l
      join trade_orders o on o.id = l.order_id
      join customers c on c.id = o.customer_id
      join stores s on s.id = c.counterparty_store_id
      where l.org_id = ${orgId}
        and o.status = 'received'
        and c.counterparty_store_id is not null
        and l.is_ledger_only = false
        and l.received_quantity is not null
        and l.received_quantity > 0
      group by o.id, c.counterparty_store_id, s.name, o.received_at
    ),
    moved as (
      select ct.order_id,
             coalesce(sum(m.quantity), 0) as into_ledger
      from countable ct
      left join stock_movements m
        on m.source_type = 'trade_order_receipt'
       and m.quantity > 0
       and (m.source_id = ct.order_id
            or m.source_id in (select l2.id from trade_order_lines l2 where l2.order_id = ct.order_id))
      group by ct.order_id
    )
    select ct.branch_id::text                          as store_id,
           ct.store_name                               as store_name,
           count(*)::int                               as n_orders,
           round(sum(ct.signed_for - mv.into_ledger), 3)::text as short_qty,
           min(ct.received_at)::text                   as oldest
    from countable ct
    join moved mv on mv.order_id = ct.order_id
    -- 0.001 matches the base-unit scale used everywhere else; a rounding whisker is not a finding.
    where (ct.signed_for - mv.into_ledger) > 0.001
    group by ct.branch_id, ct.store_name
  `)) as unknown as {
    store_id: string; store_name: string; n_orders: number; short_qty: string; oldest: string;
  }[];

  return rows.map((r) => ({
    kind: 'commissaryUnitMismatch',
    key: `commissaryUnitMismatch:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} signed for goods on ${r.n_orders} commissary order${r.n_orders === 1 ? '' : 's'} ` +
      `that never reached its stock ledger — ${r.short_qty} in base units short, the oldest received ` +
      `${String(r.oldest).slice(0, 10)}. Almost always a base-unit mismatch between the branch item ` +
      'and the commissary item: the receipt refused to add the quantity rather than corrupt the ' +
      'balance. Fix the branch item base unit, then confirm the receipt again.',
  }));
}

/**
 * ⭐ **T-220 — T-163's deferred detector, built now that its blocker is gone (DEF-185).**
 *
 * T-163 deferred this because *"there is no receipt document yet to age"*. **T-166 shipped delivery
 * documents**, and nothing re-checked the deferral — which is the expired-deferral class this task
 * exists to close.
 *
 * A `2120` balance is stock on the shelf, costed, whose invoice never arrived: the payable is
 * provisional and the true cost is whatever the receipt guessed. `soft` — an ageing prompt, not a
 * books-do-not-tie fault.
 *
 * ⚠️ **Per STORE, and pooled — not per supplier.** `2120` is deliberately **not** a party-requiring
 * account (T-118 set `requires_party` on exactly nine control accounts and this is not one), and
 * `postReceiptValue` writes *"one credit to 2120 for the whole receipt — the per-item detail is the
 * layers, which is the subledger; splitting the credit would put detail in two places and tie
 * neither."* A first draft of this detector grouped by `party_id` and was refused outright by
 * `journal_lines_check_party_requirement`. **The database said no, and it was right.**
 *
 * ⭐ So the balance is a POOL, and the age comes from a FIFO walk over its own credits — the same
 * shape `serviceChargeFloatAgeing` uses for the same reason. `manila_today` is carried back as a
 * column so the age is measured against Postgres's clock, in Manila, read once (T-218).
 */
export async function grniNotAtRest(
  tx: Tx,
  orgId: string,
  thresholdDays = 30,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.store_id::text                        as store_id,
           st.name                                  as store_name,
           je.entry_date::text                      as entry_date,
           coalesce(sum(jl.credit), 0)::text        as credited,
           coalesce(sum(jl.debit), 0)::text         as debited,
           ${MANILA_TODAY}::text                    as manila_today
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join stores st on st.id = jl.store_id
    where je.org_id = ${orgId} and a.code = '2120' and je.status <> 'draft'
    group by jl.store_id, st.name, je.entry_date
    order by jl.store_id, je.entry_date asc
  `)) as unknown as {
    store_id: string; store_name: string; entry_date: string;
    credited: string; debited: string; manila_today: string;
  }[];

  const byStore = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byStore.get(r.store_id) ?? [];
    list.push(r);
    byStore.set(r.store_id, list);
  }

  const findings: DetectedFinding[] = [];
  for (const [storeId, entries] of byStore) {
    const balance = entries.reduce((n, r) => n + Number(r.credited) - Number(r.debited), 0);
    if (balance < 0.005) continue;

    // FIFO: clear the oldest credits with everything ever debited against this store's pool.
    let remainingDebits = entries.reduce((n, r) => n + Number(r.debited), 0);
    let oldestUncleared: string | null = null;
    for (const r of entries) {
      const credited = Number(r.credited);
      if (credited <= 0) continue;
      if (remainingDebits >= credited - 0.005) {
        remainingDebits -= credited;
        continue;
      }
      oldestUncleared = r.entry_date;
      break;
    }
    if (oldestUncleared === null) continue;

    const ageDays = daysBetweenDates(oldestUncleared, String(entries[0]!.manila_today));
    if (ageDays <= thresholdDays) continue;

    findings.push({
      kind: 'grniNotAtRest',
      key: `grniNotAtRest:${storeId}`,
      storeId,
      severity: 'soft' as const,
      detail:
        `${entries[0]!.store_name} holds ${peso(balance)} of received-but-uninvoiced stock in 2120 ` +
        `GRNI, the oldest uncleared since ${oldestUncleared} (${ageDays} days). The goods are on the ` +
        'shelf and costed; the invoice never arrived. Chase it — until it does the payable stays ' +
        'provisional and the true cost is whatever the receipt guessed.',
    });
  }
  return findings;
}

/**
 * ⭐ **T-218 / DEF-176 — the receiving-dispute twin of `orderWastageOpenPastBackstop` above.**
 *
 * `docs/plans/phase-6-reporting-and-dashboards.md` §6 Q3 closed one of Ian’s open questions by
 * promising this detector *"(`receivingDisputeOverdue`, T-213)"*. T-213 shipped eight detectors and
 * this was not among them — a gap that stayed invisible because **both tasks read as done**.
 *
 * ⚠️ **The asymmetry it exists to expose.** v1 runs a 15-day forced-resolution backstop for order
 * and channel *wastage* disputes and has nothing equivalent for *receiving* disputes, on the strength
 * of a code comment arguing one is unnecessary because *"disputes get resolved."* Live, that
 * assumption is about 44% false: **4 of 9 open disputes already exceed 15 days.**
 *
 * ⛔ **A `deferred` row still counts, and still ages.** A deferral is *"a promise to decide by a
 * date, not an exemption"* (T-174’s schema header) — exempting it would make the detector agree
 * with the postponement instead of observing it, which is the whole failure mode v1’s stored
 * `resolved` flag has.
 *
 * ⚠️ `store_id` is the **COMMISSARY’s**, not the branch’s: the stranded value sits on its books and
 * its manager disposes of it (T-174 invariant 11).
 *
 * ⚠️ `value` is **AT COST** — the un-received share of dispatch cost, not the transfer rate
 * (DEF-175). The wording says so, because a peso figure beside a transfer-rate figure invites
 * exactly the comparison that defect is about.
 *
 * ⛔ 15 days, not 20 — unlike the wastage backstop above there is **no scheduled job** to be
 * generously late here, so there is nothing to flap against: the threshold is the SLA itself.
 */
export async function receivingDisputeOverdue(
  tx: Tx,
  orgId: string,
  thresholdDays = 15,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name, count(*)::int as n,
           coalesce(sum(d.value), 0)::text as amount,
           max(${MANILA_TODAY} - d.created_at::date)::int as oldest_age_days,
           (count(*) filter (where d.status = 'deferred'))::int as deferred_n
    from trade_discrepancies d
    join stores s on s.id = d.store_id
    where d.org_id = ${orgId}
      -- ⭐ The SAME predicate tradeDiscrepanciesRepo.unresolved and .blocking use. That file's
      -- header states the invariant: one source, several consumers. This is a fourth consumer,
      -- never a fourth definition — a dispute that blocks a sales day and one this finding
      -- reports must not be able to differ.
      and d.status <> 'resolved'
      and (${MANILA_TODAY} - d.created_at::date) > ${thresholdDays}
    group by d.store_id, s.name
  `)) as unknown as {
    store_id: string; store_name: string; n: number; amount: string;
    oldest_age_days: number; deferred_n: number;
  }[];

  return rows.map((r) => ({
    kind: 'receivingDisputeOverdue',
    key: `receivingDisputeOverdue:${r.store_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} has ${r.n} receiving dispute${r.n === 1 ? '' : 's'} unresolved past ` +
      `${thresholdDays} days, worth ${peso(Number(r.amount))} at cost still stranded in 1340 ` +
      `Inventory in transit — the oldest ${r.oldest_age_days} days old` +
      (r.deferred_n > 0
        ? `, ${r.deferred_n} of them deferred (a deferral is a promise to decide, not an exemption)`
        : '') +
      '. Dispose of each as audit, loss, charge or late receipt.',
  }));
}

export async function openShiftsStale(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  // ⚠️ Two days, matching the sweep's own tolerance: a night shift belongs to the previous business
  // day, and an offline terminal replays punches hours after the fact.
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id,
           count(*)::int    as n,
           min(d.shift_day)::text as oldest
      from attendance_days d
     where d.org_id = ${orgId}
       and d.status = 'open'
       and d.frozen_at is null
       and d.shift_day < ((now() at time zone 'Asia/Manila')::date - 2)
     group by d.store_id
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    kind: 'openShiftsStale',
    key: `openShiftsStale:${r.store_id}`,
    storeId: String(r.store_id),
    severity: 'hard' as const,
    detail:
      `${r.n} shift(s) are still clocked in with no clock-out, the oldest from ${r.oldest}. ` +
      '⛔ An open day is never paid — payroll excludes it and a recompute will not clear it — so ' +
      'this is unpaid work sitting in the system. ⚠️ If this keeps appearing, the nightly sweep ' +
      '(`npm run attendance-sweep`) is not running: check that its timer is installed on the host.',
  }));
}

/**
 * T-177 Sec2 - the one Phase 3 failure the exit gate cannot catch. A sale that never decrements
 * stock leaves cost never reaching COGS, so the inventory-control-equals-valuation gate stays
 * green on BOTH sides being equally wrong - inventoryControlDoesNotMatchValuation above cannot
 * see this. This detector asks a different question: for a store that has opted into POS-driven
 * consumption (it has at least one active pos_item_map), did a VERIFIED sales day get a
 * FINALIZED pull?
 *
 * Bounded to the last 14 days (read-cost discipline) - an older gap is still real but is no
 * longer this detector's job to nag about forever; it becomes a standing data-quality fact for
 * the daily review to log once, not a permanent hard finding.
 */
export async function posUsagePullNotRun(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name,
           count(*)::int as n, min(d.business_date)::text as oldest
      from sales_days d
      join stores s on s.id = d.store_id
     where d.org_id = ${orgId}
       and d.status = 'verified'
       and d.business_date >= ((now() at time zone 'Asia/Manila')::date - 14)
       and exists (select 1 from pos_item_maps m where m.store_id = d.store_id and m.status = 'active')
       and not exists (
         select 1 from pos_usage_pulls p where p.sales_day_id = d.id and p.status = 'finalized'
       )
     group by d.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'posUsagePullNotRun',
    key: `posUsagePullNotRun:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} has ${r.n} verified sales day${r.n === 1 ? '' : 's'} with no finalized POS ` +
      `usage pull, the oldest from ${r.oldest}. Stock that was sold but never consumed here means ` +
      'its cost never reached COGS, so gross margin looks better than it is until the next ' +
      'physical count explains the gap as shrinkage.',
  }));
}

// -----------------------------------------------------------------------------------------
// T-213 — OIL wave 2, the operational detectors. docs/tasks/213-oil-wave-2-operational-detectors.md.
// -----------------------------------------------------------------------------------------

/**
 * ⭐ A business day POS already reported sales for, still sitting unposted. The ledger's own
 * silence is the finding — `posSourced`/`status`/`journalEntryId` already say everything a mirror-
 * collection status filter would have to reconstruct.
 *
 * ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date` — migration 0112's own
 * comment states the reason as a standing bible discipline: `current_date` follows the SESSION
 * timezone, and a production database running UTC would roll this threshold eight hours off
 * Manila's actual business day.
 */
export async function salesDayUnposted(tx: Tx, orgId: string, thresholdDays = 3): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name,
           count(*)::int as n, min(d.business_date)::text as oldest
      from sales_days d
      join stores s on s.id = d.store_id
     where d.org_id = ${orgId}
       and d.pos_sourced = true
       and d.status in ('open', 'submitted')
       and d.business_date < (((now() at time zone 'Asia/Manila')::date) - (${thresholdDays} || ' days')::interval)
     group by d.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'salesDayUnposted',
    key: `salesDayUnposted:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} has ${r.n} POS-sourced sales day${r.n === 1 ? '' : 's'} still unposted, the ` +
      `oldest from ${r.oldest}. Revenue POS already reported has not reached the ledger.`,
  }));
}

/**
 * ⚠️ **Corrected from the phase-6 plan's `expenseMissingCategory`.** `expenses.category_id` is
 * `NOT NULL` (T-130) — a missing category cannot exist. What can exist is a draft stuck because
 * its category resolves to no mapped account, which invariant 7 refuses to post. That is the
 * live, derivable condition v1's materiality-gated sweep is standing in for now.
 *
 * ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date` — see `salesDayUnposted`.
 */
export async function expenseCategoryUnpostable(
  tx: Tx,
  orgId: string,
  thresholdDays = 3,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select e.id as expense_id, e.store_id::text as store_id, s.name as store_name,
           e.total_amount::text as amount, e.business_date::text as business_date,
           ec.category as category
      from expenses e
      join stores s on s.id = e.store_id
      join expense_categories ec on ec.id = e.category_id
     where e.org_id = ${orgId}
       and e.status = 'draft'
       and ec.account_code is null
       and e.business_date < (((now() at time zone 'Asia/Manila')::date) - (${thresholdDays} || ' days')::interval)
  `)) as unknown as {
    expense_id: string;
    store_id: string;
    store_name: string;
    amount: string;
    business_date: string;
    category: string;
  }[];

  return rows.map((r) => ({
    kind: 'expenseCategoryUnpostable',
    key: `expenseCategoryUnpostable:${r.expense_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name}'s ${peso(Number(r.amount))} expense from ${r.business_date} is stuck in ` +
      `draft — category "${r.category}" has no account mapped, so it cannot post until one is.`,
  }));
}

/**
 * ⚠️ **Corrected from the phase-6 plan's `orphanExpense`.** `supplier_invoice_id` is `NOT NULL` and
 * DB-enforced verified-at-insert (`expenses_require_verified_invoice`), so an expense can never
 * lack an invoice. But a previously-verified invoice CAN be voided afterwards — the void-cascade
 * design keeps the verified stamp as history rather than clearing it — so the real orphan
 * condition is a live link whose evidence was voided out from under it after the fact.
 */
export async function expenseInvoiceVoidedAfterLink(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select e.id as expense_id, e.store_id::text as store_id, s.name as store_name,
           e.total_amount::text as amount, si.invoice_no as invoice_no
      from expenses e
      join stores s on s.id = e.store_id
      join supplier_invoices si on si.id = e.supplier_invoice_id
     where e.org_id = ${orgId}
       and e.status <> 'voided'
       and si.status = 'voided'
  `)) as unknown as {
    expense_id: string;
    store_id: string;
    store_name: string;
    amount: string;
    invoice_no: string | null;
  }[];

  return rows.map((r) => ({
    kind: 'expenseInvoiceVoidedAfterLink',
    key: `expenseInvoiceVoidedAfterLink:${r.expense_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name}'s ${peso(Number(r.amount))} expense links invoice ` +
      `${r.invoice_no ?? '(no number)'}, which was later voided. The expense still stands on ` +
      'evidence that no longer exists.',
  }));
}

/**
 * ⭐ One statistical flag, no baseline table to maintain: the trailing-N-receipt median for the
 * same item, read from a LATERAL subquery rather than a window frame — an ordered-set aggregate's
 * frame support over ROWS is not guaranteed portable, and this needs to be right the first time.
 */
export async function receiptPriceSpike(
  tx: Tx,
  orgId: string,
  windowSize = 10,
  pctThreshold = 50,
): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select cur.line_id, cur.store_id::text as store_id, s.name as store_name,
           i.name as item_name, cur.unit_cost::text as unit_cost,
           cur.delivered_on::text as delivered_on, med.trailing_median::text as trailing_median
      from (
        select dl.id as line_id, d.store_id, d.org_id, dl.item_id, dl.unit_cost, d.delivered_on
          from delivery_lines dl
          join deliveries d on d.id = dl.delivery_id
         where d.status = 'received'
      ) cur
      join stores s on s.id = cur.store_id
      join items i on i.id = cur.item_id
      cross join lateral (
        select percentile_cont(0.5) within group (order by prior.unit_cost) as trailing_median
          from (
            select dl2.unit_cost
              from delivery_lines dl2
              join deliveries d2 on d2.id = dl2.delivery_id
             where d2.status = 'received'
               and dl2.item_id = cur.item_id
               and d2.store_id = cur.store_id
               and d2.delivered_on < cur.delivered_on
             order by d2.delivered_on desc
             limit ${windowSize}
          ) prior
      ) med
     where cur.org_id = ${orgId}
       and med.trailing_median is not null
       and cur.unit_cost > med.trailing_median * (1 + ${pctThreshold}::numeric / 100)
  `)) as unknown as {
    line_id: string;
    store_id: string;
    store_name: string;
    item_name: string;
    unit_cost: string;
    delivered_on: string;
    trailing_median: string;
  }[];

  return rows.map((r) => ({
    kind: 'receiptPriceSpike',
    key: `receiptPriceSpike:${r.line_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} received ${r.item_name} on ${r.delivered_on} at ${peso(Number(r.unit_cost))}, ` +
      `well above its trailing median of ${peso(Number(r.trailing_median))}. Worth a second look ` +
      'before this cost flows into landed cost and FIFO.',
  }));
}

/** A supplier's first-ever received delivery — a `NOT EXISTS` over prior receipts, nothing stored. */
export async function newVendorFirstPurchase(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.id as delivery_id, d.store_id::text as store_id, s.name as store_name,
           sup.name as supplier_name, d.delivered_on::text as delivered_on
      from deliveries d
      join stores s on s.id = d.store_id
      join suppliers sup on sup.id = d.supplier_id
     where d.org_id = ${orgId}
       and d.kind = 'supplier'
       and d.status = 'received'
       and not exists (
         select 1 from deliveries d2
          where d2.supplier_id = d.supplier_id
            and d2.status = 'received'
            and d2.delivered_on < d.delivered_on
       )
  `)) as unknown as {
    delivery_id: string;
    store_id: string;
    store_name: string;
    supplier_name: string;
    delivered_on: string;
  }[];

  return rows.map((r) => ({
    kind: 'newVendorFirstPurchase',
    key: `newVendorFirstPurchase:${r.delivery_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} received its first delivery from ${r.supplier_name} on ${r.delivered_on}. ` +
      'Not a problem — a nudge to confirm the supplier is who they say they are.',
  }));
}

/**
 * ⭐ **Extends `cashRequestFloatAgeing`, does not duplicate it.** That detector only sees the
 * `cash_requests` document; `docs/POSTING-PATTERNS.md` shows `1230` is also debited by salary
 * advances and till-shift shortages, neither of which is a `cash_requests` row. This reads the
 * account itself — every party's live balance, whatever posted it.
 *
 * ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date` — see `salesDayUnposted`.
 * ⛔ **`cashRequestFloatAgeing` itself does not follow this** (it compares against bare
 * `current_date`, as do `supplierCreditAgeing`, `customerCreditAgeing` and
 * `reimbursablePayableAgeing`) — logged as a defect, not fixed here; out of this task's scope.
 */
export async function advanceUnliquidated(tx: Tx, orgId: string, thresholdDays = 30): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select jl.party_id, coalesce(p.display_name, jl.party_id) as person_name,
           sum(jl.debit - jl.credit)::text as balance, min(je.entry_date)::text as oldest
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      left join persons p on p.id::text = jl.party_id
     where je.org_id = ${orgId}
       and je.status <> 'draft'
       and a.code = '1230'
       and jl.party_type = 'employee'
     group by jl.party_id, p.display_name
    having sum(jl.debit - jl.credit) > 0.005
       and min(je.entry_date) < (((now() at time zone 'Asia/Manila')::date) - (${thresholdDays} || ' days')::interval)
  `)) as unknown as { party_id: string; person_name: string; balance: string; oldest: string }[];

  return rows.map((r) => ({
    kind: 'advanceUnliquidated',
    key: `advanceUnliquidated:${r.party_id}`,
    storeId: null,
    severity: 'soft' as const,
    detail:
      `${r.person_name} carries a ${peso(Number(r.balance))} balance on 1230 open since ` +
      `${r.oldest}, from a salary advance, a shortage charge, or a cash request — whichever it ` +
      'was, it has not been liquidated.',
  }));
}

/**
 * ⚠️ **Corrected from the phase-6 plan's department-aware framing.** `departments` carries no
 * store roster and no store↔department linking table, so "which departments does this store
 * have" cannot be derived. This instead covers `posUsagePullNotRun`'s exact complement: a store
 * with NO active `pos_item_maps` — so that detector's own gate never looks at it — that verified a
 * sales day and recorded not one single usage entry of any kind.
 */
export async function usageRecordMissing(tx: Tx, orgId: string): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select d.store_id::text as store_id, s.name as store_name,
           count(*)::int as n, min(d.business_date)::text as oldest
      from sales_days d
      join stores s on s.id = d.store_id
     where d.org_id = ${orgId}
       and d.status = 'verified'
       and not exists (select 1 from pos_item_maps m where m.store_id = d.store_id and m.status = 'active')
       and not exists (
         select 1 from stock_usage_records u
          where u.store_id = d.store_id and u.kind = 'usage' and u.used_on = d.business_date
       )
     group by d.store_id, s.name
  `)) as unknown as { store_id: string; store_name: string; n: number; oldest: string }[];

  return rows.map((r) => ({
    kind: 'usageRecordMissing',
    key: `usageRecordMissing:${r.store_id}`,
    storeId: r.store_id,
    severity: 'hard' as const,
    detail:
      `${r.store_name} has ${r.n} verified sales day${r.n === 1 ? '' : 's'} with no usage recorded ` +
      `at all (no POS mapping active here either), the oldest from ${r.oldest}. Nothing here has ` +
      'told the books what was consumed.',
  }));
}

/** An open FIFO layer for a `meat_slab` item, ageing — a join now that layers exist to age. */
export async function meatSlabStale(tx: Tx, orgId: string, thresholdDays = 14): Promise<DetectedFinding[]> {
  const rows = (await tx.execute(sql`
    select l.id as layer_id, l.store_id::text as store_id, s.name as store_name,
           i.name as item_name, l.remaining_quantity::text as remaining_quantity,
           l.received_at::text as received_at
      from stock_layers l
      join stores s on s.id = l.store_id
      join items i on i.id = l.item_id
     where l.org_id = ${orgId}
       and i.kind = 'meat_slab'
       and l.remaining_quantity > 0
       and l.received_at < (now() - (${thresholdDays} || ' days')::interval)
  `)) as unknown as {
    layer_id: string;
    store_id: string;
    store_name: string;
    item_name: string;
    remaining_quantity: string;
    received_at: string;
  }[];

  return rows.map((r) => ({
    kind: 'meatSlabStale',
    key: `meatSlabStale:${r.layer_id}`,
    storeId: r.store_id,
    severity: 'soft' as const,
    detail:
      `${r.store_name} still has ${r.remaining_quantity} of a ${r.item_name} slab received ` +
      `${r.received_at}, past the freshness window. Worth a look before it becomes wastage.`,
  }));
}

// ---------------------------------------------------------------------------------------------
// T-214 — occurrences: the clock a DetectedFinding does not carry
// ---------------------------------------------------------------------------------------------

export interface OpenOccurrenceRow {
  readonly id: string;
  readonly storeId: string | null;
  readonly findingKey: string;
  readonly kind: string;
  readonly openedOn: string;
}

/** Every occurrence still open for an org. The daily job's working set. */
export async function openOccurrences(tx: Tx, orgId: string): Promise<OpenOccurrenceRow[]> {
  const rows = await tx.execute(sql`
    select id, store_id, finding_key, kind, opened_on::text as opened_on
    from finding_occurrences
    where org_id = ${orgId} and closed_on is null
    order by opened_on
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    storeId: r.store_id == null ? null : String(r.store_id),
    findingKey: String(r.finding_key),
    kind: String(r.kind),
    openedOn: String(r.opened_on),
  }));
}

/**
 * Record that a detector reported this key today.
 *
 * ⭐ **Idempotent by the partial unique index, not by a read-then-write.** Running the job twice in
 * a day advances `last_seen_on` to the same date and changes nothing else — which matters because a
 * systemd timer that fires twice after a clock change must not open a second occurrence.
 *
 * ⚠️ The conflict target must repeat the index's `coalesce` expression exactly, or Postgres cannot
 * match it to the index and the upsert becomes a plain insert that violates it.
 */
export async function observeFinding(
  tx: Tx,
  input: { orgId: string; storeId: string | null; findingKey: string; kind: string },
): Promise<void> {
  await tx.execute(sql`
    insert into finding_occurrences (org_id, store_id, finding_key, kind, opened_on, last_seen_on)
    values (${input.orgId}, ${input.storeId}, ${input.findingKey}, ${input.kind},
            ${MANILA_TODAY}, ${MANILA_TODAY})
    on conflict (org_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), finding_key)
      where closed_on is null
    do update set last_seen_on = ${MANILA_TODAY}
  `);
}

/** Close one occurrence. ⛔ Only ever called for a key whose question the run actually asked. */
export async function closeOccurrence(tx: Tx, occurrenceId: string): Promise<void> {
  await tx.execute(sql`
    update finding_occurrences
    set closed_on = ${MANILA_TODAY}
    where id = ${occurrenceId} and closed_on is null
  `);
}

/** The date this record began — what the screen must disclose, because there is no backfill. */
export async function firstObservationDate(tx: Tx, orgId: string): Promise<string | null> {
  const rows = await tx.execute(sql`
    select min(opened_on)::text as d from finding_occurrences where org_id = ${orgId}
  `);
  const d = (rows as unknown as Record<string, unknown>[])[0]?.d;
  return d == null ? null : String(d);
}

export interface StoreScorecardRow {
  readonly storeId: string | null;
  readonly raised: number;
  readonly cleared: number;
  readonly stillOpen: number;
  /**
   * ⭐ Still open, and open LONGER than the grace window — so it has had a fair chance and counts
   * against the store. See `scorecardByStore` for why this is not simply `stillOpen`.
   */
  readonly openPastGrace: number;
  /** Still open but younger than the grace window: neither a win nor a loss yet. */
  readonly pending: number;
  /** Mean whole days open→closed over the cleared ones. Null when nothing cleared. */
  readonly avgDaysToClear: number | null;
}

/**
 * ⭐ The scorecard's arithmetic, in ONE statement, per store.
 *
 * ⚠️ **Grouped by `store_id` including NULL** — org-wide findings (a trial balance belongs to no
 * branch) form their own row and must never be spread across stores, or every branch inherits the
 * admin's problems.
 *
 * ⛔ `avg` over `closed_on - opened_on` is whole Manila days, computed by Postgres in the same
 * statement as the rows it summarises. Do not recompute this in TypeScript from `Date.now()` —
 * that is DEF-172's two-clock defect, and `findings-single-clock.test.ts` guards this file.
 *
 * ## ⭐ Why `open_past_grace` exists, and why the clear rate is not `cleared / raised`
 *
 * **Found by looking at the rendered page, not by a test.** On the first day of the record every
 * store showed a score of **0** — every finding had been raised that morning and none had been
 * cleared, so `cleared / raised` was `0/2`. But a finding raised today has not been *ignored*; it
 * has not had a chance yet, and a screen that says a branch "responded badly" on the strength of
 * a few hours is worse than showing nothing.
 *
 * So an occurrence still open and YOUNGER than the grace window is **pending** — neither a win nor
 * a loss — and is excluded from the denominator entirely. The clear rate answers *"of the findings
 * that have had a fair chance, how many were cleared?"* When everything is still pending the
 * denominator is zero, the rate is null, and the score is null: correct, and exactly what invariant
 * 7 asks for.
 *
 * ⚠️ The grace window is the same 14 days as the speed horizon, deliberately — one number, one
 * meaning: *"long enough that not acting on it is a choice."*
 */
export async function scorecardByStore(
  tx: Tx,
  orgId: string,
  fromIsoDate: string,
  toIsoDate: string,
  graceDays = 14,
): Promise<StoreScorecardRow[]> {
  const rows = await tx.execute(sql`
    select
      store_id,
      count(*)::int                                        as raised,
      count(*) filter (where closed_on is not null)::int    as cleared,
      count(*) filter (where closed_on is null)::int        as still_open,
      count(*) filter (
        where closed_on is null and (${MANILA_TODAY} - opened_on) > ${graceDays}
      )::int                                               as open_past_grace,
      count(*) filter (
        where closed_on is null and (${MANILA_TODAY} - opened_on) <= ${graceDays}
      )::int                                               as pending,
      avg(closed_on - opened_on) filter (where closed_on is not null) as avg_days
    from finding_occurrences
    where org_id = ${orgId}
      and opened_on >= ${fromIsoDate}::date
      and opened_on <= ${toIsoDate}::date
    group by store_id
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    storeId: r.store_id == null ? null : String(r.store_id),
    raised: Number(r.raised),
    cleared: Number(r.cleared),
    stillOpen: Number(r.still_open),
    openPastGrace: Number(r.open_past_grace),
    pending: Number(r.pending),
    avgDaysToClear: r.avg_days == null ? null : Math.round(Number(r.avg_days) * 10) / 10,
  }));
}

// ---------------------------------------------------------------------------------------------
// T-214 — the view log
// ---------------------------------------------------------------------------------------------

/** ⛔ One row per person per Manila day. A refresh is not a second view. */
export async function recordFindingView(
  tx: Tx,
  input: { orgId: string; personId: string },
): Promise<void> {
  await tx.execute(sql`
    insert into finding_views (org_id, person_id, viewed_on)
    values (${input.orgId}, ${input.personId}, ${MANILA_TODAY})
    on conflict (org_id, person_id, viewed_on) do nothing
  `);
}

export interface LastViewRow {
  readonly personId: string;
  readonly displayName: string;
  readonly viewedOn: string;
  readonly daysAgo: number;
}

/**
 * Who last opened `/findings`, and how long ago.
 *
 * ⚠️ A `null` return is the useful answer, not a missing one: **nobody has ever opened this screen.**
 */
export async function lastFindingView(tx: Tx, orgId: string): Promise<LastViewRow | null> {
  const rows = await tx.execute(sql`
    select v.person_id, p.display_name, v.viewed_on::text as viewed_on,
           (${MANILA_TODAY} - v.viewed_on)::int as days_ago
    from finding_views v
    join persons p on p.id = v.person_id
    where v.org_id = ${orgId}
    order by v.viewed_on desc
    limit 1
  `);
  const r = (rows as unknown as Record<string, unknown>[])[0];
  if (!r) return null;
  return {
    personId: String(r.person_id),
    displayName: String(r.display_name),
    viewedOn: String(r.viewed_on),
    daysAgo: Number(r.days_ago),
  };
}
