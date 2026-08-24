/**
 * audit/balances.ts — Stage 1 of the T-114b audit. docs/tasks/114b-audit-report.md
 * Contract §2, the balance reconstruction Ian types into his 1 Jan 2027 opening balance.
 *
 * Reads landed `journal` legs (already in memory — the CLI is the only caller that opens a
 * database, via `etlRepo.findCurrentDocuments`; every function here is a pure, DB-free
 * transform so the unit tests in tests/audit/ prove it with zero database, per invariant
 * 16's "this task never opens a Firestore client" and the bible's "integration tests only
 * where a real Postgres is actually needed"), translates each leg through T-107's
 * `adaptLegacyLegs` — imported directly, NEVER re-implemented (Contract §2's own words) —
 * and sums per (storeCode, accountCode). Per-party totals are kept for the four control
 * accounts DEF-042's sibling Contract §2 names explicitly: `ap__*` (2110, supplier),
 * `ar__*` (1210, customer), `staff_advance__*` (1230, employee), `staff_reimbursable__*`
 * (2130, employee).
 *
 * ACCOUNT RESOLUTION — the crosswalk this module owns.
 * packages/db/seed/chart-of-accounts.ts's own header comment says per-entity v1 account
 * prefixes (`ap__{supplierId}`, `ar__{customerId}`, `staff_advance__{staffId}`, ...)
 * "collapse onto ONE v2 control account each, mapped by prefix at ETL time (T-113/T-114),
 * not by this column" — T-113's leg-mapping.ts never builds that prefix table (it only
 * covers the ~12 codes convert.ts posts to directly), so it is built HERE, the first task
 * that actually needs to translate a raw v1 accountId end to end. Two layers:
 *   1. A FIXED 1:1 lookup on `accounts.legacy_code` (imported read-only from
 *      chart-of-accounts.ts — never duplicated, never modified) — e.g. `cash__cashier` ->
 *      1110, `expense__salary` -> 6100.
 *   2. An ORDERED per-entity PREFIX table for the ids chart-of-accounts.ts's own comments
 *      name as "per-entity, mapped by prefix" — e.g. `ap__SUP123` -> 2110. Order is
 *      load-bearing: several prefixes are literal substrings of a more generic one below
 *      them (`asset__due_from_{storeKey}` vs `asset__{assetId}`; `ar__channel_{id}` vs
 *      `ar__{customerId}`), so the more specific prefix is always checked first.
 * An accountId matching neither layer resolves to `null` — a genuine finding
 * (`unresolvable_account`), never a guess.
 */
import { add, money, subtract, ZERO, type Money } from '@shareat/core/money';
import {
  adaptLegacyLegs,
  type LegacyLeg,
  type NormalBalance,
  type ResolvedAccount,
} from '../../../domain/src/ledger/legacy-adapter';
import { CHART_OF_ACCOUNTS, type ChartOfAccountsSeedAccount } from '../../../db/seed/chart-of-accounts';

export type { ResolvedAccount, LegacyLeg };

// -----------------------------------------------------------------------------------------
// docs/STORE-ROSTER.md, as code. "Never derive a store list from a capped query" — this IS
// the full, confirmed list (Ian, 2026-08-24), not a query result. The exclusion of the two
// test stores and Padre Garcia is PRINTED by report.ts, never silent (Contract §2 rule 3 /
// invariant 18).
// -----------------------------------------------------------------------------------------
export const OPERATING_STORES: Readonly<Record<string, string>> = {
  b9DzsnPbr1BUnY88lyT4: 'SharEat Lipa',
  dZUyvX4q824JBSVDAfE9: 'SharEat Malvar',
  iGOW7q2pZbeHWV832UNh: 'SharEat Banay-Banay',
  eVYKj6wABdakk8RgEotW: 'SharEat Davao',
};

export const EXCLUDED_STORES: Readonly<Record<string, string>> = {
  y1DMgfisuTHBF57cNL6i: 'SharEat Padre Garcia — not operating yet, 0 documents',
  XbkyEgZqunmj2wzhicNf: 'TEST — test store',
  TEST: 'Test Commissary — test store',
};

export const DEFAULT_STORE_IDS: readonly string[] = Object.keys(OPERATING_STORES);

// -----------------------------------------------------------------------------------------
// Account resolution
// -----------------------------------------------------------------------------------------

const BY_CODE: ReadonlyMap<string, ChartOfAccountsSeedAccount> = new Map(
  CHART_OF_ACCOUNTS.map((a) => [a.code, a]),
);
const BY_LEGACY_CODE: ReadonlyMap<string, ChartOfAccountsSeedAccount> = new Map(
  CHART_OF_ACCOUNTS.filter((a): a is ChartOfAccountsSeedAccount & { legacyCode: string } => a.legacyCode != null).map(
    (a) => [a.legacyCode, a],
  ),
);

export type PartyType = 'supplier' | 'customer' | 'employee' | 'channel' | 'store';

interface PrefixRule {
  readonly prefix: string;
  readonly code: string;
}

/**
 * Ordered MOST SPECIFIC FIRST — see this file's header comment. Every `code` here is a
 * real, postable, seeded leaf in chart-of-accounts.ts; `normalBalance`/`isPostable`/
 * `status` are always read from that seed via `BY_CODE`, never duplicated here.
 */
const PREFIX_RULES: readonly PrefixRule[] = [
  { prefix: 'asset__due_from_', code: '1250' },
  { prefix: 'liability__due_to_', code: '2150' },
  { prefix: 'ar__channel_', code: '1220' },
  { prefix: 'liability__loan_', code: '2400' },
  { prefix: 'ap__', code: '2110' },
  { prefix: 'ar__', code: '1210' },
  { prefix: 'staff_advance__', code: '1230' },
  { prefix: 'staff_reimbursable__', code: '2130' },
  { prefix: 'supplier_advance__', code: '1240' },
  { prefix: 'contra_asset__', code: '1590' },
  { prefix: 'asset__', code: '1510' },
  { prefix: 'prepaid__', code: '1400' },
  { prefix: 'online__', code: '1140' },
];

function toResolvedAccount(seedRow: ChartOfAccountsSeedAccount): ResolvedAccount {
  return {
    code: seedRow.code,
    normalBalance: seedRow.normalBalance,
    isPostable: seedRow.isPostable,
    status: seedRow.status,
  };
}

/** The v1 accountId -> v2 ResolvedAccount crosswalk. `null` is a genuine finding, never
 *  silently coerced (bible §11 rule 5). */
export function resolveV1Account(accountId: string): ResolvedAccount | null {
  const fixed = BY_LEGACY_CODE.get(accountId);
  if (fixed) return toResolvedAccount(fixed);

  for (const rule of PREFIX_RULES) {
    if (accountId.startsWith(rule.prefix)) {
      const seedRow = BY_CODE.get(rule.code);
      return seedRow ? toResolvedAccount(seedRow) : null;
    }
  }
  return null;
}

/** Contract §2's exact four per-party control accounts, and the party TYPE each carries. */
export const PARTY_CONTROL_ACCOUNTS: Readonly<Record<string, 'supplier' | 'customer' | 'employee'>> = {
  '2110': 'supplier', // ap__{supplierId}
  '1210': 'customer', // ar__{customerId}
  '1230': 'employee', // staff_advance__{staffId}
  '2130': 'employee', // staff_reimbursable__{staffId}
};

const PARTY_PREFIX_BY_CODE: Readonly<Record<string, string>> = {
  '2110': 'ap__',
  '1210': 'ar__',
  '1230': 'staff_advance__',
  '2130': 'staff_reimbursable__',
};

/** The party id encoded directly in a control account's own accountId string, or null when
 *  `code` isn't one of the four party-control accounts or the id doesn't carry that prefix
 *  (e.g. a 1210 leg that actually resolved via a different rule — should not happen, but
 *  resolved defensively rather than assumed). */
/** Exported — compare.ts (Contract §3) needs the same party-suffix parsing to interpret a
 *  v1 `accounts/{id}` document's own id, which for these four codes IS the party id. */
export function accountIdEncodedParty(accountId: string, code: string): string | null {
  const prefix = PARTY_PREFIX_BY_CODE[code];
  if (!prefix || !accountId.startsWith(prefix)) return null;
  const suffix = accountId.slice(prefix.length);
  return suffix.length > 0 ? suffix : null;
}

function netBalanceFor(normalBalance: NormalBalance, debit: Money, credit: Money): Money {
  return normalBalance === 'debit' ? subtract(debit, credit) : subtract(credit, debit);
}

// -----------------------------------------------------------------------------------------
// Landed-document shapes — structurally compatible with
// `packages/db/src/repo/etl.ts`'s `LandedSourceDocumentRow` (a superset), so real rows from
// `etlRepo.findCurrentDocuments` satisfy this without adapting. No `@shareat/db` import
// here — Contract's own "this task never opens a Firestore client" plus the general rule
// that only the CLI touches a database.
// -----------------------------------------------------------------------------------------

export interface LandedDocLike {
  readonly docPath: string;
  readonly collectionPath: string;
  readonly storeCode: string | null;
  readonly payload: Record<string, unknown>;
}

export function filterJournalDocs(docs: readonly LandedDocLike[]): readonly LandedDocLike[] {
  return docs.filter((d) => /\/journal$/.test(d.collectionPath));
}

export interface V1JournalLeg {
  readonly docPath: string;
  readonly storeCode: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly legKey: string | null;
  readonly accountId: string;
  readonly direction: 'in' | 'out';
  readonly amount: string | number;
  readonly businessDate: string | null;
  readonly supplierId: string | null;
  readonly customerId: string | null;
  readonly employeeId: string | null;
}

/** `null` = the payload is missing a field this module cannot proceed without at all
 *  (never observed in the real capture as of 2026-08-24 — see the task report — but
 *  handled rather than assumed). Every field actually present in real captured legs
 *  (ERP-rebuild's journal-writer.ts, read-only) is read here. */
export function parseJournalLeg(doc: LandedDocLike): V1JournalLeg | null {
  const p = doc.payload;
  const accountId = typeof p.accountId === 'string' ? p.accountId : null;
  const direction = p.direction === 'in' || p.direction === 'out' ? p.direction : null;
  const amount = typeof p.amount === 'number' || typeof p.amount === 'string' ? p.amount : null;
  const sourceType = typeof p.sourceType === 'string' ? p.sourceType : null;
  const sourceId = typeof p.sourceId === 'string' ? p.sourceId : null;
  const storeCode = doc.storeCode ?? (typeof p.storeId === 'string' ? p.storeId : null);

  if (!accountId || !direction || amount == null || !sourceType || !sourceId || !storeCode) {
    return null;
  }

  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

  return {
    docPath: doc.docPath,
    storeCode,
    sourceType,
    sourceId,
    legKey: str(p.legKey),
    accountId,
    direction,
    amount,
    businessDate: str(p.businessDate),
    supplierId: str(p.supplierId),
    customerId: str(p.customerId),
    employeeId: str(p.employeeId),
  };
}

// -----------------------------------------------------------------------------------------
// The reconstruction itself
// -----------------------------------------------------------------------------------------

export interface AccountBalance {
  readonly storeCode: string;
  readonly accountCode: string;
  readonly debitTotal: Money;
  readonly creditTotal: Money;
  readonly netBalance: Money;
  readonly legCount: number;
}

export interface PartyBalance {
  readonly storeCode: string;
  readonly accountCode: string;
  readonly partyType: 'supplier' | 'customer' | 'employee';
  readonly partyId: string;
  readonly debitTotal: Money;
  readonly creditTotal: Money;
  readonly netBalance: Money;
  readonly legCount: number;
}

export type BalanceFindingType =
  | 'malformed_leg'
  | 'missing_business_date'
  | 'unresolvable_account'
  | 'unadaptable_leg'
  | 'polarity_disagreement'
  | 'precision_loss'
  | 'party_id_mismatch'
  | 'missing_party_field';

export interface BalanceFinding {
  readonly type: BalanceFindingType;
  readonly storeCode: string;
  readonly docPath: string;
  readonly accountId: string | null;
  readonly message: string;
}

export interface ReconstructBalancesResult {
  readonly asOf: string;
  readonly includedStoreCodes: readonly string[];
  readonly excludedStores: readonly { code: string; name: string }[];
  readonly balances: readonly AccountBalance[];
  readonly partyBalances: readonly PartyBalance[];
  readonly findings: readonly BalanceFinding[];
  /** Legs actually summed into `balances` (in-scope store, businessDate <= asOf, resolved,
   *  adapted successfully). */
  readonly legsIncluded: number;
  /** businessDate > asOf — normal exclusion, not a finding. */
  readonly legsExcludedFutureDated: number;
}

interface MutableBalance {
  storeCode: string;
  accountCode: string;
  debit: Money;
  credit: Money;
  legCount: number;
}

interface MutablePartyBalance extends MutableBalance {
  partyType: 'supplier' | 'customer' | 'employee';
  partyId: string;
}

/**
 * reconstructBalances — Contract §2. `docs` is every CURRENT landed document (any
 * collection); this filters to `journal` itself, so callers can pass the one full read
 * straight through without pre-filtering (report.ts's job).
 */
export function reconstructBalances(
  docs: readonly LandedDocLike[],
  params: { asOf: string; storeIds?: readonly string[] },
): ReconstructBalancesResult {
  const storeIds = params.storeIds ?? DEFAULT_STORE_IDS;
  const storeIdSet = new Set(storeIds);
  const excludedStores = Object.entries(EXCLUDED_STORES).map(([code, name]) => ({ code, name }));

  const balances = new Map<string, MutableBalance>();
  const partyBalances = new Map<string, MutablePartyBalance>();
  const findings: BalanceFinding[] = [];
  let legsIncluded = 0;
  let legsExcludedFutureDated = 0;

  for (const doc of filterJournalDocs(docs)) {
    const parsed = parseJournalLeg(doc);
    if (!parsed) {
      findings.push({
        type: 'malformed_leg',
        storeCode: doc.storeCode ?? '(unknown)',
        docPath: doc.docPath,
        accountId: null,
        message: `journal document is missing one of accountId/direction/amount/sourceType/sourceId/storeId`,
      });
      continue;
    }

    // Store scoping — invariant 18: silently excluding an out-of-scope store's legs from
    // the SUM is correct (that is what "scoped to four operating stores" means); the
    // exclusion itself is what must never be silent, and report.ts prints it once, from
    // `excludedStores` above, rather than per-leg here.
    if (!storeIdSet.has(parsed.storeCode)) continue;

    // Invariant 5 — a leg with no businessDate is REPORTED, never silently dropped.
    if (parsed.businessDate == null) {
      findings.push({
        type: 'missing_business_date',
        storeCode: parsed.storeCode,
        docPath: doc.docPath,
        accountId: parsed.accountId,
        message: `leg has no businessDate — excluded from the ${params.asOf} balance because it cannot be placed in time`,
      });
      continue;
    }

    // Invariant 6 — asOf excludes LATER legs; the boundary date is INCLUSIVE.
    if (parsed.businessDate > params.asOf) {
      legsExcludedFutureDated++;
      continue;
    }

    const resolved = resolveV1Account(parsed.accountId);
    if (!resolved) {
      findings.push({
        type: 'unresolvable_account',
        storeCode: parsed.storeCode,
        docPath: doc.docPath,
        accountId: parsed.accountId,
        message: `no v2 account mapping for v1 accountId '${parsed.accountId}'`,
      });
      continue;
    }

    const legacyLeg: LegacyLeg = {
      accountId: parsed.accountId,
      direction: parsed.direction,
      amount: parsed.amount,
      legKey: parsed.legKey ?? undefined,
    };
    // Invariant 2 — polarity comes from adaptLegacyLegs, never re-derived here.
    const adapted = adaptLegacyLegs([legacyLeg], (id) => (id === parsed.accountId ? resolved : null));
    if (!adapted.ok) {
      findings.push({
        type: 'unadaptable_leg',
        storeCode: parsed.storeCode,
        docPath: doc.docPath,
        accountId: parsed.accountId,
        message: adapted.reason,
      });
      continue;
    }
    for (const f of adapted.findings) {
      findings.push({
        type: f.type,
        storeCode: parsed.storeCode,
        docPath: doc.docPath,
        accountId: f.accountId,
        message: f.message,
      });
    }

    legsIncluded++;
    const adaptedLine = adapted.lines[0]!;
    const debit = money(adaptedLine.debit);
    const credit = money(adaptedLine.credit);

    const bKey = `${parsed.storeCode} ${resolved.code}`;
    const existing = balances.get(bKey) ?? {
      storeCode: parsed.storeCode,
      accountCode: resolved.code,
      debit: ZERO,
      credit: ZERO,
      legCount: 0,
    };
    existing.debit = add(existing.debit, debit);
    existing.credit = add(existing.credit, credit);
    existing.legCount += 1;
    balances.set(bKey, existing);

    // Per-party breakdown — Contract §2's exact four control accounts.
    const partyType = PARTY_CONTROL_ACCOUNTS[resolved.code];
    if (partyType) {
      const fieldValue =
        partyType === 'supplier' ? parsed.supplierId : partyType === 'customer' ? parsed.customerId : parsed.employeeId;
      const encoded = accountIdEncodedParty(parsed.accountId, resolved.code);

      let partyId: string;
      if (fieldValue) {
        // Contract §2 — "Use the leg's field; report any disagreement with the account id
        // as a finding" (invariant 4).
        partyId = fieldValue;
        if (encoded && encoded !== fieldValue) {
          findings.push({
            type: 'party_id_mismatch',
            storeCode: parsed.storeCode,
            docPath: doc.docPath,
            accountId: parsed.accountId,
            message: `leg's ${partyType}Id '${fieldValue}' disagrees with the account id's own encoded party '${encoded}'`,
          });
        }
      } else {
        // No field at all — fall back to the account-id-encoded party so this leg is
        // never SILENTLY missing from the per-party breakdown (invariant 3 must still
        // hold exactly), but flag it: the leg record itself is incomplete.
        partyId = encoded ?? '(unknown)';
        findings.push({
          type: 'missing_party_field',
          storeCode: parsed.storeCode,
          docPath: doc.docPath,
          accountId: parsed.accountId,
          message: `control-account leg has no ${partyType}Id field on the leg record; attributed to '${partyId}' from the account id itself`,
        });
      }

      const pKey = `${parsed.storeCode} ${resolved.code} ${partyId}`;
      const existingP = partyBalances.get(pKey) ?? {
        storeCode: parsed.storeCode,
        accountCode: resolved.code,
        partyType,
        partyId,
        debit: ZERO,
        credit: ZERO,
        legCount: 0,
      };
      existingP.debit = add(existingP.debit, debit);
      existingP.credit = add(existingP.credit, credit);
      existingP.legCount += 1;
      partyBalances.set(pKey, existingP);
    }
  }

  const balanceRows: AccountBalance[] = [...balances.values()].map((b) => {
    const seedRow = BY_CODE.get(b.accountCode);
    const normal = seedRow?.normalBalance ?? 'debit';
    return {
      storeCode: b.storeCode,
      accountCode: b.accountCode,
      debitTotal: b.debit,
      creditTotal: b.credit,
      netBalance: netBalanceFor(normal, b.debit, b.credit),
      legCount: b.legCount,
    };
  });

  const partyRows: PartyBalance[] = [...partyBalances.values()].map((b) => {
    const seedRow = BY_CODE.get(b.accountCode);
    const normal = seedRow?.normalBalance ?? 'debit';
    return {
      storeCode: b.storeCode,
      accountCode: b.accountCode,
      partyType: b.partyType,
      partyId: b.partyId,
      debitTotal: b.debit,
      creditTotal: b.credit,
      netBalance: netBalanceFor(normal, b.debit, b.credit),
      legCount: b.legCount,
    };
  });

  return {
    asOf: params.asOf,
    includedStoreCodes: [...storeIds],
    excludedStores,
    balances: balanceRows,
    partyBalances: partyRows,
    findings,
    legsIncluded,
    legsExcludedFutureDated,
  };
}
