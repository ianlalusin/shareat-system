/**
 * The opening tie-out: does every register agree with its control account? T-390 S3, R9, R15, §5.3.
 * `docs/tasks/390-opening-stock-and-subledger-tieout.md`.
 *
 * ⭐ **A query, decided by the database, never a recorded row** (T-134 invariant 1): C4 reads it, C5 enforces it. Every figure is
 * compared in centavos (`money()` + `toCentavos`), never as a float (T-371).
 *
 * ⛔ Not here: T1 (stock, per store x 1310/1320/1330). It lands with S2, which owns `planOpeningStock`; until then the three
 * inventory accounts are left out of `notChecked` on purpose, because S2's T1 is what will check them. S2 adds its line to
 * `openingTieOut` where the marked comment is.
 *
 * ⚠️ The party-derived registers (T4-T7) can only say the parties are VALID: the totals are compared with v1's aged lists by the
 * C3P attestation (R16), not by this query.
 *
 * Every sentence names the register, the store and the difference in pesos (or the party). No ids, no jargon.
 */
import { cutoverRepo, type Tx } from '@shareat/db';
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { itemKindsOf, planOpeningStock } from './opening-stock';

/**
 * The conversion date every opening figure, inventory draft and movement carries (POSTING-PATTERNS `opening_balance.load`).
 * ⚠️ R14 moves the app's copy (`apps/erp/src/app/cutover/lib.ts`) here; S5 makes the app re-export this one.
 */
export const CONVERSION_DATE = '2027-01-01';

const EQUITY = '3900';
const MONEY_ACCOUNT_CODES = ['1110', '1120', '1130', '1140'] as const;
/** Opening accounts that have a register or a dedicated rule, so they are never listed under "not checked here". */
const COVERED_ACCOUNTS = new Set<string>([
  ...MONEY_ACCOUNT_CODES, '1210', '1230', '1250', '1400', '1510', '1590', '2110', '2150', '2400', EQUITY,
  '3300', // the 3900 -> 3300 reconcile: checked per store by T10
  '1310', '1320', '1330', // T1, S2
]);

export interface TieLine {
  /** The register's plain name, e.g. `Fixed assets`. */
  register: string;
  storeId: string | null;
  account: string | null;
  /** What the register says, in pesos (`0.00` when the line is not a comparison). */
  registerFigure: string;
  /** What the opening entries say. */
  ledgerFigure: string;
  /** register minus ledger. */
  difference: string;
  sentence: string;
}

export interface NotCheckedLine {
  account: string;
  /** Pesos with the side it sits on, e.g. `₱3,333.00 debit`. */
  amount: string;
  reason: string;
}

export interface TieOut {
  holds: boolean;
  lines: TieLine[];
  /** R15: opening accounts with no v2 register. Listed with their figure, never green, never a refusal. */
  notChecked: NotCheckedLine[];
}

/** Peso text with thousands grouping, from centavos. */
function pesos(centavos: bigint): string {
  const abs = centavos < 0n ? -centavos : centavos;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₱${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}
const cv = (text: string): bigint => toCentavos(money(text));
const asMoney = (c: bigint): string => fromCentavos(c);

/** What a party type is called in a sentence. */
const PARTY_WORD: Record<string, string> = {
  customer: 'customer',
  supplier: 'supplier',
  employee: 'person',
  loan: 'loan',
  money_account: 'money account',
  store: 'store',
  channel: 'sales channel',
};
const partyWord = (t: string | null) => (t ? (PARTY_WORD[t] ?? t) : 'party');

export async function openingTieOut(tx: Tx, orgId: string): Promise<TieOut> {
  const storeNames = await cutoverRepo.storeNamesOf(tx, orgId);
  const lines = await cutoverRepo.openingLines(tx, orgId);
  const store = (id: string | null) => (id === null ? 'no store' : (storeNames.get(id) ?? 'an unknown store'));
  const storeIds = [...storeNames.keys()].sort((a, b) => store(a).localeCompare(store(b)) || a.localeCompare(b));

  /** Net DEBIT, in centavos, per account x store (a null store keys as ''). */
  const net = new Map<string, bigint>();
  for (const l of lines) {
    const k = `${l.accountCode}|${l.storeId ?? ''}`;
    net.set(k, (net.get(k) ?? 0n) + cv(l.debit) - cv(l.credit));
  }
  const netDebit = (code: string, storeId: string | null) => net.get(`${code}|${storeId ?? ''}`) ?? 0n;

  const out: TieLine[] = [];
  const add = (
    register: string, storeId: string | null, account: string | null, regC: bigint, ledC: bigint, sentence: string,
  ) => out.push({
    register, storeId, account, registerFigure: asMoney(regC), ledgerFigure: asMoney(ledC), difference: asMoney(regC - ledC), sentence,
  });
  const sentenceOnly = (register: string, storeId: string | null, account: string | null, sentence: string) =>
    add(register, storeId, account, 0n, 0n, sentence);

  // ---- T1 · stock, per store x 1310/1320/1330 -------------------------------------------------------------------------------
  // The register figure is `planOpeningStock` over the counts (the ONE implementation of the arithmetic); the ledger figure is that
  // account's opening line(s) for the store. A store counted but never valued, or edited since, is named with the difference.
  const counts = await cutoverRepo.countsForStore(tx, orgId);
  const stockPlans = planOpeningStock(counts, itemKindsOf(counts));
  const stockStoreIds = new Set<string | null>([...stockPlans.map((p) => p.storeId), ...storeIds]);
  for (const s of [...stockStoreIds].sort((a, b) => store(a).localeCompare(store(b)))) {
    const plan = stockPlans.find((p) => p.storeId === s);
    for (const code of ['1310', '1320', '1330']) {
      const reg = cv(plan?.accounts.find((a) => a.code === code)?.amount ?? '0');
      const led = netDebit(code, s);
      if (reg !== led) {
        add('Stock', s, code, reg, led,
          `Stock at ${store(s)} comes to ${pesos(reg)} on ${code} but the opening figure is ${pesos(led)}, ${pesos(reg - led)} apart. Press Value the count again.`);
      }
    }
    if (plan && plan.unpriced.length > 0) {
      const shown = plan.unpriced.slice(0, 5).map((u) => u.name).join(', ');
      const more = plan.unpriced.length > 5 ? ` and ${plan.unpriced.length - 5} more` : '';
      sentenceOnly('Stock', s, null,
        `${plan.unpriced.length} counted item${plan.unpriced.length === 1 ? '' : 's'} at ${store(s)} ${plan.unpriced.length === 1 ? 'has' : 'have'} no cost: ${shown}${more}.`);
    }
  }

  // ---- T2 · fixed assets, per store x 1510 ----------------------------------------------------------------------------------
  const assetCost = new Map((await cutoverRepo.openingAssetCostByStore(tx, orgId, CONVERSION_DATE)).map((r) => [r.storeId, cv(r.cost)]));
  const storeKeys: (string | null)[] = [...storeIds, null]; // a line with no store is compared too, as T10 does
  for (const s of storeKeys) {
    const reg = (s === null ? undefined : assetCost.get(s)) ?? 0n;
    const led = netDebit('1510', s);
    if (reg !== led) {
      add('Fixed assets', s, '1510', reg, led,
        `Fixed assets at ${store(s)} come to ${pesos(reg)} but the 1510 opening figure is ${pesos(led)}, ${pesos(reg - led)} apart.`);
    }
  }
  for (const shell of await cutoverRepo.pendingAssetShells(tx, orgId)) {
    sentenceOnly('Fixed assets', shell.storeId, '1510',
      `${shell.name} at ${store(shell.storeId)} has not been valued yet. Give it its book value and remaining life, or dispose of it before the purge.`);
  }
  for (const s of storeKeys) {
    if (lines.some((l) => l.accountCode === '1590' && l.storeId === s)) {
      sentenceOnly('Fixed assets', s, '1590',
        `A 1590 (accumulated depreciation) opening figure at ${store(s)} is not allowed: assets open at net book value, so accumulated depreciation opens at zero.`);
    }
  }

  // ---- T3 · prepaids, per store x 1400 --------------------------------------------------------------------------------------
  const prepaid = new Map((await cutoverRepo.activePrepaidTotalByStore(tx, orgId)).map((r) => [r.storeId, cv(r.total)]));
  for (const s of storeKeys) {
    const reg = (s === null ? undefined : prepaid.get(s)) ?? 0n;
    const led = netDebit('1400', s);
    if (reg !== led) {
      add('Prepaids', s, '1400', reg, led,
        `Prepaids at ${store(s)} come to ${pesos(reg)} but the 1400 opening figure is ${pesos(led)}, ${pesos(reg - led)} apart.`);
    }
  }

  // ---- T4 · loans, per loan x 2400 ------------------------------------------------------------------------------------------
  const l2400 = lines.filter((l) => l.accountCode === '2400');
  for (const loan of await cutoverRepo.activeLoans(tx, orgId)) {
    if (!l2400.some((l) => l.partyType === 'loan' && l.partyId === loan.id)) {
      sentenceOnly('Loans', loan.storeId, '2400',
        `Loan '${loan.name}' at ${store(loan.storeId)} has no opening balance. Enter it, or mark the loan paid off if nothing was owed on 31 December.`);
    }
  }
  for (const l of l2400) {
    if (l.partyType === 'loan' && l.partyName !== null && l.partyStoreId === l.storeId) continue;
    sentenceOnly('Loans', l.storeId, '2400',
      `A 2400 opening figure at ${store(l.storeId)} names a loan that is not in the loan register for ${store(l.storeId)}.`);
  }

  // ---- T5 · advances to employees, 1230 -------------------------------------------------------------------------------------
  for (const l of lines.filter((x) => x.accountCode === '1230')) {
    if (l.partyType === 'employee' && l.partyName !== null && l.employedAtStore === true) continue;
    sentenceOnly('Advances to employees', l.storeId, '1230',
      l.partyType === 'employee' && l.partyName !== null
        ? `A 1230 (advance to employee) opening figure at ${store(l.storeId)} names ${l.partyName}, who has never been employed at ${store(l.storeId)}.`
        : `A 1230 (advance to employee) opening figure at ${store(l.storeId)} names someone who is not a person on file.`);
  }

  // ---- T6 · receivables 1210 and payables 2110, per party -------------------------------------------------------------------
  const expectedParty: Record<string, { type: string; label: string }> = {
    '1210': { type: 'customer', label: 'receivable' },
    '2110': { type: 'supplier', label: 'payable' },
  };
  for (const l of lines.filter((x) => x.accountCode in expectedParty)) {
    const want = expectedParty[l.accountCode]!;
    if (l.partyType === want.type && l.partyName !== null) continue;
    let sentence: string;
    if (l.partyType === want.type) {
      sentence = `The ${l.accountCode} (${want.label}) opening figure at ${store(l.storeId)} names a ${want.type} that is not on file.`;
    } else if (l.partyType === null) {
      sentence = `The ${l.accountCode} (${want.label}) opening figure at ${store(l.storeId)} names no ${want.type}.`;
    } else {
      const who = l.partyName !== null ? l.partyName : `a ${partyWord(l.partyType)} that is not on file`;
      sentence = `The ${l.accountCode} (${want.label}) opening figure at ${store(l.storeId)} names ${who}, who is a ${partyWord(l.partyType)}, not a ${want.type}.`;
    }
    sentenceOnly('Receivables and payables', l.storeId, l.accountCode, sentence);
  }
  // ⛔ The double-counting guard is a REFUSAL now (it was a list on the gaps panel).
  for (const p of await cutoverRepo.partiesWithOpeningAndPreCutoverDocs(tx, orgId, CONVERSION_DATE)) {
    const name = (await cutoverRepo.partyNameOf(tx, orgId, p.partyType, p.partyId)) ?? `A ${partyWord(p.partyType)} that is not on file`;
    sentenceOnly('Receivables and payables', null, null,
      `${name} has an opening figure and also a document dated before ${CONVERSION_DATE}, so the same money would be counted twice. Keep one of them.`);
  }

  // ---- T7 · money accounts 1110-1140 ----------------------------------------------------------------------------------------
  for (const l of lines.filter((x) => (MONEY_ACCOUNT_CODES as readonly string[]).includes(x.accountCode) && x.partyType !== null)) {
    if (
      l.partyType === 'money_account' && l.partyName !== null && l.partyStoreId === l.storeId &&
      l.partyGlCode === l.accountCode && l.partyActive === true
    ) continue;
    sentenceOnly('Money accounts', l.storeId, l.accountCode,
      l.partyType === 'money_account' && l.partyName !== null
        ? `The ${l.accountCode} opening figure at ${store(l.storeId)} names the money account ${l.partyName}, which is not an active money account of ${store(l.storeId)} on ${l.accountCode}.`
        : `The ${l.accountCode} opening figure at ${store(l.storeId)} names ${l.partyName ?? `a ${partyWord(l.partyType)} that is not on file`}, which is not a money account.`);
  }

  // ---- T8 · every opening figure is dated the conversion date ---------------------------------------------------------------
  for (const l of lines) {
    if (l.accountCode === EQUITY || l.entryDate === CONVERSION_DATE) continue;
    sentenceOnly('Dates', l.storeId, l.accountCode,
      `The opening figure for ${l.accountCode} (${l.partyName ?? store(l.storeId)}) is dated ${l.entryDate}. Every opening figure is dated ${CONVERSION_DATE}.`);
  }

  // ---- T9 · inter-store, per pair: 1250 at A for B = 2150 at B for A ---------------------------------------------------------
  const owedTo = new Map<string, bigint>(); // `${creditor}|${debtor}` -> what the creditor says
  const owes = new Map<string, bigint>(); // `${creditor}|${debtor}` -> what the debtor says
  for (const l of lines.filter((x) => x.accountCode === '1250' || x.accountCode === '2150')) {
    if (l.partyType !== 'store' || l.partyId === null || l.storeId === null) {
      sentenceOnly('Inter-store balances', l.storeId, l.accountCode,
        `The ${l.accountCode} opening figure at ${store(l.storeId)} does not name the other store.`);
      continue;
    }
    if (l.accountCode === '1250') {
      const k = `${l.storeId}|${l.partyId}`;
      owedTo.set(k, (owedTo.get(k) ?? 0n) + cv(l.debit) - cv(l.credit));
    } else {
      const k = `${l.partyId}|${l.storeId}`;
      owes.set(k, (owes.get(k) ?? 0n) + cv(l.credit) - cv(l.debit));
    }
  }
  const pairKeys = [...new Set([...owedTo.keys(), ...owes.keys()])].sort();
  for (const k of pairKeys) {
    const [creditor = '', debtor = ''] = k.split('|');
    const said = owedTo.get(k) ?? 0n;
    const saidBack = owes.get(k) ?? 0n;
    if (said === saidBack) continue;
    add('Inter-store balances', creditor, '1250', said, saidBack,
      `${store(creditor)} says ${store(debtor)} owes it ${pesos(said)}; ${store(debtor)}'s opening says it owes ${store(creditor)} ${pesos(saidBack)}, ${pesos(said - saidBack)} apart.`);
  }

  // ---- T10 · 3900 per store -------------------------------------------------------------------------------------------------
  const equityStores = new Set<string | null>([...storeIds, ...lines.filter((l) => l.accountCode === EQUITY).map((l) => l.storeId)]);
  for (const s of [...equityStores].sort((a, b) => store(a).localeCompare(store(b)))) {
    const carried = netDebit(EQUITY, s);
    if (carried === 0n) continue;
    add('Opening equity', s, EQUITY, 0n, carried,
      `3900 at ${store(s)} carries ${pesos(carried)}. Each store's opening must clear on its own.`);
  }

  // ---- R15 · accounts with no register --------------------------------------------------------------------------------------
  const byAccount = new Map<string, bigint>();
  for (const l of lines) {
    if (COVERED_ACCOUNTS.has(l.accountCode)) continue;
    byAccount.set(l.accountCode, (byAccount.get(l.accountCode) ?? 0n) + cv(l.debit) - cv(l.credit));
  }
  // A cash/bank figure with no party cannot be compared with any money account's balance: list it, with its figure.
  const partyless = new Map<string, bigint>();
  for (const l of lines) {
    if ((MONEY_ACCOUNT_CODES as readonly string[]).includes(l.accountCode) && l.partyType === null) {
      partyless.set(l.accountCode, (partyless.get(l.accountCode) ?? 0n) + cv(l.debit) - cv(l.credit));
    }
  }
  const notChecked: NotCheckedLine[] = [...byAccount.entries()]
    .filter(([, c]) => c !== 0n)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, c]) => ({
      account,
      amount: `${pesos(c)} ${c > 0n ? 'debit' : 'credit'}`,
      reason: "This system has no register to compare it with. Agree it with v1's trial balance at the rehearsal.",
    }));

  for (const [account, c] of [...partyless.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (c === 0n) continue;
    notChecked.push({
      account,
      amount: `${pesos(c)} ${c > 0n ? 'debit' : 'credit'}`,
      reason: "No money account was named on this figure, so it is not compared with any money account's balance. Agree it with the bank or cash count.",
    });
  }
  return { holds: out.length === 0, lines: out, notChecked };
}

/** C5's refusal: the first five sentences, then a count of the rest. Raw and user text are the same sentences. */
export function tieOutRefusalText(lines: TieLine[]): string {
  const shown = lines.slice(0, 5).map((l) => l.sentence).join(' ');
  const rest = lines.length - 5;
  return rest > 0 ? `${shown} And ${rest} more.` : shown;
}

/** C4's detail: the first sentence and "and N more". */
export function tieOutDetail(lines: TieLine[]): string {
  const first = lines[0]?.sentence ?? '';
  return lines.length > 1 ? `${first} (and ${lines.length - 1} more)` : first;
}
