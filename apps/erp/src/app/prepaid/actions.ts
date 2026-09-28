'use server';

/**
 * Server actions for the prepaid screens. T-125.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ **The admin-only rule is NOT
 * enforced here** — every service calls `authorize()` itself. A gate in a server action protects
 * one caller; a gate in the domain protects every caller there will ever be.
 */
import { redirect } from 'next/navigation';
import {
  amortisePrepaidItem,
  confirmPrepaidTerm,
  createPrepaidItem,
  reverseAmortisation,
  writeOffPrepaidItem,
} from '@shareat/domain';
import type { PrepaidCategory } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(`${path}?${q}`);
}

export async function createPrepaidItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const storeId = str(formData, 'storeId');
    if (!storeId) throw new Error('Choose a store.');
    // T-351 / DEF-481 — the raw string, unparsed: `createPrepaidItem` parses it AFTER
    // `authorize()`, in the domain (`whole-number-input.ts`'s `parseWholeNumberInput`).
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createPrepaidItem(tx, actor, {
        storeId,
        name: str(formData, 'name'),
        category: str(formData, 'category') as PrepaidCategory,
        coverageStartDate: str(formData, 'coverageStartDate'),
        coverageMonths: str(formData, 'coverageMonths'),
        totalCost: str(formData, 'totalCost'),
        notes: str(formData, 'notes') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    back('/prepaid', { error: errorMessage(err) });
  }
  back(`/prepaid/${id}`, {
    ok: 'Recorded. Release the months it covers when you are ready — running it is safe to repeat.',
  });
}

export async function amortiseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'prepaidItemId');
  let summary = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      amortisePrepaidItem(tx, actor, {
        prepaidItemId: id,
        asOfPeriod: str(formData, 'asOfPeriod'),
      }),
    );
    // ⭐ Says what it DID, including nothing. "Run" with no feedback is how a stopped scheduler
    // goes unnoticed for two months — which is literally DEF-044.
    summary =
      result.posted.length === 0
        ? 'Nothing to release — every month up to that period is already posted.'
        : `Released ${result.posted.length} month${result.posted.length === 1 ? '' : 's'}: ${result.posted.join(', ')}.` +
          (result.skipped.length > 0 ? ` ${result.skipped.length} already posted.` : '');
  } catch (err) {
    back(`/prepaid/${id}`, { error: errorMessage(err) });
  }
  back(`/prepaid/${id}`, { ok: summary });
}

export async function confirmTermAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'prepaidItemId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      confirmPrepaidTerm(tx, actor, {
        prepaidItemId: id,
        coverageMonths: str(formData, 'coverageMonths'),
        coverageStartDate: str(formData, 'coverageStartDate'),
      }),
    );
  } catch (err) {
    back(`/prepaid/${id}`, { error: errorMessage(err) });
  }
  back(`/prepaid/${id}`, { ok: 'Term confirmed — this item no longer needs review.' });
}

export async function reverseMonthAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'prepaidItemId');
  const period = str(formData, 'period');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this month is being reversed.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      reverseAmortisation(tx, actor, { prepaidItemId: id, period, reason }),
    );
  } catch (err) {
    back(`/prepaid/${id}`, { error: errorMessage(err) });
  }
  back(`/prepaid/${id}`, {
    ok: `${period} reversed. Run the release again to post a corrected month.`,
  });
}

export async function writeOffAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'prepaidItemId');
  let summary = '';
  const reason = str(formData, 'reason');
  const refundAmount = str(formData, 'refundAmount');
  const refundAccountCode = str(formData, 'refundAccountCode');
  const writtenOffOn = str(formData, 'writtenOffOn');
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      writeOffPrepaidItem(tx, actor, {
        prepaidItemId: id,
        writtenOffOn,
        reason,
        // T-343 S5.5p / DEF-460 — was `refund && Number(refund) > 0`. `Number('1,000')` is `NaN`, so
        // a comma-typed refund was silently DROPPED rather than reaching `writeOffPrepaidItem`'s own
        // `parseMoneyInput`, and the write-off proceeded as if no refund had been typed at all — the
        // whole remaining balance expensed. Blank stays omitted (the domain defaults to '0');
        // anything else, '0' included, is left for `writeOffPrepaidItem` to accept or refuse with a
        // readable sentence — same fix shape as `customers/actions.ts`'s `creditApplied`.
        //
        // ⚠️ T-343 S5.5u item 1 (DEF-473) — each field is sent on its OWN non-empty text now, not
        // both inside one `refund ?` spread: that used to drop `refundAccountCode` too whenever the
        // amount box was blank, so a picked account with no amount silently vanished along with it.
        // The domain now refuses that combination by name instead of silently discarding it.
        ...(refundAmount ? { refundAmount } : {}),
        ...(refundAccountCode ? { refundAccountCode } : {}),
      }),
    );
    summary =
      `Written off. ₱${result.expensed} recognised as expense` +
      (Number(result.refunded) > 0 ? `, ₱${result.refunded} refunded to the books.` : '.');
  } catch (err) {
    // T-343 S5.5u item 3 (DEF-473) — keeps what was typed after a refusal, the fixed-assets/[id]
    // precedent (`sp.reason ?? ''`); omitted keys just mean the box was already blank.
    // S5.5u Amendment A1 item 1 — `writtenOffOn` too: a back-dated write-off resubmitted after a
    // refusal must not silently revert to today.
    back(`/prepaid/${id}`, {
      error: errorMessage(err),
      ...(reason ? { reason } : {}),
      ...(refundAmount ? { refundAmount } : {}),
      ...(refundAccountCode ? { refundAccountCode } : {}),
      ...(writtenOffOn ? { writtenOffOn } : {}),
    });
  }
  back(`/prepaid/${id}`, { ok: summary });
}
