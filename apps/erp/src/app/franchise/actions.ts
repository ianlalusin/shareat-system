'use server';

/**
 * T-398 S6d - the two reading buttons. A look is a press (POST), never a page load: one press writes one access-log row in the database. The actor is the session's
 * person; the franchisee and store are choices, never an identity. Refusals (the database's own sentences, or authorize()) come back as words, not crashes.
 */
import { createElement, type ReactNode } from 'react';
import { viewFranchiseSales, viewFranchiseStock } from '@shareat/domain';
import { errorMessage } from '@/lib/constraint-messages';
import { requireActor } from '../../lib/session';
import { withActorPrincipal } from '../expenses/lib';
import { LookRefused, SalesResult, StockResult } from './views';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** The franchise functions' own sentences (migration 0220). Anything else with the same code (e.g. a row-level-security refusal naming a table) is not shown raw. */
const OWN_SENTENCES: readonly RegExp[] = [
  /^Looking at a franchise needs a signed-in (organisation|person)\.$/,
  /^The signed-in person is not an active person of this organisation\.$/,
  /^This person does not hold the right to view franchise sales and stock\.$/,
  /^Your organisation has no franchise agreement with that organisation\.$/,
  /^The franchise agreement with that organisation ended on [\d-]+\.$/,
  /^Both a start date and an end date are needed\.$/,
  /^The end date [\d-]+ comes before the start date [\d-]+\.$/,
  /^Sales of this franchise are visible from [\d-]+; the range you asked for starts on [\d-]+\.$/,
  /^A range may cover at most 366 days; you asked for \d+ days\.$/,
  /^The reason may be at most 500 characters\.$/,
  /^That store does not belong to this franchise\.$/,
];

/** The database's own sentence for a refused look (permission or range), else the screen-safe wording. */
function words(err: unknown): string {
  let c: unknown = err;
  for (let i = 0; i < 4 && c; i++) {
    const e = c as { code?: unknown; message?: unknown; cause?: unknown };
    if ((e.code === '42501' || e.code === '22023') && typeof e.message === 'string' && OWN_SENTENCES.some((r) => r.test(e.message as string))) return e.message;
    c = e.cause;
  }
  return errorMessage(err);
}

const refused = (w: string): ReactNode => createElement(LookRefused, { words: w });

export async function viewFranchiseSalesAction(_prev: ReactNode | null, fd: FormData): Promise<ReactNode> {
  const actor = await requireActor('/franchise/sales');
  const franchiseeOrgId = str(fd, 'franchiseeOrgId');
  const from = str(fd, 'from');
  const to = str(fd, 'to');
  const reason = str(fd, 'reason');
  if (!UUID.test(franchiseeOrgId)) return refused('Pick the franchise to look at.');
  if (!DATE.test(from) || !DATE.test(to)) return refused('Enter both dates as YYYY-MM-DD.');
  try {
    const lines = await withActorPrincipal(actor.orgId, actor.personId, (tx) =>
      viewFranchiseSales(tx, actor, { franchiseeOrgId, from, to, reason: reason === '' ? null : reason }),
    );
    return createElement(SalesResult, { lines });
  } catch (err) {
    return refused(words(err));
  }
}

export async function viewFranchiseStockAction(_prev: ReactNode | null, fd: FormData): Promise<ReactNode> {
  const actor = await requireActor('/franchise/stock');
  const franchiseeOrgId = str(fd, 'franchiseeOrgId');
  const storeId = str(fd, 'storeId');
  const reason = str(fd, 'reason');
  if (!UUID.test(franchiseeOrgId)) return refused('Pick the franchise to look at.');
  if (storeId !== '' && !UUID.test(storeId)) return refused("That store is not one of this franchise's stores.");
  try {
    const lines = await withActorPrincipal(actor.orgId, actor.personId, (tx) =>
      viewFranchiseStock(tx, actor, { franchiseeOrgId, storeId: storeId === '' ? null : storeId, reason: reason === '' ? null : reason }),
    );
    return createElement(StockResult, { lines });
  } catch (err) {
    return refused(words(err));
  }
}
