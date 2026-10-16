/**
 * getUnpaidLiabilities - T-431 "Everything unpaid". docs/tasks/431-unpaid-liabilities-view.md.
 *
 * READ-ONLY and STORES NOTHING: every figure is worked out now from the module that owns it
 * (row 327; DEF-074). It never runs the recurring runner, never freezes a day, never writes an
 * audit row (`can()` is the non-logging probe; `authorize()` only logs a refusal).
 *
 * Six kinds, always, in this order. Kinds 1, 3, 4 are reconciled against the part of their ledger
 * account they explain (per STORE and account); the leftover is shown, never dropped.
 *
 * Wages (kind 5) and `2300` need `run_payroll` AT THAT STORE. The check is made here, in the
 * loader, before `previewPayRun` is called: a viewer without it gets no amount and no name.
 */
import { accessRepo, apRepo, liabilitiesRepo, loansRepo, unpaidLiabilitiesRepo, type Tx } from '@shareat/db';
import { authorize, can, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { ZERO, add, compare, isZero, money, subtract, type Money } from '@shareat/core/money';
import { previewPayRun } from '../payroll';

export type UnpaidKindId = 'supplier_invoices' | 'recurring_drafts' | 'register' | 'loans' | 'wages' | 'other_ledger';

export interface UnpaidLine {
  /** null = a ledger line posted with no store (shown as its own "No store" group). */
  storeId: string | null;
  name: string;
  counterparty: string | null;
  dueOn: string | null;
  amount: string;
  href: string;
  accountCode?: string;
  tag?: string;
  internal?: boolean;
}

export interface UnmatchedLeftover {
  accountCode: string;
  storeId: string | null;
  /** Ledger balance minus the kind's lines. Signed. */
  amount: string;
}

export interface UnpaidKind {
  id: UnpaidKindId;
  title: string;
  visible: boolean;
  unavailableReason?: string;
  needsReviewDays?: number;
  unratedDays?: number;
  lines: UnpaidLine[];
  unmatched: UnmatchedLeftover[];
  withheld?: { accountCode: string; storeId: string | null }[];
  subtotal: string | null;
}

export interface UnpaidLiabilities {
  kinds: UnpaidKind[];
  banners: UnmatchedLeftover[];
  totals: { booked: string; notYetBooked: string; grand: string; excludesWages: boolean };
}

const TITLES: Record<UnpaidKindId, string> = {
  supplier_invoices: 'Supplier invoices unpaid',
  recurring_drafts: 'Recurring bills drafted, not yet recorded',
  register: 'Other obligations',
  loans: 'Loans',
  wages: 'Wages worked, not yet paid',
  other_ledger: 'Other amounts owed in the books',
};

/** Kind 6 (ruling): 2900 suspense is OUT; 2250 is reserved and empty today; 2300 is payroll-staff-only. */
const OTHER_CODES = ['2120', '2130', '2140', '2150', '2160', '2210', '2220', '2230', '2240', '2250', '2300'] as const;
const WAGES_CODE = '2300';
const INTERNAL_CODE = '2150';
const FAR_PAST = '1970-01-01';
const FAR_FUTURE = '2999-12-31';

const isPositive = (v: Money): boolean => compare(v, ZERO) > 0;
const sumOf = (lines: { amount: string }[]): Money => add(ZERO, ...lines.map((l) => money(l.amount)));
const byDue = (a: UnpaidLine, b: UnpaidLine): number =>
  (a.dueOn ?? '9999-99-99').localeCompare(b.dueOn ?? '9999-99-99');

export async function getUnpaidLiabilities(
  tx: Tx,
  actor: Actor,
  input: { storeId?: string | null } = {},
): Promise<UnpaidLiabilities> {
  const orgId = actor.orgId;
  const { storeIds, authorizedStoreIds } = await resolveScope(tx, actor, input.storeId ?? undefined);

  // Who may see payroll money, store by store. `can` is the non-logging probe.
  const payrollStores: string[] = [];
  for (const s of authorizedStoreIds) if (await can(tx, actor, 'run_payroll', { storeId: s })) payrollStores.push(s);
  const payrollSet = new Set(payrollStores);

  const codes = ['2110', '2500', '2400', ...OTHER_CODES];
  const [openItems, drafts, liabilityRows, liabilityPositions, loanRows, loanPositions, ledger, names] = await Promise.all([
    apRepo.openItemsForStores(tx, orgId, storeIds),
    unpaidLiabilitiesRepo.unpaidRecurringDrafts(tx, orgId, storeIds),
    liabilitiesRepo.listLiabilities(tx, orgId, { includeRetired: true }),
    liabilitiesRepo.outstandingByLiabilityAndStore(tx, orgId, storeIds),
    loansRepo.listLoans(tx, orgId),
    loansRepo.outstandingByLoanAndStore(tx, orgId, storeIds),
    unpaidLiabilitiesRepo.ledgerBalancesByAccount(tx, orgId, codes, storeIds),
    unpaidLiabilitiesRepo.partyNames(tx, orgId),
  ]);

  // ---- kind 1 ------------------------------------------------------------------------------
  const k1: UnpaidLine[] = openItems.map((o) => ({
    storeId: o.storeId,
    name: `Invoice ${o.invoiceNo ?? o.particulars}`,
    counterparty: o.supplierName || null,
    dueOn: o.dueDate,
    amount: money(o.outstanding),
    href: `/ap/invoices/${o.supplierInvoiceId}`,
    ...(o.recurringName ? { tag: `from recurring: ${o.recurringName}` } : {}),
  }));

  // ---- kind 2 ------------------------------------------------------------------------------
  const k2: UnpaidLine[] = drafts.map((d) => ({
    storeId: d.storeId,
    name: d.templateName,
    counterparty: d.supplierName,
    dueOn: d.dueOn,
    amount: money(d.amount),
    href: `/expenses/${d.expenseId}`,
  }));

  // ---- kind 3 ------------------------------------------------------------------------------
  const liabilityById = new Map(liabilityRows.map((l) => [l.id, l]));
  const k3: UnpaidLine[] = [];
  for (const p of liabilityPositions) {
    const l = liabilityById.get(p.liabilityId);
    if (!l || !isPositive(money(p.outstanding))) continue;
    k3.push({
      storeId: p.storeId,
      name: l.name,
      counterparty: null,
      dueOn: l.dueOn,
      amount: money(p.outstanding),
      href: `/liabilities/${l.id}`,
    });
  }

  // ---- kind 4 ------------------------------------------------------------------------------
  const loanById = new Map(loanRows.map((l) => [l.id, l]));
  const k4: UnpaidLine[] = [];
  for (const p of loanPositions) {
    const l = loanById.get(p.loanId);
    if (!l || !isPositive(money(p.outstanding))) continue;
    k4.push({
      storeId: p.storeId,
      name: l.name,
      counterparty: l.lenderName,
      dueOn: null,
      amount: money(p.outstanding),
      href: `/loans/${l.id}`,
    });
  }

  // ---- leftovers: ledger balance per store/account minus the kind's lines --------------------
  const ledgerTotal = new Map<string, Money>(); // `${code}|${store}`
  for (const r of ledger) {
    const key = `${r.accountCode}|${r.storeId ?? ''}`;
    ledgerTotal.set(key, add(ledgerTotal.get(key) ?? ZERO, money(r.balance)));
  }
  const leftovers = (code: string, lines: UnpaidLine[]): UnmatchedLeftover[] => {
    const out: UnmatchedLeftover[] = [];
    const stores = new Set<string>(); // '' = no store
    for (const key of ledgerTotal.keys()) if (key.startsWith(`${code}|`)) stores.add(key.slice(code.length + 1));
    for (const l of lines) stores.add(l.storeId ?? '');
    for (const s of stores) {
      const explained = sumOf(lines.filter((l) => (l.storeId ?? '') === s));
      const left = subtract(ledgerTotal.get(`${code}|${s}`) ?? ZERO, explained);
      if (!isZero(left)) out.push({ accountCode: code, storeId: s === '' ? null : s, amount: left });
    }
    return out.sort((a, b) => (a.storeId ?? '').localeCompare(b.storeId ?? ''));
  };

  // ---- kind 6 ------------------------------------------------------------------------------
  const otherSet = new Set<string>(OTHER_CODES);
  const k6: UnpaidLine[] = [];
  const withheld = new Map<string, { accountCode: string; storeId: string | null }>();
  for (const r of ledger) {
    if (!otherSet.has(r.accountCode)) continue;
    const amount = money(r.balance);
    if (!isPositive(amount)) continue; // only what is OWED; an owed-to side shows nothing here
    if (r.accountCode === WAGES_CODE && (r.storeId === null || !payrollSet.has(r.storeId))) {
      withheld.set(r.storeId ?? '', { accountCode: WAGES_CODE, storeId: r.storeId });
      continue;
    }
    const internal = r.accountCode === INTERNAL_CODE;
    const counterparty =
      r.partyId === null
        ? null
        : r.partyType === 'store'
          ? (names.stores.get(r.partyId) ?? null)
          : r.partyType === 'employee' || r.partyType === 'person'
            ? (names.persons.get(r.partyId) ?? null)
            : null;
    k6.push({
      storeId: r.storeId,
      name: r.accountName,
      counterparty,
      dueOn: null,
      amount,
      href: r.storeId === null ? '/reports/trial-balance' : `/reports/trial-balance?store=${r.storeId}`,
      accountCode: r.accountCode,
      ...(internal ? { internal: true } : {}),
    });
  }
  k6.sort((a, b) => (a.accountCode ?? '').localeCompare(b.accountCode ?? '') || (a.storeId ?? '').localeCompare(b.storeId ?? ''));

  // ---- kind 5 ------------------------------------------------------------------------------
  const wages: UnpaidKind = {
    id: 'wages',
    title: TITLES.wages,
    visible: payrollStores.length > 0,
    lines: [],
    unmatched: [],
    subtotal: null,
  };
  if (wages.visible) {
    const reasons: string[] = [];
    let needsReview = 0;
    let unrated = 0;
    for (const s of payrollStores) {
      try {
        // A savepoint: a real SQL error inside the preview must not abort the page transaction.
        const p = await tx.transaction((sp) =>
          previewPayRun(sp, actor, { storeId: s, periodStart: FAR_PAST, periodEnd: FAR_FUTURE }),
        );
        needsReview += p.needsReviewDays;
        unrated += p.unratedEmployments.reduce((n, u) => n + u.days, 0);
        for (const slip of p.slips) {
          if (!isPositive(slip.netPay)) continue;
          wages.lines.push({
            storeId: s,
            name: slip.personName,
            counterparty: null,
            dueOn: null,
            amount: slip.netPay,
            href: `/payroll?store=${s}`,
          });
        }
      } catch (e) {
        const storeName = names.stores.get(s) ?? 'This store';
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('no attendance configuration')) {
          reasons.push(`${storeName} has no attendance configuration, so wages cannot be worked out.`);
        } else {
          logger.warn({ err: e, storeId: s }, 'getUnpaidLiabilities: the payroll preview failed');
          reasons.push(`Wages could not be loaded for ${storeName}.`);
        }
      }
    }
    if (reasons.length > 0) wages.unavailableReason = reasons.join(' ');
    if (needsReview > 0) wages.needsReviewDays = needsReview;
    if (unrated > 0) wages.unratedDays = unrated;
    wages.subtotal = sumOf(wages.lines);
  }

  // 2150 nets to zero across the whole org, so it is left out of the ALL-stores totals only.
  // In a single-store view it is that store's real debt and counts.
  const allStores = (input.storeId ?? undefined) === undefined;
  const kind = (
    id: UnpaidKindId,
    lines: UnpaidLine[],
    unmatched: UnmatchedLeftover[],
    over: Partial<UnpaidKind> = {},
  ): UnpaidKind => ({
    id,
    title: TITLES[id],
    visible: true,
    lines: lines.sort(byDue),
    unmatched,
    subtotal: sumOf(allStores ? lines.filter((l) => !l.internal) : lines),
    ...over,
  });

  const kinds: UnpaidKind[] = [
    kind('supplier_invoices', k1, leftovers('2110', k1)),
    kind('recurring_drafts', k2, []),
    kind('register', k3, leftovers('2500', k3)),
    kind('loans', k4, leftovers('2400', k4)),
    wages,
    kind('other_ledger', k6, [], withheld.size > 0 ? { withheld: [...withheld.values()] } : {}),
  ];

  const sub = (id: UnpaidKindId): Money => {
    const k = kinds.find((x) => x.id === id);
    return k === undefined || k.subtotal === null ? ZERO : money(k.subtotal);
  };
  const booked = add(ZERO, sub('supplier_invoices'), sub('register'), sub('loans'), sub('other_ledger'));
  const notYetBooked = add(ZERO, sub('recurring_drafts'), sub('wages'));

  return {
    kinds,
    banners: kinds.flatMap((k) => k.unmatched),
    totals: {
      booked,
      notYetBooked,
      grand: add(booked, notYetBooked),
      excludesWages: payrollStores.length < authorizedStoreIds.length,
    },
  };
}

/**
 * Which stores this viewer may see. A named store is authorized (staff and a store they do not hold
 * are refused with `AuthorizationError`). With none named: every store they hold, each authorized;
 * a person who holds every store reads the org without a store filter so no store ledger is missed.
 */
async function resolveScope(
  tx: Tx,
  actor: Actor,
  requested: string | undefined,
): Promise<{ storeIds: string[] | undefined; authorizedStoreIds: string[] }> {
  if (requested) {
    await authorize(tx, actor, 'view_financial_reports', { storeId: requested });
    return { storeIds: [requested], authorizedStoreIds: [requested] };
  }
  const covers = await accessRepo.personCoversWholeOrg(tx, actor.personId, actor.orgId);
  const held = covers
    ? await accessRepo.activeStoreIdsForOrg(tx, actor.orgId)
    : await accessRepo.storeIdsForPerson(tx, actor.personId);
  if (held.length === 0) await authorize(tx, actor, 'view_financial_reports', {});
  for (const s of held) await authorize(tx, actor, 'view_financial_reports', { storeId: s });
  return { storeIds: covers ? undefined : held, authorizedStoreIds: held };
}
