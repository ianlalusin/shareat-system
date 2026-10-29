/**
 * T-454 S4 - the Banay-Banay close-out check (docs/tasks/454-drop-banay-banay.md section 4 S4, ruling in section 10).
 *
 * Pure: reads the landed v1 documents it is given and returns the lines to print and the exit code. No I/O of any kind.
 * Exit 0 only when every PARTY (supplier, customer, employee advance) of the store is exactly zero at `asOf`, each on its
 * own, never netted. Account balances (cash, stock, equipment) are printed as information and never fail the check:
 * the hand-over is done offline and carried in Lipa's opening count.
 */
import { isZero } from '@shareat/core/money';
import { reconstructBalances, type LandedDocLike } from './balances';

export interface ExpectZeroOptions {
  storeId: string;
  asOf: string;
  storeName?: string;
  /** party id -> display name; an id without a name is printed as the id. */
  partyNames?: Readonly<Record<string, string>>;
}

export interface ExpectZeroResult {
  exitCode: 0 | 1;
  lines: string[];
}

const OFFLINE_HEADING = "Handled offline, carried in Lipa's opening";

export function checkExpectZero(docs: readonly LandedDocLike[], opts: ExpectZeroOptions): ExpectZeroResult {
  const result = reconstructBalances(docs, { asOf: opts.asOf, storeIds: [opts.storeId] });
  const store = opts.storeName ?? opts.storeId;
  const lines: string[] = [];

  const openParties = result.partyBalances
    .filter((p) => p.storeCode === opts.storeId && !isZero(p.netBalance))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.partyId.localeCompare(b.partyId));
  const openAccounts = result.balances
    .filter((b) => b.storeCode === opts.storeId && !isZero(b.netBalance))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  if (openParties.length === 0) {
    lines.push(`${store}: every supplier and customer balance is zero at ${opts.asOf}`);
  } else {
    lines.push(`${store}: ${openParties.length} open party balance(s) at ${opts.asOf}`);
    for (const p of openParties) {
      const name = opts.partyNames?.[p.partyId] ?? p.partyId;
      lines.push(`  OPEN ${p.partyType} ${name}: account ${p.accountCode} balance PHP ${p.netBalance}`);
    }
  }

  if (openAccounts.length > 0) {
    lines.push('');
    lines.push(`${OFFLINE_HEADING} (information only, does not change the result):`);
    for (const a of openAccounts) lines.push(`  ${a.accountCode}  PHP ${a.netBalance}`);
  }

  return { exitCode: openParties.length === 0 ? 0 : 1, lines };
}
