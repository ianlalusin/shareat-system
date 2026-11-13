/**
 * T-524 R8 (void) and R9 (pay): docs/tasks/524-pos-v2-domain.md.
 *
 * `completeSale` is the one place a sale becomes a sales receipt: the server recomputes every figure from the DATABASE lines and discounts
 * (`priceSession`), writes ITS figures, records a mismatch with the tablet's (never refuses the sale for one, row 276, exact centavos, no
 * tolerance), takes the payments (change only from cash), writes one statutory row per senior/PWD diner, freezes lines / discounts / payments and
 * ends the session `paid` - all in the caller's ONE transaction (migration 0240 refuses a child appended under an earlier transaction's receipt).
 */
import { add, compare, fromCentavos, money, subtract, toCentavos, type Money } from '@shareat/core/money';
import { authorize, can, verifyPosManagerApproval, POS_TERMINAL_NOT_REGISTERED, type Actor } from '@shareat/auth';
import { posV2Repo, statutoryDiscountsRepo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { parseMoneyInput } from '../shared/money-input';
import { POS_PAYMENT_REFERENCE_RULES, POS_REASON_RULES, POS_STATUTORY_HOLDER_RULES } from '../field-rules/pos';
import { priceSession, type PricedSession } from './price';
import { isUniqueViolation, lockOpenSession } from './order';
import { earlierUsesOfCard } from './senior-repeat';
import {
  audit,
  billedHeads,
  businessDateAndRules,
  businessDateOf,
  deviceTime,
  loadLiveLines,
  recordedDifferently,
  requireContext,
  requireStoreScope,
  snapshotOf,
  uuidInput,
  wholeNumber,
  type LoadedLine,
  type PosDeps,
} from './shared';

// ---------------------------------------------------------------------------------------------------------------------
// R8 voidUnpaidSession
// ---------------------------------------------------------------------------------------------------------------------
export interface VoidInput {
  storeId: string;
  pairingId: string | null;
  sessionId: string;
  reason: string;
  voidedAtDevice: string | Date;
  offline: boolean;
  /** The manager's PIN. The terminal person is resolved here from the store's terminal link, never taken from the input (audit F8). */
  approval?: { pin: string };
}

export async function voidUnpaidSession(tx: Tx, actor: Actor, input: VoidInput): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const { reason } = assertFieldRules(POS_REASON_RULES, { reason: input.reason });
  const at = deviceTime(input.voidedAtDevice, 'The time of the void');
  const offline = input.offline === true;
  const sessionId = uuidInput(input.sessionId, 'The table id');
  // Audit F6: a replay of a void already written is answered before the table's state is judged.
  if ((await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, sessionId))?.status === 'voided') return { wrote: false };
  const session = await lockOpenSession(tx, actor.orgId, input.storeId, sessionId);

  // The approver is the actor when the actor may approve a correction here, otherwise a manager's PIN (online only: offline the tablet already refused, row 356).
  let approverId = actor.personId;
  if (!(await can(tx, actor, 'approve_pos_correction', { storeId: input.storeId }))) {
    if (offline) throw refuse('pos: void needs approval online', 'A manager must approve voiding a table, and that needs the internet.');
    if (!input.approval) throw refuse('pos: void needs approval', 'A manager must approve voiding a table. Ask for a manager PIN.');
    // Audit F8: whose PIN bucket a wrong PIN charges is the store's own registered terminal (as pos-approval.ts resolves it), never a value the device names.
    const terminalPersonId = await posV2Repo.getActiveTerminalPersonId(tx, actor.orgId, input.storeId);
    if (!terminalPersonId) throw refuse('pos: no terminal link for the store', POS_TERMINAL_NOT_REGISTERED);
    approverId = (await verifyPosManagerApproval(tx, { orgId: actor.orgId, erpStoreId: input.storeId, pin: input.approval.pin, terminalPersonId })).approverPersonId;
  }

  // Lines and discounts first: the database refuses to change them once the session is closed.
  const lines = await posV2Repo.listSessionLines(tx, actor.orgId, input.storeId, session.id);
  const queued = lines.filter((l) => l.kitchenStatus === 'queued').map((l) => l.id);
  const discounts = (await posV2Repo.listLineDiscounts(tx, actor.orgId, input.storeId, lines.map((l) => l.id))).filter((d) => d.status === 'active');
  await posV2Repo.removeLineDiscounts(tx, actor.orgId, input.storeId, discounts.map((d) => d.id), actor.personId, at);
  await posV2Repo.markLinesCancelled(tx, actor.orgId, input.storeId, queued);
  await posV2Repo.markSessionVoided(tx, actor.orgId, input.storeId, session.id, { voidedBy: approverId, voidedAtDevice: at, voidReason: reason!, voidedOffline: offline });
  await audit(tx, actor, 'pos.session_voided', {
    storeId: input.storeId, entityId: session.id, pairingId, at,
    before: { status: 'open', linesCancelled: queued.length, discountsRemoved: discounts.length },
    after: { status: 'voided', reason, offline, approvedBy: approverId },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// R9 completeSale
// ---------------------------------------------------------------------------------------------------------------------
export interface CompleteSaleInput {
  storeId: string;
  pairingId: string | null;
  sessionId: string;
  receiptId: string;
  terminalNo: number;
  terminalSeq: number;
  issuedAtDevice: string | Date;
  offline: boolean;
  device: { subtotal: string; discountTotal: string; total: string; lines: { lineId: string; gross: string; discountTotal: string; net: string }[] };
  payments: { tenderId: string; amount: string; referenceNo?: string; toCheck: boolean }[];
  seniors: { dinerNo: number; kind: 'senior' | 'pwd'; idNumber: string; holderName: string }[];
}

const MAX_PAYMENTS = 20;
/** The mismatch audit row keeps at most this many lines per side (the totals are always there), with a `truncated` flag. */
const MISMATCH_LINE_CAP = 200;
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** What the bill is, priced from the database (the screen's figure and the receipt's figure are this one). */
async function priceFromDb(tx: Tx, actor: Actor, storeId: string, lines: LoadedLine[], deps: PosDeps | undefined, at?: Date): Promise<{ priced: PricedSession; rules: Awaited<ReturnType<typeof businessDateAndRules>> | undefined }> {
  const taxType = await posV2Repo.getOrgTaxType(tx, actor.orgId);
  // T-528: always the real rates, so `priced.vat` (the receipt's VAT split) is right for every bill, not only one with a senior/PWD discount.
  const resolved = await businessDateAndRules(tx, actor.orgId, storeId, deps, at);
  return { priced: priceSession(snapshotOf(lines, taxType === 'vat', resolved.rules)), rules: resolved };
}

const sameCentavos = (a: string, b: Money) => {
  try {
    return toCentavos(money(a)) === toCentavos(b);
  } catch {
    return false;
  }
};

/** T-556 (audit P-001, R9): a replay is a no-op only when it carries what the frozen receipt recorded: the sale's flags, time and tablet total, its payments and its card holders. */
async function replayMatches(tx: Tx, actor: Actor, input: CompleteSaleInput, prior: posV2Repo.PosSalesReceiptRow, at: { issuedAt: Date; offline: boolean; printed: string }): Promise<boolean> {
  if (prior.offline !== at.offline || prior.issuedAtDevice.getTime() !== at.issuedAt.getTime() || !sameCentavos(String(input.device?.total ?? ''), money(prior.deviceTotal))) return false;
  const pays = input.payments;
  if (!Array.isArray(pays)) return false;
  const kinds = new Map((await posV2Repo.listTenders(tx, actor.orgId, pays.map((p) => String(p.tenderId)))).map((t) => [t.id, t.kind]));
  const payKey = (tenderId: string, amount: Money, ref: string, toCheck: boolean) => `${tenderId}|${toCentavos(amount)}|${ref}|${toCheck}`;
  const sent = pays.map((p) => {
    const ref = kinds.get(String(p.tenderId)) === 'wallet' ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: p.referenceNo ?? '' }).referenceNo! : '';
    return payKey(String(p.tenderId), parseMoneyInput(String(p.amount ?? ''), 'pos: the payment amount', 'The payment amount'), ref, p.toCheck === true);
  });
  const stored = (await posV2Repo.listReceiptPayments(tx, actor.orgId, prior.id)).map((r) => payKey(r.tenderId, money(r.amount), r.referenceNo ?? '', r.toCheck));
  if (JSON.stringify(sent.sort()) !== JSON.stringify(stored.sort())) return false;

  const holders = (Array.isArray(input.seniors) ? input.seniors : []).map((e) => {
    const h = assertFieldRules(POS_STATUTORY_HOLDER_RULES, { holderName: e.holderName ?? '', idNumber: e.idNumber ?? '' });
    return { dinerNo: e.dinerNo, kind: e.kind, idNumber: h.idNumber!, holderName: h.holderName! };
  });
  const card = (x: { kind: string; idNumber: string; holderName: string }) => `${x.kind}|${x.idNumber}|${x.holderName}`;
  const recorded = await posV2Repo.listReceiptStatutory(tx, actor.orgId, prior.storeId, prior.id, at.printed);
  if (JSON.stringify(holders.map(card).sort()) !== JSON.stringify(recorded.map(card).sort())) return false;
  // shortcut: a diner's number is checked only where its discount left a receipt row (one that rounded to nothing leaves none), the card details always.
  return recorded.every((r) => r.dinerNo === null || holders.some((h) => h.dinerNo === r.dinerNo && card(h) === card(r)));
}

export async function completeSale(tx: Tx, actor: Actor, input: CompleteSaleInput, deps?: PosDeps): Promise<{ wrote: boolean; receiptId: string }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const { storeId } = input;
  const sessionId = uuidInput(input.sessionId, 'The table id');
  const receiptId = uuidInput(input.receiptId, 'The receipt id');
  const terminalNo = wholeNumber(input.terminalNo, { what: 'The terminal number', min: 1, max: 99 });
  const terminalSeq = wholeNumber(input.terminalSeq, { what: 'The receipt number', min: 1, max: 2_147_483_647 });
  const issuedAt = deviceTime(input.issuedAtDevice, 'The time of the sale');
  const offline = input.offline === true;

  // 1. The session, locked. A replay of a sale already recorded is answered before the table's state is judged.
  const session = await posV2Repo.lockSession(tx, actor.orgId, storeId, sessionId);
  if (!session) throw gone(`pos: table session ${sessionId} not found`, 'table');
  const terminal = await posV2Repo.getTerminalByNo(tx, actor.orgId, storeId, terminalNo);
  const prior = await posV2Repo.getReceiptBySession(tx, actor.orgId, storeId, sessionId);
  if (prior) {
    if (prior.id === receiptId && prior.terminalSeq === terminalSeq && terminal?.id === prior.terminalId) {
      if (!(await replayMatches(tx, actor, input, prior, { issuedAt, offline, printed: `${await posV2Repo.getStoreCode(tx, actor.orgId, storeId)}-${pad(terminalNo, 2)}-${pad(terminalSeq, 6)}` }))) throw recordedDifferently();
      return { wrote: false, receiptId };
    }
    if (prior.id === receiptId) throw recordedDifferently();
    throw refuse('pos: table already paid', 'This table is already paid.');
  }
  if (await posV2Repo.getSalesReceipt(tx, actor.orgId, storeId, receiptId)) throw recordedDifferently();
  if (session.status !== 'open') throw refuse(`pos: session is ${session.status}`, session.status === 'voided' ? 'This table was voided.' : 'This table is already paid.');
  const lines = await loadLiveLines(tx, actor.orgId, storeId, sessionId);
  if (lines.length === 0) throw refuse('pos: nothing to pay', 'There is nothing on this table to pay for.');
  // Audit F2: a rule breach, not a total mismatch: the senior/PWD guests on the package can never outnumber the billed heads.
  const statutoryOnPackage = lines.filter((l) => l.kind === 'package').flatMap((l) => l.discounts).filter((d) => d.kind === 'senior' || d.kind === 'pwd').reduce((a, d) => a + d.qty, 0);
  if (statutoryOnPackage > billedHeads(session.headsCashier, session.headsServer)) {
    throw refuse('pos: more seniors than heads', 'There are more senior or PWD discounts than guests at this table. Remove one before paying.');
  }
  if (!terminal || terminal.pairingId !== pairingId) throw refuse('pos: terminal mismatch', 'This tablet is not set up as that till. Ask a manager.');
  if (await posV2Repo.terminalSeqUsed(tx, actor.orgId, terminal.id, terminalSeq)) throw refuse('pos: receipt number reused', 'That receipt number is already used on this till.');

  // 2. Recompute from the database; the server's figures are the receipt's.
  const { priced, rules } = await priceFromDb(tx, actor, storeId, lines, deps, issuedAt); // the day is the sale's own (its device time), not the replay's
  const dev = input.device;
  const devLines = new Map((dev?.lines ?? []).map((l) => [l.lineId, l]));
  const matches =
    sameCentavos(dev?.subtotal ?? '', money(priced.subtotal)) &&
    sameCentavos(dev?.discountTotal ?? '', money(priced.discountTotal)) &&
    sameCentavos(dev?.total ?? '', money(priced.total)) &&
    (dev?.lines ?? []).length === priced.lines.length &&
    priced.lines.every((l) => {
      const d = devLines.get(l.lineId);
      return d !== undefined && sameCentavos(d.gross, l.gross) && sameCentavos(d.discountTotal, l.discountTotal) && sameCentavos(d.net, l.net);
    });
  const deviceTotal = parseMoneyInput(String(dev?.total ?? ''), 'pos: the tablet total', 'The tablet total');

  // 3. Payments (row 438).
  const pays = input.payments;
  if (!Array.isArray(pays) || pays.length < 1 || pays.length > MAX_PAYMENTS) throw refuse('pos: payment count', `Take between 1 and ${MAX_PAYMENTS} payments.`);
  const tenders = new Map((await posV2Repo.listTenders(tx, actor.orgId, pays.map((p) => String(p.tenderId)))).map((t) => [t.id, t]));
  const rows = pays.map((p) => {
    const t = tenders.get(String(p.tenderId));
    if (!t || t.storeId !== storeId || !t.isActive) throw refuse('pos: tender not usable', 'That way of paying is not available at this store.');
    const amount = parseMoneyInput(String(p.amount ?? ''), 'pos: the payment amount', 'The payment amount');
    if (compare(amount, money('0')) <= 0) throw refuse('pos: payment not positive', 'Each payment must be more than zero.');
    const wallet = t.kind === 'wallet';
    // Ruling 5: every wallet payment needs its reference; offline it is "to check" against the statement, online never.
    const referenceNo = wallet ? assertFieldRules(POS_PAYMENT_REFERENCE_RULES, { referenceNo: p.referenceNo ?? '' }).referenceNo! : null;
    if (p.toCheck !== (offline && wallet)) {
      throw refuse('pos: to-check flag wrong', wallet ? 'A wallet payment taken without the internet must be marked to check; online it must not.' : 'Only a wallet payment taken without the internet is marked to check.');
    }
    return { tenderId: t.id, kind: t.kind, amount, referenceNo, toCheck: p.toCheck };
  });
  const paid = rows.reduce((a, r) => add(a, r.amount), money('0'));
  const total = money(priced.total);
  // T-558 (row 453): a short payment is RECORDED, never refused (the customer has already left). gap > 0 means no change; it is a routine variance up to the
  // tolerance in force on the sale's business date, a finding above it. Overpayment keeps the change-only-from-cash rule below.
  const gap = compare(paid, total) < 0 ? subtract(total, paid) : money('0');
  const change = compare(paid, total) < 0 ? money('0') : subtract(paid, total);
  let changeRow = -1;
  if (compare(change, money('0')) > 0) {
    const cash = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'cash').sort((a, b) => compare(b.r.amount, a.r.amount));
    if (cash.length === 0 || compare(change, cash[0]!.r.amount) > 0) throw refuse('pos: change not from cash', 'Change can only be given in cash.');
    changeRow = cash[0]!.i;
  }

  // 4. Senior / PWD (rows 437, 439): one statutory row per diner, the card details written only there (row 353).
  const diners = new Map<number, { kind: 'senior' | 'pwd'; gross: bigint; discount: bigint }>();
  const dinerOf = new Map<string, number>();
  for (const l of lines) for (const d of l.discounts) if (d.kind === 'senior' || d.kind === 'pwd') dinerOf.set(d.id, d.dinerNo!);
  for (const pl of priced.lines) {
    for (const pd of pl.discounts) {
      const dn = dinerOf.get(pd.discountId);
      if (dn === undefined) continue;
      const kind = lines.flatMap((l) => l.discounts).find((d) => d.id === pd.discountId)!.kind as 'senior' | 'pwd';
      const cur = diners.get(dn) ?? { kind, gross: 0n, discount: 0n };
      cur.gross += toCentavos(pd.coveredGross);
      cur.discount += toCentavos(pd.vatRemoved) + toCentavos(pd.discountAmount);
      diners.set(dn, cur);
    }
  }
  const entries = Array.isArray(input.seniors) ? input.seniors : [];
  if (new Set(entries.map((e) => e.dinerNo)).size !== entries.length) throw refuse('pos: diner listed twice', 'A senior or PWD diner is listed twice.');
  if (entries.length !== diners.size || entries.some((e) => !diners.has(e.dinerNo))) {
    throw refuse('pos: senior details do not match the discounts', 'Every senior or PWD discount needs that diner\'s card details, and no one else\'s.');
  }
  const holders = entries.map((e) => {
    if (diners.get(e.dinerNo)!.kind !== e.kind) throw refuse('pos: card kind differs', `Diner ${e.dinerNo}'s card does not match their discount.`);
    const h = assertFieldRules(POS_STATUTORY_HOLDER_RULES, { holderName: e.holderName ?? '', idNumber: e.idNumber ?? '' });
    return { dinerNo: e.dinerNo, kind: e.kind, holderName: h.holderName!, idNumber: h.idNumber! };
  });

  // 5. Write: the receipt first, then its children, then the session.
  const storeCode = await posV2Repo.getStoreCode(tx, actor.orgId, storeId);
  const printed = `${storeCode}-${pad(terminalNo, 2)}-${pad(terminalSeq, 6)}`;
  const recordIds = new Map<number, string>();
  for (const h of holders) {
    const g = diners.get(h.dinerNo)!;
    const rec = await statutoryDiscountsRepo.create(tx, {
      orgId: actor.orgId, storeId, businessDate: rules!.businessDate, invoiceNumber: printed, kind: h.kind, idNumber: h.idNumber, holderName: h.holderName,
      grossAmount: fromCentavos(g.gross), discountAmount: fromCentavos(g.discount), source: 'pos', recordedBy: actor.personId,
    });
    recordIds.set(h.dinerNo, rec.id);
  }
  // T-575 (row 462): a card already used at this store in the window is flagged for a manager below (never refused). Our own rows are left out by the printed number.
  const earlierReceipts = new Set<string>();
  let repeatedCard = false;
  for (const h of holders) {
    const uses = await earlierUsesOfCard(tx, actor.orgId, storeId, h.idNumber, rules!.businessDate, printed);
    if (uses.length > 0) repeatedCard = true;
    for (const u of uses) if (u.receiptId) earlierReceipts.add(u.receiptId);
  }
  try {
    await posV2Repo.insertReceipt(tx, {
      id: receiptId, orgId: actor.orgId, storeId, terminalId: terminal.id, terminalSeq, tableSessionId: sessionId, cashierId: actor.personId, issuedAtDevice: issuedAt,
      subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, deviceTotal, offline,
    });
  } catch (err) {
    if (isUniqueViolation(err, 'pos_sales_receipts_terminal_seq_unique')) throw refuse('pos: receipt number reused (race)', 'That receipt number is already used on this till.');
    throw err;
  }
  const receiptLineIds = new Map<string, string>();
  const lineRows = lines.map((l, i) => {
    const p = priced.lines[i]!;
    const id = globalThis.crypto.randomUUID();
    receiptLineIds.set(l.id, id);
    return { id, orgId: actor.orgId, receiptId, lineNo: i + 1, sessionLineId: l.id, kind: l.kind, name: l.name, qty: l.qty, unitPrice: money(l.unitPrice), optionValueIds: l.optionValueIds, gross: p.gross, discountTotal: p.discountTotal, net: p.net };
  });
  await posV2Repo.insertReceiptLines(tx, lineRows);
  const presetNames = new Map<string, string>();
  const discountRows: posV2Repo.NewReceiptLineDiscount[] = [];
  for (const [i, l] of lines.entries()) {
    for (const d of l.discounts) {
      const pd = priced.lines[i]!.discounts.find((x) => x.discountId === d.id)!;
      if (toCentavos(pd.discountAmount) <= 0n) continue; // a discount that rounds to nothing leaves no row (the table forbids a zero amount)
      let label = d.kind === 'senior' ? 'Senior' : d.kind === 'pwd' ? 'PWD' : 'Discount';
      if (d.kind === 'preset') {
        if (!presetNames.has(d.presetId!)) presetNames.set(d.presetId!, (await posV2Repo.getPreset(tx, actor.orgId, storeId, d.presetId!))!.name);
        label = presetNames.get(d.presetId!)!;
      }
      discountRows.push({
        orgId: actor.orgId, receiptLineId: receiptLineIds.get(l.id)!, kind: d.kind, presetId: d.presetId, label, valueType: d.valueType, value: money(d.value), qty: d.qty,
        dinerNo: d.dinerNo, vatRemoved: pd.vatRemoved, discountAmount: pd.discountAmount, statutoryRecordId: d.dinerNo === null ? null : recordIds.get(d.dinerNo) ?? null,
      });
    }
  }
  await posV2Repo.insertReceiptLineDiscounts(tx, discountRows);
  await posV2Repo.insertReceiptPayments(
    tx,
    rows.map((r, i) => ({ orgId: actor.orgId, receiptId, tenderId: r.tenderId, amount: r.amount, changeGiven: i === changeRow ? change : money('0'), referenceNo: r.referenceNo, toCheck: r.toCheck })),
  );
  await posV2Repo.markSessionPaid(tx, actor.orgId, storeId, sessionId);

  if (!matches) {
    await audit(tx, actor, 'pos.sale_recompute_mismatch', {
      storeId, entityId: receiptId, pairingId, at: issuedAt,
      before: { subtotal: dev.subtotal, discountTotal: dev.discountTotal, total: dev.total, lines: (dev.lines ?? []).slice(0, MISMATCH_LINE_CAP).map((l) => ({ lineId: l.lineId, net: l.net })), truncated: (dev.lines ?? []).length > MISMATCH_LINE_CAP },
      after: {
        subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total,
        lines: priced.lines.slice(0, MISMATCH_LINE_CAP).map((l, i) => ({ lineId: l.lineId, qty: lines[i]!.qty, unitPrice: lines[i]!.unitPrice, net: l.net })),
        truncated: priced.lines.length > MISMATCH_LINE_CAP,
      },
    });
  }
  if (compare(gap, money('0')) > 0) {
    const tolerance = rules!.rules.saleVarianceToleranceCentavos;
    const o = {
      storeId, entityId: receiptId, pairingId, at: issuedAt,
      after: {
        gap: gap.toString(), tolerance: fromCentavos(tolerance).toString(), deviceTotal: deviceTotal.toString(), serverTotal: priced.total,
        payments: rows.map((r) => ({ tenderId: r.tenderId, amount: r.amount.toString() })),
      },
    };
    // Literal action names so the build's audit scan sees both.
    if (toCentavos(gap) > tolerance) await audit(tx, actor, 'pos.sale_payment_shortfall', o);
    else await audit(tx, actor, 'pos.sale_payment_variance', o);
  }
  // The manager's trail: this receipt and the earlier ones. No card number and no name (the earlier receipts lead to them). shortcut: at most 50 earlier receipts are listed.
  if (repeatedCard) await audit(tx, actor, 'pos.senior_id_repeat', { storeId, entityId: receiptId, pairingId, at: issuedAt, after: { receiptId, earlierReceiptIds: [...earlierReceipts].slice(0, 50) } });
  await audit(tx, actor, 'pos.sale_completed', {
    storeId, entityId: receiptId, pairingId, at: issuedAt,
    after: { sessionId, receiptNo: printed, offline, subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, payments: rows.length, statutoryDiners: holders.length },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, storeId);
  return { wrote: true, receiptId };
}

// ---------------------------------------------------------------------------------------------------------------------
// R1 currentBusinessDate, R10 reads
// ---------------------------------------------------------------------------------------------------------------------
/** The business date of the open Z window (T-531 reuses it). Before the first Z it needs the business-day start hour, through the injected reader. */
export async function currentBusinessDate(tx: Tx, storeId: string, deps?: PosDeps): Promise<string> {
  const orgId = await posV2Repo.getStoreOrgId(tx, storeId);
  if (!orgId) throw gone(`pos: store ${storeId} not found`, 'store');
  return businessDateOf(tx, orgId, storeId, deps);
}

export async function getSessionBill(tx: Tx, actor: Actor, input: { storeId: string; sessionId: string }, deps?: PosDeps) {
  await requireStoreScope(tx, actor, input.storeId);
  const session = await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, uuidInput(input.sessionId, 'The table id'));
  if (!session) throw gone('pos: table session not found', 'table');
  const lines = await loadLiveLines(tx, actor.orgId, input.storeId, session.id);
  const { priced } = await priceFromDb(tx, actor, input.storeId, lines, deps);
  const store = await posV2Repo.getPosStore(tx, actor.orgId, input.storeId);
  return {
    stateVersion: store?.stateVersion ?? 0,
    session: { id: session.id, mode: session.mode, standId: session.standId, status: session.status, headsCashier: session.headsCashier, headsServer: session.headsServer },
    lines: lines.map((l) => ({
      id: l.id, kind: l.kind, name: l.name, qty: l.qty, unitPrice: l.unitPrice, kitchenStatus: l.kitchenStatus, bundleHeads: l.bundleHeads,
      menuItemId: l.menuItemId, note: l.note, addedAtDevice: l.addedAtDevice,
      discounts: l.discounts.map((d) => ({ id: d.id, kind: d.kind, valueType: d.valueType, value: money(d.value), qty: d.qty, dinerNo: d.dinerNo, presetId: d.presetId })),
    })),
    pricing: priced,
  };
}

async function stateVersionOf(tx: Tx, actor: Actor, storeId: string): Promise<number> {
  return (await posV2Repo.getPosStore(tx, actor.orgId, storeId))?.stateVersion ?? 0;
}

export async function listOpenStands(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const rows = await posV2Repo.listOpenSessionsWithStand(tx, actor.orgId, input.storeId);
  return {
    stateVersion: await stateVersionOf(tx, actor, input.storeId),
    stands: rows.map((r) => ({ sessionId: r.session.id, standId: r.session.standId, standNumber: r.standNumber, mode: r.session.mode, headsCashier: r.session.headsCashier, headsServer: r.session.headsServer, openedAtDevice: r.session.openedAtDevice })),
  };
}

const ticket = (r: Awaited<ReturnType<typeof posV2Repo.listQueuedLines>>[number]) => ({
  lineId: r.line.id, sessionId: r.line.sessionId, standNumber: r.standNumber, sessionMode: r.sessionMode, kind: r.line.kind, name: r.line.name, qty: r.line.qty,
  note: r.line.note, stationId: r.line.kitchenStationId, addedAtDevice: r.line.addedAtDevice, askedBy: r.askedBy,
});

/**
 * T-529: the open dine-in tables that hold a package (the refill stand picker and the heads list), one row per table, by stand number.
 * Needs `request_pos_refill` OR `confirm_pos_heads` at the store: a phone that may do either needs to see the tables.
 */
export async function listRefillableTables(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const at = { storeId: input.storeId };
  if (!(await can(tx, actor, 'request_pos_refill', at)) && !(await can(tx, actor, 'confirm_pos_heads', at))) await authorize(tx, actor, 'request_pos_refill', at);
  // One row per table. A table may hold more than one package variant: `packageVariantIds` has every one (first line first), `packageVariantId` is the first.
  const byTable = new Map<string, { sessionId: string; standNumber: number; packageVariantId: string; packageVariantIds: string[]; headsCashier: number; headsServer: number | null }>();
  for (const r of await posV2Repo.listRefillableTables(tx, actor.orgId, input.storeId)) {
    if (r.packageVariantId === null) continue;
    const have = byTable.get(r.sessionId);
    if (!have) byTable.set(r.sessionId, { sessionId: r.sessionId, standNumber: r.standNumber, packageVariantId: r.packageVariantId, packageVariantIds: [r.packageVariantId], headsCashier: r.headsCashier, headsServer: r.headsServer });
    else if (!have.packageVariantIds.includes(r.packageVariantId)) have.packageVariantIds.push(r.packageVariantId);
  }
  return { tables: [...byTable.values()] };
}

export async function listKitchenQueue(tx: Tx, actor: Actor, input: { storeId: string; stationId?: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const rows = await posV2Repo.listQueuedLines(tx, actor.orgId, input.storeId, input.stationId ? { stationId: uuidInput(input.stationId, 'The station') } : {});
  return { stateVersion: await stateVersionOf(tx, actor, input.storeId), tickets: rows.map(ticket) };
}

export async function listRefillQueue(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const rows = await posV2Repo.listQueuedLines(tx, actor.orgId, input.storeId, { refillsOnly: true });
  return { stateVersion: await stateVersionOf(tx, actor, input.storeId), tickets: rows.map(ticket) };
}

/** The sales receipts of the open Z window (before the first Z, all of them), newest first. */
export async function listTodaysSalesReceipts(tx: Tx, actor: Actor, input: { storeId: string }) {
  await requireStoreScope(tx, actor, input.storeId);
  const since = await posV2Repo.lastDayCloseEnd(tx, actor.orgId, input.storeId);
  const rows = await posV2Repo.listReceiptsSince(tx, actor.orgId, input.storeId, since);
  return {
    stateVersion: await stateVersionOf(tx, actor, input.storeId),
    receipts: rows.map((r) => ({ receiptId: r.id, sessionId: r.tableSessionId, terminalId: r.terminalId, terminalSeq: r.terminalSeq, issuedAtDevice: r.issuedAtDevice, subtotal: r.subtotal, discountTotal: r.discountTotal, total: r.total, offline: r.offline })),
  };
}
