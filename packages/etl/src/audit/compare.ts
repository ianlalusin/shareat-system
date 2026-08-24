/**
 * audit/compare.ts — Stage 1 of the T-114b audit. docs/tasks/114b-audit-report.md
 * Contract §3, marked with a star in the spec: "the single highest-value check in the
 * task."
 *
 * v1 maintains its OWN running balance per account, incrementally, in
 * `stores/{id}/accounts/{accountId}` — a cache in v2's own terms (bible §16.1 invariant
 * 6's "v1 maintains incrementing balance documents — that is a cache in v2, derived and
 * rebuildable"), and a cache known to drift (discovery `06` §3.4: the AP tile wired at
 * only 3 of 8+ write paths). This module is two INDEPENDENT derivations of the same
 * number compared against each other:
 *   - v1's own — read straight from its `accounts` collection.
 *   - ours — `reconstructBalances`'s output (packages/etl/src/audit/balances.ts), built
 *     from the raw legs, never trusting v1's running total at all.
 *
 * Any disagreement is a FINDING to report with both figures, largest delta first — never
 * an assumption that ours is right (Contract's own words). A one-sided comparison (an
 * account on one side with nothing on the other) is reported too — invariant 8 exists
 * because a check that silently ignores absences is not a check.
 *
 * GRANULARITY. v1's own account documents are already per-ENTITY for the control-account
 * prefixes (one `ap__{supplierId}` doc per supplier, not one aggregate `ap` doc) — so the
 * four codes Contract §2 tracks per party (2110/1210/1230/2130) are compared at PARTY
 * granularity, against `reconstructBalances`'s `partyBalances`. Every other v1 account
 * (including OTHER per-entity ids this task does not track per-party, like `asset__{id}`
 * or `prepaid__{id}`) is compared at the AGGREGATE account-code level: every v1 doc that
 * resolves to a given v2 code is SUMMED first, then compared against
 * `reconstructBalances`'s single `balances` row for that code — comparing the same total
 * at the same granularity on both sides, never one entity against everyone's total.
 */
import { add, moneyFromLegacyFloat, subtract, ZERO, type Money } from '@shareat/core/money';
import {
  DEFAULT_STORE_IDS,
  EXCLUDED_STORES,
  PARTY_CONTROL_ACCOUNTS,
  accountIdEncodedParty,
  resolveV1Account,
  type AccountBalance,
  type LandedDocLike,
  type PartyBalance,
} from './balances';

export type OneSided = 'v1_only' | 'ours_only' | null;

export interface AccountCrossCheckRow {
  readonly storeCode: string;
  readonly accountCode: string;
  readonly v1Balance: Money | null;
  readonly ourBalance: Money | null;
  /** (v1Balance ?? 0) - (ourBalance ?? 0) — signed, so a one-sided row's delta is just the
   *  one figure that exists, which is what makes "largest delta first" sort correctly
   *  across both agreement gaps and one-sided absences. */
  readonly delta: Money;
  readonly oneSided: OneSided;
}

export interface PartyCrossCheckRow {
  readonly storeCode: string;
  readonly accountCode: string;
  readonly partyType: 'supplier' | 'customer' | 'employee';
  readonly partyId: string;
  readonly v1Balance: Money | null;
  readonly ourBalance: Money | null;
  readonly delta: Money;
  readonly oneSided: OneSided;
}

export interface UnmappedV1Account {
  readonly storeCode: string;
  readonly v1AccountId: string;
  readonly v1Balance: Money;
}

export interface CrossCheckResult {
  readonly includedStoreCodes: readonly string[];
  readonly excludedStores: readonly { code: string; name: string }[];
  /** Every (storeCode, accountCode) either side has data for — agreements included. */
  readonly accountRows: readonly AccountCrossCheckRow[];
  readonly partyRows: readonly PartyCrossCheckRow[];
  /** accountRows filtered to delta != 0 (agreement produces no finding — invariant 7),
   *  sorted by |delta| descending. */
  readonly disagreements: readonly AccountCrossCheckRow[];
  readonly partyDisagreements: readonly PartyCrossCheckRow[];
  /** A v1 `accounts/{id}` document whose id has NO v2 destination at all (e.g. the
   *  RETIRED `income__wastage_writeoff_contra` — found during this task, see the task
   *  report) — cannot be cross-checked by code at all, reported by name instead. */
  readonly unmappedV1Accounts: readonly UnmappedV1Account[];
  /** v1's `balance` float did not round-trip exactly to centavos — surfaced, never
   *  silently rounded away (bible §11 rule 5, matching `moneyFromLegacyFloat`'s own
   *  contract). */
  readonly precisionLossFindings: readonly { storeCode: string; v1AccountId: string; message: string }[];
}

function isZeroMoney(m: Money): boolean {
  return Number(m) === 0;
}

function absMoney(m: Money): Money {
  return m.startsWith('-') ? (m.slice(1) as Money) : m;
}

export function filterAccountsDocs(docs: readonly LandedDocLike[]): readonly LandedDocLike[] {
  return docs.filter((d) => /\/accounts$/.test(d.collectionPath));
}

interface ParsedV1Account {
  readonly storeCode: string;
  readonly v1AccountId: string;
  readonly balance: number;
}

function parseV1AccountDoc(doc: LandedDocLike): ParsedV1Account | null {
  const storeCode = doc.storeCode;
  const balance = typeof doc.payload.balance === 'number' ? doc.payload.balance : Number(doc.payload.balance);
  const idFromPayload = typeof doc.payload.id === 'string' ? doc.payload.id : null;
  const idFromPath = doc.docPath.split('/').pop() ?? null;
  const v1AccountId = idFromPayload ?? idFromPath;
  if (!storeCode || !v1AccountId || !Number.isFinite(balance)) return null;
  return { storeCode, v1AccountId, balance };
}

export function crossCheck(
  docs: readonly LandedDocLike[],
  ourBalances: { balances: readonly AccountBalance[]; partyBalances: readonly PartyBalance[] },
  params: { storeIds?: readonly string[] } = {},
): CrossCheckResult {
  const storeIds = params.storeIds ?? DEFAULT_STORE_IDS;
  const storeIdSet = new Set(storeIds);
  const excludedStores = Object.entries(EXCLUDED_STORES).map(([code, name]) => ({ code, name }));

  // ---- v1 side: aggregate by (storeCode, v2 code), and separately by (storeCode, v2
  // code, partyId) for the four party-control codes. ----
  const v1AggregateByKey = new Map<string, Money>(); // key: storeCode + code
  const v1PartyByKey = new Map<string, Money>(); // key: storeCode + code + partyId
  const unmapped: UnmappedV1Account[] = [];
  const precisionLossFindings: { storeCode: string; v1AccountId: string; message: string }[] = [];

  for (const doc of filterAccountsDocs(docs)) {
    const parsed = parseV1AccountDoc(doc);
    if (!parsed || !storeIdSet.has(parsed.storeCode)) continue;

    const resolved = resolveV1Account(parsed.v1AccountId);
    const { value: balanceMoney, rounded } = moneyFromLegacyFloat(parsed.balance);
    if (rounded) {
      precisionLossFindings.push({
        storeCode: parsed.storeCode,
        v1AccountId: parsed.v1AccountId,
        message: `v1's own balance ${parsed.balance} for '${parsed.v1AccountId}' does not round-trip exactly to centavos — stored as ${balanceMoney}`,
      });
    }
    if (!resolved) {
      unmapped.push({ storeCode: parsed.storeCode, v1AccountId: parsed.v1AccountId, v1Balance: balanceMoney });
      continue;
    }

    const aggKey = `${parsed.storeCode} ${resolved.code}`;
    v1AggregateByKey.set(aggKey, add(v1AggregateByKey.get(aggKey) ?? ZERO, balanceMoney));

    const partyType = PARTY_CONTROL_ACCOUNTS[resolved.code];
    if (partyType) {
      const partyId = accountIdEncodedParty(parsed.v1AccountId, resolved.code) ?? '(unknown)';
      const pKey = `${parsed.storeCode} ${resolved.code} ${partyId}`;
      v1PartyByKey.set(pKey, add(v1PartyByKey.get(pKey) ?? ZERO, balanceMoney));
    }
  }

  // ---- our side, keyed the same way ----
  const ourAggregateByKey = new Map<string, Money>();
  for (const b of ourBalances.balances) {
    if (!storeIdSet.has(b.storeCode)) continue;
    ourAggregateByKey.set(`${b.storeCode} ${b.accountCode}`, b.netBalance);
  }
  const ourPartyByKey = new Map<string, Money>();
  for (const p of ourBalances.partyBalances) {
    if (!storeIdSet.has(p.storeCode)) continue;
    ourPartyByKey.set(`${p.storeCode} ${p.accountCode} ${p.partyId}`, p.netBalance);
  }

  // ---- union + compare, both directions (invariant 8) ----
  const accountRows: AccountCrossCheckRow[] = [];
  const allAccountKeys = new Set<string>([...v1AggregateByKey.keys(), ...ourAggregateByKey.keys()]);
  for (const key of allAccountKeys) {
    const [storeCode, accountCode] = key.split(' ') as [string, string];
    const v1Balance = v1AggregateByKey.get(key) ?? null;
    const ourBalance = ourAggregateByKey.get(key) ?? null;
    const delta = subtract(v1Balance ?? ZERO, ourBalance ?? ZERO);
    const oneSided: OneSided = v1Balance == null ? 'ours_only' : ourBalance == null ? 'v1_only' : null;
    accountRows.push({ storeCode, accountCode, v1Balance, ourBalance, delta, oneSided });
  }

  const partyRows: PartyCrossCheckRow[] = [];
  const allPartyKeys = new Set<string>([...v1PartyByKey.keys(), ...ourPartyByKey.keys()]);
  for (const key of allPartyKeys) {
    const [storeCode, accountCode, partyId] = key.split(' ') as [string, string, string];
    const partyType = PARTY_CONTROL_ACCOUNTS[accountCode]!;
    const v1Balance = v1PartyByKey.get(key) ?? null;
    const ourBalance = ourPartyByKey.get(key) ?? null;
    const delta = subtract(v1Balance ?? ZERO, ourBalance ?? ZERO);
    const oneSided: OneSided = v1Balance == null ? 'ours_only' : ourBalance == null ? 'v1_only' : null;
    partyRows.push({ storeCode, accountCode, partyType, partyId, v1Balance, ourBalance, delta, oneSided });
  }

  const byAbsDeltaDesc = (a: { delta: Money }, b: { delta: Money }) => Number(absMoney(b.delta)) - Number(absMoney(a.delta));

  const disagreements = accountRows.filter((r) => !isZeroMoney(r.delta)).sort(byAbsDeltaDesc);
  const partyDisagreements = partyRows.filter((r) => !isZeroMoney(r.delta)).sort(byAbsDeltaDesc);

  return {
    includedStoreCodes: [...storeIds],
    excludedStores,
    accountRows,
    partyRows,
    disagreements,
    partyDisagreements,
    unmappedV1Accounts: unmapped,
    precisionLossFindings,
  };
}
