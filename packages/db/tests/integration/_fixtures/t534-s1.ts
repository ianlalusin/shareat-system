/**
 * T-534 S1 shared fixture (migration 0265). Raw SQL, so the DATABASE is what is proven. Runs on any `_test` database (the t401-menu fixture guards that).
 * One organisation, two stores, a person (and a manager), a cash and a wallet tender, a terminal per store, and `sale()`: a take-out session + one sales receipt with one
 * line (4 x 125 = 500) and one cash payment of 500, written in ONE transaction (migration 0240 refuses a child under an earlier transaction's receipt).
 */
import type postgres from 'postgres';
import { menuFixture, refusal, sql, uid, type PgErr } from './t401-menu';
import { insertTenderRaw } from './t629-tender';

export { refusal, sql, uid };
export type { PgErr };
export type Q = postgres.TransactionSql;

export const T = () => new Date();

export const insQ = async (tx: Q, table: string, row: Record<string, unknown>): Promise<string> =>
  ((await tx`insert into ${tx(table)} ${tx(row as never)} returning id`)[0] as { id: string }).id;
export const ins = (table: string, row: Record<string, unknown>) => sql.begin((tx) => insQ(tx, table, row));

/** Runs fn as a savepoint so an expected refusal does not end the surrounding transaction; resolves with the error, or undefined when accepted. */
export async function attempt(tx: Q, fn: (q: Q) => Promise<unknown>): Promise<PgErr | undefined> {
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp as Q);
    });
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}

export async function baseWorld(hint: string) {
  const f = await menuFixture(`t534-${hint}`);
  const manager = await ins('persons', { org_id: f.orgId, display_name: 'Manager' });
  const pairingId = await ins('pos_tablet_pairings', { org_id: f.orgId, store_id: f.storeId, label: 'Tablet 1', cookie_digest: uid('dg'), paired_by: f.personId });
  const pairing2Id = await ins('pos_tablet_pairings', { org_id: f.orgId, store_id: f.store2Id, label: 'Tablet B', cookie_digest: uid('dg'), paired_by: f.personId });
  const cash = await insertTenderRaw(sql, { orgId: f.orgId, storeId: f.storeId, name: uid('Cash'), kind: 'cash' });
  const gcashAccount = await ins('money_accounts', { org_id: f.orgId, store_id: f.storeId, name: 'GCash', instrument: 'bank', gl_account_code: '1140', custodian: 'office' });
  const wallet = await insertTenderRaw(sql, { orgId: f.orgId, storeId: f.storeId, name: uid('GCash'), kind: 'wallet', moneyAccountId: gcashAccount });
  const terminalId = await ins('pos_terminals', { org_id: f.orgId, store_id: f.storeId, terminal_no: 1, pairing_id: pairingId, created_by: f.personId, created_at: T() });
  const terminal2Id = await ins('pos_terminals', { org_id: f.orgId, store_id: f.store2Id, terminal_no: 1, pairing_id: pairing2Id, created_by: f.personId, created_at: T() });
  return { ...f, manager, pairingId, pairing2Id, cash, wallet, terminalId, terminal2Id };
}
export type W = Awaited<ReturnType<typeof baseWorld>>;

let seqN = 0;
export type Sale = { receiptId: string; lineId: string; paymentId: string; storeId: string };

/** A paid take-out sale at store 1 (or store 2), in one transaction. `w2` lets a test put the sale in another organisation's world. */
export async function sale(w: W, o: { store?: 1 | 2 } = {}): Promise<Sale> {
  const storeId = o.store === 2 ? w.store2Id : w.storeId;
  const terminalId = o.store === 2 ? w.terminal2Id : w.terminalId;
  const pairingId = o.store === 2 ? w.pairing2Id : w.pairingId;
  return sql.begin(async (tx) => {
    const sessionId = await insQ(tx, 'table_sessions', {
      org_id: w.orgId, store_id: storeId, stand_id: null, mode: 'take_out', heads_cashier: 0, opened_by: w.personId,
      opened_at_device: T(), opened_on_pairing_id: pairingId, opened_at: T(),
    });
    const receiptId = await insQ(tx, 'pos_sales_receipts', {
      org_id: w.orgId, store_id: storeId, terminal_id: terminalId, receipt_seq: ++seqN, table_session_id: sessionId, cashier_id: w.personId,
      issued_at_device: T(), received_at: T(), subtotal: '500.00', total: '500.00', device_total: '500.00', offline: false,
    });
    const lineId = await insQ(tx, 'pos_sales_receipt_lines', {
      org_id: w.orgId, receipt_id: receiptId, line_no: 1, kind: 'item', name: 'Pork belly', qty: 4, unit_price: '125.00', gross: '500.00', discount_total: '0.00', net: '500.00',
    });
    const paymentId = await insQ(tx, 'pos_sales_receipt_payments', { org_id: w.orgId, receipt_id: receiptId, tender_id: w.cash, amount: '500.00' });
    return { receiptId, lineId, paymentId, storeId };
  });
}

let zN = 0;
/** A Z for the store's terminal (one per business date per terminal). */
export const dayClose = (w: W, o: { store?: 1 | 2 } = {}) =>
  ins('pos_day_closes', {
    org_id: w.orgId, store_id: o.store === 2 ? w.store2Id : w.storeId, terminal_id: o.store === 2 ? w.terminal2Id : w.terminalId, z_no: ++zN,
    business_date: new Date(Date.UTC(2031, 0, 1 + zN)).toISOString().slice(0, 10), window_start: new Date(Date.now() - 3_600_000), window_end: T(),
    receipt_count: 1, gross_total: '500.00', closed_by: w.personId, approved_by: w.manager, closed_at: T(),
  });

export const conversionRow = (w: W, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId, store_id: w.storeId, terminal_id: w.terminalId, from_tender_id: w.cash, to_tender_id: w.wallet, amount: '500.00', note: null,
  recorded_by: w.personId, request_id: crypto.randomUUID(), ...o,
});
export const correctionRow = (w: W, s: Sale, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId, store_id: s.storeId, receipt_id: s.receiptId, payment_id: s.paymentId, from_tender_id: w.cash, to_tender_id: w.wallet, amount: '300.00',
  reference_no: 'GC1234567', reason: 'Customer paid by GCash', approved_by: w.manager, recorded_by: w.personId, request_id: crypto.randomUUID(), ...o,
});
let refundSeqN = 0;
export const refundRow = (w: W, s: Sale, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId, store_id: s.storeId, terminal_id: s.storeId === w.store2Id ? w.terminal2Id : w.terminalId, parent_receipt_id: s.receiptId, refund_seq: ++refundSeqN, total: '125.00',
  reason: 'One portion returned', approved_by: w.manager, recorded_by: w.personId, request_id: crypto.randomUUID(), ...o,
});
export const refundLineRow = (w: W, s: Sale, refundId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId, refund_id: refundId, receipt_id: s.receiptId, receipt_line_id: s.lineId, qty: 1, amount: '125.00', ...o,
});
export const refundPaymentRow = (w: W, s: Sale, refundId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId, refund_id: refundId, receipt_id: s.receiptId, payment_id: s.paymentId, tender_id: w.cash, amount: '125.00', reference_no: null, ...o,
});

/** UPDATE / DELETE as the owner with replication-role triggers off: an ENABLE ALWAYS guard must still fire. */
export const underReplica = (fn: (tx: Q) => Promise<unknown>) =>
  refusal(() =>
    sql.begin(async (tx) => {
      await tx.unsafe(`set local session_replication_role = 'replica'`);
      await fn(tx);
    }),
  );

/** The statement must have been refused with this SQLSTATE (and, when given, by this named constraint or a message containing it). */
export const expectCode = (e: PgErr | undefined, code: string, named?: string) => {
  if (!e) throw new Error(`statement was ACCEPTED, expected ${code}${named ? ` ${named}` : ''}`);
  const c = (e as PgErr & { constraint_name?: string }).constraint_name ?? '';
  if (e.code !== code || (named && c !== named && !e.message.includes(named))) throw new Error(`expected ${code} ${named ?? ''}, got ${e.code} ${c}: ${e.message}`);
};
