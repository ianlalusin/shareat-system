'use server';

/**
 * Server actions for the SC/PWD statutory register — docs/tasks/137-statutory-discount-logbook.md.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. **No rule is re-implemented here.**
 * `recordStatutoryDiscount` / `voidStatutoryDiscount` own the authorisation, and migration 0065's
 * constraints own the rest.
 *
 * ⭐ **The actor comes from `requireActor()`, never from the form** (T-138, bible §7.1) — which is
 * what makes `void_statutory_discount` being a different capability from `record_statutory_discount`
 * mean anything at all.
 */
import { recordStatutoryDiscount, voidStatutoryDiscount } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';
import { requireActor } from '../../lib/session';
import { redirectWithFlash, type Nav } from '@/lib/flash';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // ⭐ Constraint names are the truth but they are not English. Translate the three a person can
  // actually hit; everything else surfaces verbatim rather than being swallowed.
  if (raw.includes('statutory_discount_records_live_invoice_key')) {
    return 'That invoice already has a live record for this store and date. One discount only — a PWD who is also a senior claims one 20%, not both. Void the existing record if it is wrong.';
  }
  if (raw.includes('statutory_discount_records_discount_within_gross_check')) {
    return 'The discount cannot be more than the gross amount.';
  }
  if (raw.includes('statutory_discount_records_amounts_positive_check')) {
    return 'Both the gross amount and the discount must be greater than zero.';
  }
  if (raw.includes('statutory_discount_records_identity_present_check')) {
    return 'Name, ID number and invoice number are all required — the record satisfies nothing without them.';
  }
  return sharedErrorMessage(err);
}

/** Where to land: the store and date range the person was looking at, each only if it is set. */
function navOf(fd: FormData): Nav {
  const nav: Nav = {};
  const store = str(fd, 'storeId');
  const from = str(fd, 'from');
  const to = str(fd, 'to');
  if (store) nav.store = store;
  if (from) nav.from = from;
  if (to) nav.to = to;
  return nav;
}

export async function recordStatutoryDiscountAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/statutory-discounts');
  const storeId = str(formData, 'storeId');
  const kind = str(formData, 'kind');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      recordStatutoryDiscount(tx, actor, {
        storeId,
        businessDate: str(formData, 'businessDate'),
        invoiceNumber: str(formData, 'invoiceNumber'),
        kind: kind === 'pwd' ? 'pwd' : 'senior',
        idNumber: str(formData, 'idNumber'),
        holderName: str(formData, 'holderName'),
        // T-371 R6 — a blank goes to the domain AS a blank, which refuses it in words; never a guessed '0'.
        grossAmount: str(formData, 'grossAmount'),
        discountAmount: str(formData, 'discountAmount'),
        signatory: str(formData, 'signatory') || null,
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/statutory-discounts', navOf(formData), { error: errorMessage(err) });
  }
  return await redirectWithFlash('/statutory-discounts', navOf(formData));
}

export async function voidStatutoryDiscountAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/statutory-discounts');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      voidStatutoryDiscount(tx, actor, {
        id: str(formData, 'id'),
        reason: str(formData, 'voidReason'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/statutory-discounts', navOf(formData), { error: errorMessage(err) });
  }
  return await redirectWithFlash('/statutory-discounts', navOf(formData), { ok: 'Statutory discount voided.', stamp: 'VOID' });
}
