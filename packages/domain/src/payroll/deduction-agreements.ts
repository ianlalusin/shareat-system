/**
 * Staff deduction agreements. T-519 S1, DEF-813. `docs/tasks/519-staff-deduction-agreements.md` (R1-R6).
 *
 * A staff charge (a till shortage, a transit discrepancy, an owner drawing moved onto pay...) stays a receivable on 1230 (R1). Payroll, the
 * 13th-month run and separation recover it ONLY under an ACTIVE agreement the employee signed after being told and explaining themselves
 * (Labor Code Art. 113; Omnibus Rules Book III Rule VIII s.14). Requested cash advances post to 1120 and are untouched (choice b).
 *
 * This file is a LEAF on purpose: `./index`, `./thirteenth-month`, `./separation` and `../owners` all import it, so it imports none of them.
 *
 * ## R3 - how much a run may recover
 * min( 20% (`deductionCapPercent`) of that run's gross , the sum of the active agreements' per-payroll limits , the agreed amount still unpaid ,
 * the person's live 1230 balance ). An agreement whose charge entry was reversed recovers nothing.
 * 13th month and separation pass no gross: the 20% weekly cap is for wages, so they recover the agreed unpaid amount only
 * (and `advanceToRecover` still caps it at that payout's gross).
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, deductionAgreementsRepo, filesRepo, type Tx } from '@shareat/db';
import { DEDUCTION_SOURCE_TYPES, type DeductionSourceType } from '@shareat/db/schema';
import { ZERO, add, compare, fromCentavos, money, subtract, toCentavos, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

/**
 * The share of wages (a PERCENT) a deduction may take, as of `onDate`. Art. 113: 20.
 *
 * Ian, standing rule 5 Nov: no business setting is hard-coded. This is the ONE place the cap lives, so it can move to a managed value without
 * touching a caller. T-511 S5c builds the generic `business_rule_values` table and `ruleValue(tx, orgId, key, onDate)` (migration 0235); once that is
 * on main, T-519 S2 replaces the body with `ruleValue(tx, orgId, 'payroll.deduction_cap_percent', onDate)` (default 20) and adds the screen. The key is not
 * added here.
 */
export async function deductionCapPercent(_tx: Tx, _orgId: string, _onDate: string): Promise<number> {
  return 20;
}

/** At most `percent` of the wages, floored to the centavo so the cap is never a fraction over. `percent` has at most 2 decimals. */
export function wageCap(runGross: Money, percent: number): Money {
  if (compare(runGross, ZERO) <= 0) return ZERO;
  return fromCentavos((toCentavos(runGross) * BigInt(Math.round(percent * 100))) / 10000n);
}

const minMoney = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);

/**
 * What the person's ACTIVE agreements let a payout recover now.
 * `runGross` is the gross of the payslip being built (the wage cap applies, as of `on`, the run's period end); `null` = no wage cap (13th month, separation).
 */
export async function agreedRecoverable(tx: Tx, orgId: string, personId: string, runGross: Money | null, on: string): Promise<Money> {
  const active = await deductionAgreementsRepo.listActiveForPerson(tx, orgId, personId);
  let unpaid = ZERO;
  let limits = ZERO;
  for (const a of active) {
    if (!a.chargeLive) continue; // the charge was reversed: it is no longer owed
    const left = subtract(money(a.amount), money(a.recovered));
    if (compare(left, ZERO) <= 0) continue;
    unpaid = add(unpaid, left);
    limits = add(limits, minMoney(money(a.perPayrollLimit), left));
  }
  // never more than the person still owes on 1230 (money paid back outside payroll, or a correction, lowers it)
  const owed = money(await deductionAgreementsRepo.balanceOn1230(tx, orgId, personId));
  const room = compare(owed, ZERO) > 0 ? owed : ZERO;
  if (runGross === null) return minMoney(unpaid, room);
  return minMoney(minMoney(minMoney(wageCap(runGross, await deductionCapPercent(tx, orgId, on)), limits), unpaid), room);
}

/**
 * R6: after a payout's journal entry is posted, spend `recovered` against the person's active agreements (oldest first), record how much each
 * covered, and complete any that are now paid in full. Same transaction as the posting.
 * `perRunLimit`: a PAYROLL run gives each agreement at most min(its room, its per-payroll limit); 13th month and separation pass false (agreed unpaid only). Refuses if the agreements no longer cover the figure
 * (another post got there first): the whole posting rolls back.
 */
export async function applyDeductionRecovery(tx: Tx, orgId: string, personId: string, entryId: string, recovered: Money, perRunLimit = false): Promise<void> {
  if (compare(recovered, ZERO) <= 0) return;
  const active = await deductionAgreementsRepo.listActiveForPerson(tx, orgId, personId, true);
  let left = recovered;
  for (const a of active) {
    if (compare(left, ZERO) <= 0) break;
    if (!a.chargeLive) continue;
    const room = subtract(money(a.amount), money(a.recovered));
    if (compare(room, ZERO) <= 0) continue;
    const take = minMoney(perRunLimit ? minMoney(room, money(a.perPayrollLimit)) : room, left);
    if (compare(take, ZERO) <= 0) continue;
    await deductionAgreementsRepo.insertRecovery(tx, { orgId, agreementId: a.id, journalEntryId: entryId, amount: take });
    left = subtract(left, take);
  }
  if (compare(left, ZERO) > 0) {
    throw refuse(
      'applyDeductionRecovery: the active agreements no longer cover the amount being recovered',
      'The signed agreements for this person changed while the payroll was being posted. Reload and post again.',
    );
  }
  await deductionAgreementsRepo.syncStatuses(tx, orgId, personId);
}

/** R6: a void reversed these payroll entries; reopen any agreement they had completed. Call AFTER the reversals. */
export async function reopenAfterVoid(tx: Tx, orgId: string, entryIds: string[]): Promise<void> {
  for (const personId of await deductionAgreementsRepo.personsRecoveredBy(tx, orgId, entryIds)) {
    await deductionAgreementsRepo.syncStatuses(tx, orgId, personId);
  }
}

/** A real calendar date, YYYY-MM-DD (month 1-12, day within that month, leap years included). */
function isoDate(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return days !== undefined && day >= 1 && day <= days;
}

export interface RecordDeductionAgreementInput {
  personId: string;
  storeId: string;
  sourceEntryId: string;
  amount: string;
  perPayrollLimit: string;
  noticeGivenAt: string;
  employeeExplanation: string;
  signedOn: string;
  /** The scan of the signed paper, uploaded first with purpose `staff_deduction_agreement` by this same person. */
  evidenceFileId: string;
}

/**
 * R2/R4: record that an employee signed an agreement to repay (part of) one charge from pay.
 * Needs `run_payroll` at the store (the capability that already governs payroll; no new one). Never by the charged person. The notice is
 * dated on or before the signing. The amount may not exceed what the charge still has unrecovered. One active agreement per charge.
 */
export async function recordDeductionAgreement(tx: Tx, actor: Actor, input: RecordDeductionAgreementInput): Promise<{ id: string }> {
  await authorize(tx, actor, 'run_payroll', { storeId: input.storeId });

  if (actor.personId === input.personId) {
    throw refuse(
      'recordDeductionAgreement: the recorder is the charged person',
      'You cannot record the agreement for a charge against yourself. Ask another payroll user to record it.',
    );
  }
  const amount = parseMoneyInput(input.amount, 'recordDeductionAgreement: the amount', 'The agreed amount');
  const limit = parseMoneyInput(input.perPayrollLimit, 'recordDeductionAgreement: the limit per payroll', 'The limit per payroll');
  if (compare(amount, ZERO) <= 0 || compare(limit, ZERO) <= 0) {
    throw refuse('recordDeductionAgreement: amount and limit must be above zero', 'The agreed amount and the limit per payroll must each be more than zero.');
  }
  if (!isoDate(input.noticeGivenAt) || !isoDate(input.signedOn)) {
    throw refuse('recordDeductionAgreement: bad date', 'Enter the notice date and the signing date as real dates.');
  }
  if (input.noticeGivenAt.localeCompare(input.signedOn) > 0) {
    throw refuse(
      'recordDeductionAgreement: notice after signing',
      'The notice must be given on or before the day the agreement is signed. The employee has to be told and given a chance to explain first.',
    );
  }
  const explanation = input.employeeExplanation.trim();
  if (!explanation) {
    throw refuse('recordDeductionAgreement: no explanation', 'Write down what the employee said when they were given the chance to explain (or "none given").');
  }

  const charge = await deductionAgreementsRepo.chargeOfEntry(tx, actor.orgId, input.sourceEntryId, input.personId);
  if (!charge || charge.entryStatus === 'draft' || !charge.live || compare(money(charge.amount), ZERO) <= 0) {
    throw refuse('recordDeductionAgreement: no posted charge for this person on that entry', 'That charge could not be found against this employee. Pick one from their list of charges.');
  }
  if (!(DEDUCTION_SOURCE_TYPES as readonly string[]).includes(charge.sourceType)) {
    throw refuse(`recordDeductionAgreement: ${charge.sourceType} is not a recoverable charge`, 'That entry is not a staff charge that can be recovered from pay.');
  }
  if (charge.storeId !== input.storeId) {
    throw refuse('recordDeductionAgreement: the charge belongs to another store', 'That charge was posted at a different store. Record the agreement at the store where the charge was made.');
  }
  const remaining = subtract(money(charge.amount), money(await deductionAgreementsRepo.recoveredOnCharge(tx, actor.orgId, input.sourceEntryId)));
  if (compare(amount, remaining) > 0) {
    throw refuse(
      'recordDeductionAgreement: amount above what the charge still has unrecovered',
      `The agreed amount cannot be more than the charge still has to recover, which is ${remaining}.`,
    );
  }
  const existing = (await deductionAgreementsRepo.listForPerson(tx, actor.orgId, input.personId)).find(
    (a) => a.sourceEntryId === input.sourceEntryId && a.status === 'active',
  );
  if (existing) {
    throw refuse('recordDeductionAgreement: an active agreement already covers this charge', 'There is already an active agreement for this charge. Cancel it first if it needs to change.');
  }

  const { id } = await deductionAgreementsRepo.insertAgreement(tx, {
    orgId: actor.orgId,
    personId: input.personId,
    storeId: input.storeId,
    sourceType: charge.sourceType as DeductionSourceType,
    sourceEntryId: input.sourceEntryId,
    amount,
    perPayrollLimit: limit,
    noticeGivenAt: input.noticeGivenAt,
    employeeExplanation: explanation,
    signedOn: input.signedOn,
    evidenceFileId: input.evidenceFileId,
    recordedBy: actor.personId,
  });
  // The scan must be this recorder's own fresh upload of the right purpose at this store; the claim also links it to the agreement.
  const claimed = await filesRepo.claimFile(tx, {
    orgId: actor.orgId,
    id: input.evidenceFileId,
    uploadedBy: actor.personId,
    purpose: 'staff_deduction_agreement',
    storeId: input.storeId,
    linkedTo: id,
  });
  if (!claimed) {
    throw refuse('recordDeductionAgreement: the scan is not claimable', 'The scan of the signed paper could not be attached. Upload it again, then record the agreement.');
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'staff_deduction_agreement.recorded',
    storeId: input.storeId,
    entityId: id,
    before: null,
    after: { amount: String(amount), perPayrollLimit: String(limit), sourceType: charge.sourceType, signedOn: input.signedOn },
    source: 'web',
  });
  return { id };
}

/** Cancels an ACTIVE agreement (the charge goes back to "waiting for a signed agreement"; what was already recovered stays recovered). */
export async function cancelDeductionAgreement(tx: Tx, actor: Actor, input: { agreementId: string; reason: string }): Promise<void> {
  const found = await deductionAgreementsRepo.getById(tx, actor.orgId, input.agreementId);
  if (!found) throw refuse('cancelDeductionAgreement: not found', 'That agreement could not be found.');
  await authorize(tx, actor, 'run_payroll', { storeId: found.storeId });
  const reason = input.reason.trim();
  if (!reason) throw refuse('cancelDeductionAgreement: no reason', 'Cancelling an agreement needs a reason.');
  if (found.status !== 'active') {
    throw refuse(`cancelDeductionAgreement: it is ${found.status}`, `That agreement is ${found.status}, so it cannot be cancelled.`);
  }
  const ok = await deductionAgreementsRepo.cancel(tx, actor.orgId, found.id, { cancelledBy: actor.personId, reason });
  if (!ok) throw refuse('cancelDeductionAgreement: changed meanwhile', 'That agreement was changed by someone else. Reload and check it.');
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'staff_deduction_agreement.cancelled',
    storeId: found.storeId,
    entityId: found.id,
    before: { status: 'active' },
    after: { status: 'cancelled', reason },
    source: 'web',
  });
}

/**
 * R5: an owner moving their own drawing onto their own pay IS their agreement. Writes the agreement row for `owner_pay_recovery`
 * (explanation "own request", no scan, notice and signing on the day) so payroll may recover it. Idempotent per charge entry.
 * Only the owners module calls this (NOT re-exported from the payroll barrel), and only when the actor and the person are the same.
 * It still checks the entry is that person's live 1230 charge and the amount fits what the charge has left.
 */
export async function recordOwnerSelfAgreement(
  tx: Tx,
  actor: Actor,
  input: { personId: string; storeId: string; sourceEntryId: string; amount: Money; on: string },
): Promise<void> {
  if (actor.personId !== input.personId) return;
  const already = (await deductionAgreementsRepo.listForPerson(tx, actor.orgId, input.personId)).some(
    (a) => a.sourceEntryId === input.sourceEntryId && a.status !== 'cancelled',
  );
  if (already) return;
  const charge = await deductionAgreementsRepo.chargeOfEntry(tx, actor.orgId, input.sourceEntryId, input.personId);
  if (!charge || !charge.live || charge.sourceType !== 'owner_pay_recovery' || compare(money(charge.amount), ZERO) <= 0) {
    throw refuse('recordOwnerSelfAgreement: no live owner-pay charge for this person on that entry', 'That entry is not a charge against you that can be recovered from your pay.');
  }
  const remaining = subtract(money(charge.amount), money(await deductionAgreementsRepo.recoveredOnCharge(tx, actor.orgId, input.sourceEntryId)));
  if (compare(input.amount, remaining) > 0) {
    throw refuse('recordOwnerSelfAgreement: amount above what the charge still has unrecovered', `The amount cannot be more than the charge still has to recover, which is ${remaining}.`);
  }
  const { id } = await deductionAgreementsRepo.insertAgreement(tx, {
    orgId: actor.orgId,
    personId: input.personId,
    storeId: input.storeId,
    sourceType: 'owner_pay_recovery',
    sourceEntryId: input.sourceEntryId,
    amount: input.amount,
    perPayrollLimit: input.amount,
    noticeGivenAt: input.on,
    employeeExplanation: 'own request',
    signedOn: input.on,
    evidenceFileId: null,
    recordedBy: actor.personId,
  });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'staff_deduction_agreement.recorded',
    storeId: input.storeId,
    entityId: id,
    before: null,
    after: { amount: String(input.amount), perPayrollLimit: String(input.amount), sourceType: 'owner_pay_recovery', signedOn: input.on },
    source: 'web',
  });
}
