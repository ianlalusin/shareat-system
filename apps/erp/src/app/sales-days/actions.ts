'use server';

/**
 * Server actions for the sales-day screens — docs/tasks/123-sales-day.md.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. **No business rule is
 * re-implemented here** — `createSalesDay` / `submitSalesDay` / `verifySalesDay` / `voidSalesDay`
 * own every invariant, including the create-block and its carve-outs.
 *
 * ⭐ **The actor comes from `requireActor()`, never from the form** (T-138, bible §7.1). Until
 * 2026-08-25 these actions read an `actingPersonId` the browser supplied, which meant
 * `verify_sales_day` being a different capability from `submit_sales_day` proved nothing — anyone
 * could claim to be anyone. **The segregation only became real when this line changed.**
 */
import {
  assertFieldRules, createSalesDay, editSalesDay, importSalesDay, postPosCorrection, recheckPosDay, recheckRecentDays, reimportSalesDay,
  setPlatformSales, submitSalesDay, verifySalesDay, voidSalesDay,
} from '@shareat/domain';
import { logger } from '@shareat/core/logger';
import { SALES_DAY_CORRECTION_RULES, SALES_DAY_CREATE_RULES, SALES_DAY_IMPORT_RULES, SALES_DAY_VOID_RULES } from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash, splitReturnTo, type Nav } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { PLATFORM_SALES_EDIT } from './typed-forms';
import { verifyAdminApproval } from '@shareat/auth';
import { assertApprovalStillRight, loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** T-371 R6: a money box is passed on as typed — a blank stays blank. The domain parses it and its
 *  COLUMN decides what a blank means (refused, or the default kept); the screen never guesses '0'. */
function amount(fd: FormData, key: string): string {
  return str(fd, key);
}

/** Only the FILTER state travels in the URL now. The org and the person come from the session,
 *  and a store here names which store a day belongs to — not who is acting. */
function carryNav(fd: FormData): Nav {
  const store = str(fd, 'storeId');
  return store ? { store } : {};
}

/**
 * The figures, channels and tenders a sales-day form carries, parsed ONCE for create and edit.
 *
 * Channel rows arrive as channel_<id> / nosales_<id> pairs and tenders as tender_<id> - the id is in
 * the field name, so no index bookkeeping is needed and a missing row is simply absent.
 */
function parseDayFigures(formData: FormData) {
  // ⭐ DEF-068 — where the online money landed. Same field-name-carries-the-id trick the channel
  // rows use, so a missing wallet is simply absent rather than an index to keep in step.
  const tenders: { moneyAccountId: string; amount: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('tender_') || typeof value !== 'string') continue;
    const amount = value.trim();
    // Every wallet the form offered is named. A blank is passed on as blank and the domain reads it as
    // "nothing landed here": no row on a create, and on an edit it clears that wallet's row (T-371 R6:
    // never a guessed '0'). A negative is passed on so the domain refuses it in words.
    tenders.push({ moneyAccountId: key.slice('tender_'.length), amount });
  }

  const channels: { channelId: string; amount: string; noSales: boolean }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('channel_') || typeof value !== 'string') continue;
    const channelId = key.slice('channel_'.length);
    const noSales = formData.get(`nosales_${channelId}`) === 'on';
    const raw = value.trim();
    // ⭐ Absent, zero, and "confirmed no sales" are three different things (T-134 B3's lesson,
    // and v1's own noSalesChannelIds). An untouched box writes no row at all.
    if (raw === '' && !noSales) continue;
    // A confirmed "no sales" IS a typed zero (the reporter's claim), not a guessed one.
    channels.push({ channelId, amount: noSales ? '0' : raw, noSales });
  }

  return {
    totalSales: amount(formData, 'totalSales'),
    unliSales: amount(formData, 'unliSales'),
    alaCarteSales: amount(formData, 'alaCarteSales'),
    seniorDiscount: amount(formData, 'seniorDiscount'),
    pwdDiscount: amount(formData, 'pwdDiscount'),
    otherDiscount: amount(formData, 'otherDiscount'),
    comps: amount(formData, 'comps'),
    serviceCharge: amount(formData, 'serviceCharge'),
    otherCharges: amount(formData, 'otherCharges'),
    cashCollected: amount(formData, 'cashCollected'),
    onlineCollected: amount(formData, 'onlineCollected'),
    creditSales: amount(formData, 'creditSales'),
    channels,
    tenders,
  };
}

export async function createSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const nav = carryNav(formData);

  // T-387 S4: checked before the try - a redirect thrown inside it would be caught below and redirect again.
  if (!storeId) return await redirectWithFlash('/sales-days/new', nav, { error: 'Choose a store.', field: 'store' });
  let newId: string;
  try {
    assertFieldRules(SALES_DAY_CREATE_RULES, formData);
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createSalesDay(tx, actor, {
        storeId,
        businessDate: str(formData, 'businessDate'),
        ...parseDayFigures(formData),
      }),
    );
    newId = result.id;
  } catch (err) {
    return await redirectWithFlash('/sales-days/new', nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${newId}`, nav);
}

/**
 * T-375 S3: a LINKED store's day comes from POS. Reads `storeId` and `businessDate`; success goes to the new day,
 * a refusal back to the new-day page with its sentence. Everything else (the link, the fetch, the derivation, the
 * block) is `importSalesDay`'s.
 */
export async function importSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const nav = carryNav(formData);

  let dayId: string;
  try {
    if (!storeId) throw new Error('Choose a store.');
    assertFieldRules(SALES_DAY_IMPORT_RULES, formData);
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      importSalesDay(tx, actor, { storeId, businessDate: str(formData, 'businessDate') }),
    );
    dayId = result.id;
  } catch (err) {
    return await redirectWithFlash('/sales-days/new', nav, { error: errorMessage(err) });
  }
  // T-375 S6 (R10, V4): POS changes past days (voids, closed-receipt edits), so the 7 days before this one are
  // checked again - AFTER the import has committed, with nothing held across POS. A failure is logged, never shown.
  try {
    await recheckRecentDays(actor, storeId, str(formData, 'businessDate'));
  } catch (err) {
    logger.error({ storeId, businessDate: str(formData, 'businessDate'), err: err instanceof Error ? err.message : String(err) }, 'importSalesDayAction: the prior-days recheck failed');
  }
  return await redirectWithFlash(`/sales-days/${dayId}`, nav);
}

/**
 * T-375 S6: **Check POS again** (the day page and the T-210 screen). Reads `salesDayId`; stores a recheck batch of what
 * POS says now. `returnTo` may name the reconciliation screen; anything else returns to the day's own page.
 */
export async function recheckPosDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  // DEF-603: `returnTo` is form-supplied. Only the reconciliation screen is honoured, as a same-app path plus its
  // uuid / date nav keys; anything else is the day's own page.
  const returned = splitReturnTo(str(formData, 'returnTo'), '');
  const toReconciliation = returned.path === '/reports/pos-reconciliation';
  const targetPath = toReconciliation ? returned.path : `/sales-days/${id}`;
  const targetNav = toReconciliation ? returned.nav : nav;
  try {
    await recheckPosDay(actor, { salesDayId: id });
  } catch (err) {
    return await redirectWithFlash(targetPath, targetNav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(targetPath, targetNav);
}

/**
 * T-375 S6: **Post correction** on a verified feed day POS changed. Reads `salesDayId`, `feedId`, `entryDate`, `reason`.
 * Every outcome returns to the day's page; the domain owns every rule and sentence.
 */
export async function postPosCorrectionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  try {
    assertFieldRules(SALES_DAY_CORRECTION_RULES, formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      postPosCorrection(tx, actor, {
        salesDayId: id,
        feedId: str(formData, 'feedId'),
        entryDate: str(formData, 'entryDate'),
        reason: str(formData, 'reason'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav);
}

/**
 * T-375 S3: **Re-import from POS** on an open or submitted feed day. Reads `salesDayId`; the store and date are the
 * day's own. Every outcome returns to the day's page (the domain re-checks who may and whether it is verified).
 */
export async function reimportSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => reimportSalesDay(tx, actor, { salesDayId: id }));
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav);
}

/**
 * T-369 S3 (DEF-479): fix an unverified day. Reads the same fields as create plus `salesDayId`; the
 * store and the date are NOT read - the domain never edits them (R1). The domain re-checks who may
 * edit which status, so a forged POST is refused there; every outcome returns to the day's own page.
 */
export async function editSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      editSalesDay(tx, actor, { salesDayId: id, ...parseDayFigures(formData) }),
    );
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav);
}

export async function submitSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => submitSalesDay(tx, actor, id));
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav);
}

export async function verifySalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => verifySalesDay(tx, actor, id));
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav, { ok: 'Sales day verified.', stamp: 'VERIFIED' });
}

export async function voidSalesDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);
  try {
    // T-412: ONE action serves "Withdraw day" (unverified: nothing was posted) and "Void" (verified: reverses the posting).
    // The SERVER tells them apart from the record's status, never from the form: a verified day needs an administrator's PIN.
    const target = await loadDestructiveTarget(actor, 'sales_day', id, ['void_sales_day']);
    const needsPin = (status: string | null) => status === 'verified';
    const approval = needsPin(target.status)
      ? await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'void_sales_day' })
      : null;
    assertFieldRules(SALES_DAY_VOID_RULES, formData);
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await assertApprovalStillRight(tx, actor, 'sales_day', id, needsPin, approval !== null);
      await voidSalesDay(tx, actor, id, str(formData, 'reason'));
      if (approval) await recordApproval(tx, actor, approval, { capability: 'void_sales_day', entityType: 'sales_day', entityId: id, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav, { ok: 'Sales day voided.', stamp: 'VOID' });
}

/**
 * T-375 S4 (R8): the **Platform sales** section of a feed day. Rows arrive as channel_<id> / nosales_<id> pairs (the
 * channel id is in the field name, as on the typed form). A blank box clears that channel's row; the domain refuses a
 * remitted channel, a negative amount and a day that is verified. Every outcome returns to the day's own page.
 */
export async function setPlatformSalesAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'salesDayId');
  const nav = carryNav(formData);

  const rows: { channelId: string; amount: string; noSales: boolean }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('channel_') || typeof value !== 'string') continue;
    const channelId = key.slice('channel_'.length);
    // Passed on as typed: the domain parses it in words after authorize().
    rows.push({ channelId, amount: value.trim(), noSales: formData.get(`nosales_${channelId}`) === 'on' });
  }
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setPlatformSales(tx, actor, { salesDayId: id, rows }));
  } catch (err) {
    return await redirectWithFlash(`/sales-days/${id}`, nav, { error: errorMessage(err), typed: keepTyping(formData, PLATFORM_SALES_EDIT, id, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/sales-days/${id}`, nav);
}
