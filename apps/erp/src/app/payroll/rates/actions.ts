'use server';

/**
 * Server actions for `/payroll/rates`. T-190.
 *
 * ⛔ No rule is re-implemented here. Every domain function authorizes `manage_payroll_rates` (admin only) as its first statement, owns
 * the refusal sentences and writes the audit row; these adapters read the form, call it and show the sentence that comes back.
 */
import { revalidatePath } from 'next/cache';
import {
  addMinimumWage,
  addStatutoryRate,
  addWithholdingBracketSet,
  confirmMinimumWage,
  confirmStatutoryRate,
  confirmWithholdingBracketSet,
  discardMinimumWage,
  discardStatutoryRate,
  discardWithholdingBracketSet,
  saveStatutoryEmployer,
} from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { withOrgPrincipal } from './lib';

const PAGE = '/payroll/rates';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
const blank = (v: string): string | null => (v === '' ? null : v);

export async function addStatutoryRateAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      addStatutoryRate(tx, actor, {
        agency: str(fd, 'agency') as 'sss' | 'philhealth' | 'pagibig',
        effectiveFrom: str(fd, 'effectiveFrom'),
        eeRate: str(fd, 'eeRate'),
        erRate: str(fd, 'erRate'),
        baseKind: str(fd, 'baseKind') as 'gross' | 'basic',
        floor: blank(str(fd, 'floor')),
        ceiling: blank(str(fd, 'ceiling')),
        step: blank(str(fd, 'step')),
        lowThreshold: blank(str(fd, 'lowThreshold')),
        lowEeRate: blank(str(fd, 'lowEeRate')),
        ecThreshold: blank(str(fd, 'ecThreshold')),
        ecLow: blank(str(fd, 'ecLow')),
        ecHigh: blank(str(fd, 'ecHigh')),
        sourceRef: str(fd, 'sourceRef'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Rate saved. It is NOT used by a payroll run until it is approved.' });
}

export async function confirmStatutoryRateAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => confirmStatutoryRate(tx, actor, { id: str(fd, 'id') }));
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Rate approved. An approved rate can never be edited; a correction is a new row with a later date.' });
}

export async function discardStatutoryRateAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => discardStatutoryRate(tx, actor, { id: str(fd, 'id') }));
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Rate discarded.' });
}

/** Rows arrive one per line as "over, base tax, rate", e.g. `10417, 0, 0.15`. */
function parseBracketLines(text: string): { over: string; baseTax: string; rate: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const [over = '', baseTax = '', rate = ''] = l.split(',').map((x) => x.trim());
      return { over, baseTax, rate };
    });
}

export async function addWithholdingBracketSetAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      addWithholdingBracketSet(tx, actor, {
        frequency: str(fd, 'frequency') as 'monthly' | 'semi_monthly' | 'weekly',
        effectiveFrom: str(fd, 'effectiveFrom'),
        rows: parseBracketLines(str(fd, 'rows')),
        sourceRef: str(fd, 'sourceRef'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Withholding table saved. It is NOT used by a payroll run until it is approved.' });
}

export async function confirmWithholdingBracketSetAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      confirmWithholdingBracketSet(tx, actor, {
        frequency: str(fd, 'frequency') as 'monthly' | 'semi_monthly' | 'weekly',
        effectiveFrom: str(fd, 'effectiveFrom'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Withholding table approved.' });
}

export async function addMinimumWageAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      addMinimumWage(tx, actor, {
        storeId: str(fd, 'storeId'),
        effectiveFrom: str(fd, 'effectiveFrom'),
        dailyRate: str(fd, 'dailyRate'),
        wageOrderRef: str(fd, 'wageOrderRef'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Minimum wage saved. It is NOT used by a payroll run until it is approved.' });
}

export async function confirmMinimumWageAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => confirmMinimumWage(tx, actor, { id: str(fd, 'id') }));
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Minimum wage approved.' });
}

export async function discardWithholdingBracketSetAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      discardWithholdingBracketSet(tx, actor, {
        frequency: str(fd, 'frequency') as 'monthly' | 'semi_monthly' | 'weekly',
        effectiveFrom: str(fd, 'effectiveFrom'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Withholding table discarded.' });
}

export async function discardMinimumWageAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => discardMinimumWage(tx, actor, { id: str(fd, 'id') }));
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Minimum wage discarded.' });
}

/** T-193 S6: the employer number and due day for one agency. The domain authorizes `manage_payroll_rates`, judges the figures and audits. */
export async function saveStatutoryEmployerAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PAGE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      saveStatutoryEmployer(tx, actor, { agency: str(fd, 'agency'), employerNo: str(fd, 'employerNo'), dueDay: str(fd, 'dueDay') }),
    );
  } catch (err) {
    return await redirectWithFlash(PAGE, {}, { error: errorMessage(err) });
  }
  revalidatePath(PAGE);
  return await redirectWithFlash(PAGE, {}, { ok: 'Employer number and due day saved.' });
}
