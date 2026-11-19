/**
 * T-534 S2 - Convert (GCash cash-in / cash-out): the store hands over cash and the customer sends GCash, or the other way round. docs/tasks/534-pos-convert-correction-refund.md,
 * bible rows 359, 391; ADR-015 A4.2.
 *
 * ## What it is, and is not
 * A Convert is NOT a sale: it moves money between two tenders of ONE store (From = the money that leaves, To = the money that comes in). It is its own document
 * (`pos_payment_conversions`), idempotent on `request_id`, and the Z collects it (`day_close_id`, set once) into its own Convert block. Receipts and the sales figures never change.
 *   cash -> GCash   the drawer pays cash out, GCash comes in      (customer: "cash out")
 *   GCash -> cash   the drawer takes cash in, GCash goes out      (customer: "cash in")
 * Expected drawer cash moves by `net = cash in - cash out` (bible row 391).
 *
 * ## Rules that are easy to get wrong
 *  - Who: `record_sale` at the store, NO PIN (T-427 ruling, as v1). Void: the person who recorded it, or anyone who holds `approve_pos_correction`, until the Z. Online only (an API call).
 *  - A void and a Z take the same per-store lock (`lockPosDayClose`), so a void can never slip in after the Z read the figures: the Z reads what the void committed, or the void is refused.
 *  - The books: ONE entry per Z per pair of methods, NET of voids and of the opposite direction (`transfer.cash.simple`: DR the receiving account, CR the paying one). Cash is the
 *    cashier's till (1110, as every sale's cash), a wallet is its own money account (1140 with the account as party). Test mode never books (as the sales day).
 *  - v2 keeps no live wallet balance, so nothing here refuses a wallet "going below zero" (T-534 Out).
 */
import { authorize, can, type Actor } from '@shareat/auth';
import { compare, fromCentavos, money, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { advisoryLocksRepo, journalRepo, moneyAccountsRepo, posV1Repo, posV2Repo, type Tx } from '@shareat/db';
import { buildPeriodFacts, periodRefusal } from '../business-rules';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { gone, refuse } from '../shared/refusal';
import { parseMoneyInput } from '../shared/money-input';
import { audit, recordedDifferently, requireContext, uuidInput, uuidv5, type PosDeps } from './shared';

// ---------------------------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------------------------
export const CONVERT_SAME_TENDER = 'Pick two different payment methods.';
export const CONVERT_TENDER_NOT_AVAILABLE = 'That payment method is not available at this store.';
export const CONVERT_NOTE_TOO_LONG = 'The note is too long. Keep it under 200 characters.';
export const CONVERT_CLOSED = 'This Convert is already in a closed day, so it cannot be voided any more.';
export const CONVERT_VOID_WHO = 'Only the cashier who recorded this Convert, or a manager, can void it.';
const NOTE_MAX = 200;
const DEFAULT_VOID_REASON = 'Voided on the till';

type Row = posV2Repo.PosPaymentConversionRow;
type Tender = posV1Repo.TenderRow;

// ---------------------------------------------------------------------------------------------------------------------
// The figures (pure)
// ---------------------------------------------------------------------------------------------------------------------
/** What a Z, an X or a handover shows for Convert. `net` = cash in - cash out = the change in expected drawer cash (row 391). Wallet-to-wallet moves count in neither. */
export interface ConvertBlock {
  cashIn: Money;
  cashOut: Money;
  net: Money;
  /** Converts that count (voided ones are not). */
  count: number;
}

export const NO_CONVERT: ConvertBlock = { cashIn: ZERO, cashOut: ZERO, net: ZERO, count: 0 };

/** The block of a set of conversions; voided ones are skipped here, so no caller can forget to. */
export function convertBlockOf(conversions: readonly Pick<Row, 'fromTenderId' | 'toTenderId' | 'amount' | 'voidedAt'>[], tenderKind: ReadonlyMap<string, 'cash' | 'wallet'>): ConvertBlock {
  let cashIn = 0n;
  let cashOut = 0n;
  let count = 0;
  for (const c of conversions) {
    if (c.voidedAt) continue;
    count += 1;
    const cents = toCentavos(money(c.amount));
    if (tenderKind.get(c.toTenderId) === 'cash') cashIn += cents;
    if (tenderKind.get(c.fromTenderId) === 'cash') cashOut += cents;
  }
  return { cashIn: fromCentavos(cashIn), cashOut: fromCentavos(cashOut), net: fromCentavos(cashIn - cashOut), count };
}

/** The tender kinds of a store, as the block and the books read them. */
export const kindsOf = (tenders: readonly Tender[]): Map<string, 'cash' | 'wallet'> => new Map(tenders.map((t) => [t.id, t.kind as 'cash' | 'wallet']));

/**
 * One net move per PAIR of methods, voided conversions out: A->B 500 and B->A 200 is one move of 300 from A to B, and a pair that nets to zero is no move at all.
 * The pair is unordered, so the same pair is the same key whichever way a conversion went.
 */
export function netMovesOf(conversions: readonly Pick<Row, 'fromTenderId' | 'toTenderId' | 'amount' | 'voidedAt'>[]): { pairKey: string; fromTenderId: string; toTenderId: string; amount: Money }[] {
  const net = new Map<string, { lo: string; hi: string; loToHi: bigint }>();
  for (const c of conversions) {
    if (c.voidedAt) continue;
    const [lo, hi] = [c.fromTenderId, c.toTenderId].sort();
    const key = `${lo}:${hi}`;
    const cur = net.get(key) ?? { lo, hi, loToHi: 0n };
    cur.loToHi += (c.fromTenderId === lo ? 1n : -1n) * toCentavos(money(c.amount));
    net.set(key, cur);
  }
  return [...net.entries()]
    .filter(([, v]) => v.loToHi !== 0n)
    .map(([pairKey, v]) => ({
      pairKey,
      fromTenderId: v.loToHi > 0n ? v.lo : v.hi,
      toTenderId: v.loToHi > 0n ? v.hi : v.lo,
      amount: fromCentavos(v.loToHi > 0n ? v.loToHi : -v.loToHi),
    }));
}

// ---------------------------------------------------------------------------------------------------------------------
// recordConversion
// ---------------------------------------------------------------------------------------------------------------------
export interface RecordConversionInput {
  storeId: string;
  /** The tablet; a Convert is a till act. */
  pairingId: string | null;
  /** Device-made uuid: the row's idempotency key, so a retry is the same row. */
  requestId: string;
  fromTenderId: string;
  toTenderId: string;
  amount: string;
  note?: string | null;
}

/** The store's tender for a Convert: its own, active, and (a wallet) with a money account to book against. */
export function usableTender(tenders: readonly Tender[], id: string): Tender {
  const t = tenders.find((x) => x.id === id);
  if (!t || !t.isActive) throw refuse(`pos: convert tender ${id} is not an active tender of the store`, CONVERT_TENDER_NOT_AVAILABLE);
  if (t.kind === 'wallet' && !t.moneyAccountId) {
    throw refuse(`pos: wallet tender ${t.id} has no money account`, `The tender ${t.name} has no money account. An admin fixes it under Settings › POS link.`);
  }
  return t;
}

export async function recordConversion(tx: Tx, actor: Actor, input: RecordConversionInput): Promise<{ wrote: boolean; id: string }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  const requestId = uuidInput(input.requestId, 'The request id');
  const fromId = uuidInput(input.fromTenderId, 'The "From" method');
  const toId = uuidInput(input.toTenderId, 'The "To" method');
  if (fromId === toId) throw refuse('pos: convert from and to are the same tender', CONVERT_SAME_TENDER);
  const amount = parseMoneyInput(String(input.amount ?? ''), 'recordConversion: amount', 'The amount');
  if (compare(amount, ZERO) <= 0) throw refuse('pos: convert amount not above zero', 'The amount must be above zero.');
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;
  if (note !== null && note.length > NOTE_MAX) throw refuse('pos: convert note too long', CONVERT_NOTE_TOO_LONG);

  // A retry of the same request is answered before anything else is judged (and must be the same Convert).
  const same = (r: Row) => r.storeId === storeId && r.fromTenderId === fromId && r.toTenderId === toId && toCentavos(money(r.amount)) === toCentavos(amount);
  const prior = await posV2Repo.getPaymentConversionByRequestId(tx, orgId, requestId);
  if (prior) {
    if (!same(prior)) throw recordedDifferently();
    return { wrote: false, id: prior.id };
  }

  const terminal = await posV2Repo.getTerminalForPairing(tx, orgId, storeId, pairingId);
  if (!terminal) throw refuse('pos: no till for this tablet', 'This tablet is not set up as a till yet. Ask a manager.');
  const tenders = await posV1Repo.listTendersByStore(tx, orgId, storeId);
  usableTender(tenders, fromId);
  usableTender(tenders, toId);

  const row = await posV2Repo.insertPaymentConversion(tx, { orgId, storeId, terminalId: terminal.id, fromTenderId: fromId, toTenderId: toId, amount, note, recordedBy: actor.personId, requestId });
  if (!row) {
    // A racing identical POST committed first.
    const won = await posV2Repo.getPaymentConversionByRequestId(tx, orgId, requestId);
    if (!won || !same(won)) throw recordedDifferently();
    return { wrote: false, id: won.id };
  }
  await audit(tx, actor, 'pos.conversion_recorded', {
    storeId, entityId: row.id, pairingId, at: row.recordedAt, before: null,
    after: { fromTenderId: fromId, toTenderId: toId, amount, hasNote: note !== null },
  });
  return { wrote: true, id: row.id };
}

// ---------------------------------------------------------------------------------------------------------------------
// voidConversion
// ---------------------------------------------------------------------------------------------------------------------
export interface VoidConversionInput {
  storeId: string;
  pairingId: string | null;
  conversionId: string;
  reason?: string | null;
}

/** Voids a Convert that is not yet in a Z. The recorder, or anyone holding `approve_pos_correction` at the store. A void already written is a no-op. */
export async function voidConversion(tx: Tx, actor: Actor, input: VoidConversionInput, deps?: PosDeps): Promise<{ wrote: boolean }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const pairingId = (await requireContext(tx, actor, storeId, input.pairingId, false))!;
  const id = uuidInput(input.conversionId, 'The Convert');
  const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim().slice(0, NOTE_MAX) : DEFAULT_VOID_REASON;
  // The Z's own lock: the void and the Z queue, so the Z never freezes figures a void is about to change.
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);
  const row = await posV2Repo.getPaymentConversion(tx, orgId, storeId, id);
  if (!row) throw gone(`pos: conversion ${id} not found`, 'that Convert');
  if (row.voidedAt) return { wrote: false };
  if (row.dayCloseId) throw refuse('pos: void after the Z', CONVERT_CLOSED);
  if (row.recordedBy !== actor.personId && !(await can(tx, actor, 'approve_pos_correction', { storeId }))) throw refuse('pos: void by someone else', CONVERT_VOID_WHO);
  const at = deps?.now ? deps.now() : new Date();
  if ((await posV2Repo.voidPaymentConversion(tx, orgId, storeId, id, { by: actor.personId, at, reason })) === 0) throw refuse('pos: void raced a Z', CONVERT_CLOSED);
  await audit(tx, actor, 'pos.conversion_voided', { storeId, entityId: id, pairingId, at, before: { voided: false }, after: { voided: true, reason } });
  return { wrote: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// listOpenConversions (the Till screen's list)
// ---------------------------------------------------------------------------------------------------------------------
export interface OpenConversion {
  id: string;
  fromName: string;
  toName: string;
  amount: string;
  note: string | null;
  recordedAt: string;
  recordedByName: string;
  voided: boolean;
  /** This person may void it (they recorded it, or hold `approve_pos_correction`) and it is not voided. */
  canVoid: boolean;
}

/** The store's Converts not yet in a Z, oldest first (voided ones included, marked). `record_sale`. */
export async function listOpenConversions(tx: Tx, actor: Actor, input: { storeId: string }): Promise<{ conversions: OpenConversion[] }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const rows = await posV2Repo.listOpenPaymentConversions(tx, actor.orgId, input.storeId);
  const tenders = new Map((await posV1Repo.listTendersByStore(tx, actor.orgId, input.storeId)).map((t) => [t.id, t.name]));
  const names = await posV2Repo.listPersonNames(tx, actor.orgId, rows.map((r) => r.recordedBy));
  const approver = rows.length > 0 && (await can(tx, actor, 'approve_pos_correction', { storeId: input.storeId }));
  return {
    conversions: rows.map((r) => ({
      id: r.id,
      fromName: tenders.get(r.fromTenderId) ?? 'Unknown method',
      toName: tenders.get(r.toTenderId) ?? 'Unknown method',
      amount: r.amount,
      note: r.note,
      recordedAt: r.recordedAt.toISOString(),
      recordedByName: names.get(r.recordedBy) ?? '',
      voided: r.voidedAt !== null,
      canVoid: r.voidedAt === null && (approver || r.recordedBy === actor.personId),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The books, at the Z
// ---------------------------------------------------------------------------------------------------------------------
/**
 * POSTING-PATTERNS `transfer.cash.simple` (a same-store move between two of the store's own money places): one entry per pair of methods, DR the account the money
 * arrives in, CR the account it leaves. Net of voids and of the opposite direction. Cash is the cashier's till (1110, store-scoped, as every sale's cash); a wallet is 1140
 * with its money account as the party. Called by the Z for a LIVE store only, inside the close's transaction: a refusal rolls the whole close back, like the sales day's.
 */
export async function postConversionsForZ(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; closeId: string; businessDate: string; conversions: readonly Row[]; tenders: readonly Tender[] },
): Promise<string[]> {
  const { orgId } = actor;
  const moves = netMovesOf(input.conversions);
  if (moves.length === 0) return [];
  const byId = new Map(input.tenders.map((t) => [t.id, t]));
  const side = async (t: Tender): Promise<Pick<PostEntryLine, 'accountCode' | 'partyType' | 'partyId'>> => {
    if (t.kind === 'cash') return { accountCode: '1110' };
    const account = t.moneyAccountId ? await moneyAccountsRepo.getById(tx, orgId, t.moneyAccountId) : undefined;
    if (!account || !account.isActive) {
      throw refuse(`pos: money account of tender ${t.id} is retired or missing`, `${t.name}'s money account is no longer active, so this day can't be closed. An admin sets ${t.name}'s account under Settings › POS link.`);
    }
    return { accountCode: '1140', partyType: 'money_account', partyId: account.id };
  };
  const month = periodRefusal(buildPeriodFacts(await journalRepo.findPeriodForDate(tx, orgId, input.businessDate)), { override: false });
  if (month) throw refuse(`pos: the fiscal period covering ${input.businessDate} is ${month.kind}`, month.sentence);
  const entries: string[] = [];
  for (const m of moves) {
    const from = byId.get(m.fromTenderId);
    const to = byId.get(m.toTenderId);
    if (!from || !to) throw refuse(`pos: convert tender missing from store ${input.storeId}`, CONVERT_TENDER_NOT_AVAILABLE);
    const amount = String(m.amount);
    const posted = await postEntry(tx, {
      orgId,
      entryDate: input.businessDate,
      sourceType: 'transfer',
      sourceId: uuidv5(m.pairKey, input.closeId),
      idempotencyKey: `pos_convert:${input.closeId}:${m.pairKey}`,
      memo: `Convert - ${from.name} to ${to.name}`,
      postedBy: actor.personId,
      lines: [
        { ...(await side(to)), storeId: input.storeId, debit: amount },
        { ...(await side(from)), storeId: input.storeId, credit: amount },
      ],
    });
    entries.push(posted.entryId);
  }
  return entries;
}
