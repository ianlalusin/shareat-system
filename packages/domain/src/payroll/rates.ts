/**
 * Managing the statutory tables - T-190. `docs/tasks/190-payroll-statutory.md` ("Rates", "Lookups, refusals, immutability").
 *
 * Everything here needs `manage_payroll_rates` (org scope, admin only: "the accountant" is whoever Ian gives it to) and writes an
 * `audit_log` row in the same transaction. Rows are IMMUTABLE once confirmed (migration 0206): there is no edit. A correction is a new
 * row with a later `effective_from`; only a row that was never confirmed and never used can be deleted.
 */
import { auditLogRepo, statutoryRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { parseDecimalInput } from '../shared/money-input';
import { gone, refuse } from '../shared/refusal';

const CAPABILITY = 'manage_payroll_rates' as const;
const AGENCIES = ['sss', 'philhealth', 'pagibig'] as const;
const FREQUENCIES = ['monthly', 'semi_monthly', 'weekly'] as const;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(fn: string, v: string, what: string): void {
  if (!DATE_SHAPE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw refuse(`${fn}: ${what} "${v}" is not a date.`, `${what} must be a date, like 2026-07-01.`);
  }
}

function run<T>(tx: Tx | null, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : transaction(fn);
}

export interface AddStatutoryRateInput {
  agency: (typeof AGENCIES)[number];
  /** Must be the 1st of a month: a contribution table takes effect only at a month's start. */
  effectiveFrom: string;
  eeRate: string;
  erRate: string;
  baseKind: 'gross' | 'basic';
  floor?: string | null;
  ceiling?: string | null;
  step?: string | null;
  lowThreshold?: string | null;
  lowEeRate?: string | null;
  ecThreshold?: string | null;
  ecLow?: string | null;
  ecHigh?: string | null;
  sourceRef: string;
}

/** Adds an UNCONFIRMED contribution row. It is not used by a POST until `confirmStatutoryRate`. */
export function addStatutoryRate(tx: Tx | null, actor: Actor, input: AddStatutoryRateInput): Promise<{ id: string }> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    if (!AGENCIES.includes(input.agency)) {
      throw refuse(`addStatutoryRate: unknown agency ${input.agency}`, 'The agency must be SSS, PhilHealth or Pag-IBIG.');
    }
    assertDate('addStatutoryRate', input.effectiveFrom, 'The effective date');
    if (!input.effectiveFrom.endsWith('-01')) {
      throw refuse(
        `addStatutoryRate: effective_from ${input.effectiveFrom} is not the 1st of a month`,
        'A contribution table takes effect on the 1st of a month. Pick the first day of the month.',
      );
    }
    if (!input.sourceRef.trim()) {
      throw refuse('addStatutoryRate: source_ref is blank', 'Say where this rate comes from (the circular or law), so it can be checked.');
    }
    const money = (v: string | null | undefined, label: string) =>
      parseDecimalInput(v, '14,2', `addStatutoryRate: ${label}`, label, { blank: 'null' });
    const rate = (v: string | null | undefined, label: string) =>
      parseDecimalInput(v, '14,4', `addStatutoryRate: ${label}`, label, { blank: 'null' });
    const row = await statutoryRepo.insertRate(trx, {
      orgId: actor.orgId,
      agency: input.agency,
      effectiveFrom: input.effectiveFrom,
      baseKind: input.baseKind,
      sourceRef: input.sourceRef.trim(),
      eeRate: parseDecimalInput(input.eeRate, '14,4', 'addStatutoryRate: the employee rate', 'The employee rate'),
      erRate: parseDecimalInput(input.erRate, '14,4', 'addStatutoryRate: the employer rate', 'The employer rate'),
      floor: money(input.floor, 'The floor'),
      ceiling: money(input.ceiling, 'The ceiling'),
      step: money(input.step, 'The step'),
      lowThreshold: money(input.lowThreshold, 'The low-band threshold'),
      lowEeRate: rate(input.lowEeRate, 'The low-band employee rate'),
      ecThreshold: money(input.ecThreshold, 'The EC threshold'),
      ecLow: money(input.ecLow, 'The lower EC amount'),
      ecHigh: money(input.ecHigh, 'The higher EC amount'),
    });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: row.id,
      before: null,
      after: { table: 'statutory_rates', event: 'add', agency: input.agency, effectiveFrom: input.effectiveFrom, eeRate: input.eeRate, erRate: input.erRate, baseKind: input.baseKind, sourceRef: input.sourceRef },
      source: 'web',
    });
    return row;
  });
}

/** The first confirmation of a row. A second one is refused (by the database too). */
export function confirmStatutoryRate(tx: Tx | null, actor: Actor, input: { id: string }): Promise<void> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    const row = await statutoryRepo.getRate(trx, actor.orgId, input.id);
    if (!row) throw gone('confirmStatutoryRate: no such rate row', 'That rate row');
    if (row.confirmedAt) {
      throw refuse('confirmStatutoryRate: already confirmed', 'That rate is already confirmed. A confirmed rate cannot be changed; add a new row with a later date.');
    }
    if (!(await statutoryRepo.confirmRate(trx, actor.orgId, input.id, actor.personId))) {
      throw refuse('confirmStatutoryRate: lost the race', 'Someone else confirmed that rate first.');
    }
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: input.id,
      before: { confirmed: false },
      after: { table: 'statutory_rates', event: 'confirm', agency: row.agency, effectiveFrom: row.effectiveFrom },
      source: 'web',
    });
  });
}

/** Discards (removes) a row that was never confirmed. A confirmed row, or one a payslip used, cannot be discarded. */
export function discardStatutoryRate(tx: Tx | null, actor: Actor, input: { id: string }): Promise<void> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    const row = await statutoryRepo.getRate(trx, actor.orgId, input.id);
    if (!row) throw gone('discardStatutoryRate: no such rate row', 'That rate row');
    if (row.confirmedAt) {
      throw refuse('discardStatutoryRate: row is confirmed', 'A confirmed rate cannot be discarded. Add a new row with a later date instead.');
    }
    if (!(await statutoryRepo.deleteUnconfirmedRate(trx, actor.orgId, input.id))) {
      throw refuse('discardStatutoryRate: row not deletable', 'That rate cannot be discarded.');
    }
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: input.id,
      before: { agency: row.agency, effectiveFrom: row.effectiveFrom },
      after: { table: 'statutory_rates', event: 'discard' },
      source: 'web',
    });
  });
}

/**
 * Adds an UNCONFIRMED withholding bracket set (every row shares one `effectiveFrom` and one frequency).
 * Returns the ids in the order given.
 */
export function addWithholdingBracketSet(
  tx: Tx | null,
  actor: Actor,
  input: {
    frequency: (typeof FREQUENCIES)[number];
    effectiveFrom: string;
    rows: { over: string; baseTax: string; rate: string }[];
    sourceRef: string;
  },
): Promise<{ ids: string[] }> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    if (!FREQUENCIES.includes(input.frequency)) {
      throw refuse(`addWithholdingBracketSet: unknown frequency ${input.frequency}`, 'The pay frequency must be monthly, semi-monthly or weekly.');
    }
    assertDate('addWithholdingBracketSet', input.effectiveFrom, 'The effective date');
    if (input.rows.length === 0 || !input.sourceRef.trim()) {
      throw refuse('addWithholdingBracketSet: no rows or no source', 'Give the bracket rows and say where the table comes from.');
    }
    const parsed = input.rows.map((r) => ({
      over: parseDecimalInput(r.over, '14,2', 'addWithholdingBracketSet: over', 'The "over" amount'),
      baseTax: parseDecimalInput(r.baseTax, '14,2', 'addWithholdingBracketSet: base tax', 'The base tax'),
      rate: parseDecimalInput(r.rate, '14,4', 'addWithholdingBracketSet: rate', 'The rate'),
    }));
    const ids = await statutoryRepo.insertBrackets(trx, actor.orgId, input.frequency, input.effectiveFrom, parsed, input.sourceRef.trim());
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: ids[0]!,
      before: null,
      after: { table: 'withholding_brackets', event: 'add', frequency: input.frequency, effectiveFrom: input.effectiveFrom, rows: input.rows.length, sourceRef: input.sourceRef },
      source: 'web',
    });
    return { ids };
  });
}

/** Confirms every row of a bracket set at once. */
export function confirmWithholdingBracketSet(
  tx: Tx | null,
  actor: Actor,
  input: { frequency: (typeof FREQUENCIES)[number]; effectiveFrom: string },
): Promise<{ confirmed: number }> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    const ids = await statutoryRepo.confirmBrackets(trx, actor.orgId, input.frequency, input.effectiveFrom, actor.personId);
    if (ids.length === 0) {
      throw refuse('confirmWithholdingBracketSet: nothing to confirm', 'There is no unconfirmed table for that frequency and date.');
    }
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: ids[0]!,
      before: { confirmed: false },
      after: { table: 'withholding_brackets', event: 'confirm', frequency: input.frequency, effectiveFrom: input.effectiveFrom, rows: ids.length },
      source: 'web',
    });
    return { confirmed: ids.length };
  });
}

/** Adds an UNCONFIRMED minimum-wage row for a store. */
export function addMinimumWage(
  tx: Tx | null,
  actor: Actor,
  input: { storeId: string; effectiveFrom: string; dailyRate: string; wageOrderRef: string },
): Promise<{ id: string }> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    assertDate('addMinimumWage', input.effectiveFrom, 'The effective date');
    if (!input.wageOrderRef.trim()) {
      throw refuse('addMinimumWage: wage order is blank', 'Say which wage order sets this rate, so it can be checked.');
    }
    const row = await statutoryRepo.insertMinimumWage(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      effectiveFrom: input.effectiveFrom,
      dailyRate: parseDecimalInput(input.dailyRate, '14,2', 'addMinimumWage: the daily rate', 'The minimum daily wage'),
      wageOrderRef: input.wageOrderRef.trim(),
    });
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: row.id,
      before: null,
      after: { table: 'minimum_wages', event: 'add', store: input.storeId, effectiveFrom: input.effectiveFrom, dailyRate: input.dailyRate, wageOrderRef: input.wageOrderRef },
      source: 'web',
    });
    return row;
  });
}

export function confirmMinimumWage(tx: Tx | null, actor: Actor, input: { id: string }): Promise<void> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, CAPABILITY);
    if (!(await statutoryRepo.confirmMinimumWage(trx, actor.orgId, input.id, actor.personId))) {
      throw refuse('confirmMinimumWage: nothing to confirm', 'That minimum wage does not exist or is already confirmed.');
    }
    await auditLogRepo.append(trx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'payroll_rate.change',
      storeId: null,
      entityId: input.id,
      before: { confirmed: false },
      after: { table: 'minimum_wages', event: 'confirm', confirmed: true },
      source: 'web',
    });
  });
}

/**
 * Sets a person's government numbers (blank clears one). `enrol_staff` at the person's store, as the staff page: the numbers are
 * personal data and also decide which agencies a payslip deducts. A wrong format is refused with a plain sentence.
 */
export function setGovernmentIds(
  tx: Tx | null,
  actor: Actor,
  input: { personId: string; storeId: string; sssNo?: string | null; philhealthNo?: string | null; pagibigNo?: string | null; tin?: string | null },
): Promise<void> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, 'enrol_staff', { storeId: input.storeId });
    const digits = (v: string | null | undefined, pattern: RegExp, label: string, shape: string): string | null => {
      const t = (v ?? '').replace(/[\s-]/g, '');
      if (t === '') return null;
      if (!pattern.test(t)) {
        throw refuse(`setGovernmentIds: ${label} "${v}" has the wrong shape`, `${label} must be ${shape}.`);
      }
      return t;
    };
    const ids = {
      sssNo: digits(input.sssNo, /^[0-9]{10}$/, 'The SSS number', '10 digits'),
      philhealthNo: digits(input.philhealthNo, /^[0-9]{12}$/, 'The PhilHealth number', '12 digits'),
      pagibigNo: digits(input.pagibigNo, /^[0-9]{12}$/, 'The Pag-IBIG number', '12 digits'),
      tin: digits(input.tin, /^[0-9]{9,12}$/, 'The TIN', '9 to 12 digits'),
    };
    // Numbers decide which agencies a payslip deducts: lock the person like a post does, so a run cannot read half a change.
    await statutoryRepo.lockPersons(trx, actor.orgId, [input.personId]);
    if (!(await statutoryRepo.setGovernmentIds(trx, actor.orgId, input.personId, ids))) {
      throw gone('setGovernmentIds: no such person', 'That person');
    }
  });
}

