'use server';

/**
 * Server actions for the physical-count screens — T-169 / DEF-135 (2026-09-03).
 *
 * Thin adapters: parse `FormData`, call `packages/domain/src/stock/count-workflow.ts`, redirect
 * with a message. ⭐ The actor comes from the session, never the form (T-138) — authorization is
 * each workflow function's own FIRST statement, not repeated here. Every mutation runs under the
 * org's RLS principal (`withOrgPrincipal`), the same shape `commissary/catalogue/actions.ts` uses.
 *
 * ⚠️ **`redirect()` is called exactly once, and only AFTER the try/catch below has finished** —
 * Next's `redirect()` works by throwing, so calling it from inside a `try` whose own `catch`
 * translates thrown errors would have that catch swallow and re-wrap the redirect itself. Each
 * workflow function here returns `{ ok: false, reason }` for an expected business refusal and
 * THROWS for an authorize() denial or a DB trigger — both are captured into one `errorText`
 * variable inside the try, and the single redirect at the end reads it.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  advanceCountSession,
  cancelCountSession,
  commitCount,
  openCountSession,
  recordCount,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function list(fd: FormData, key: string): string[] {
  return fd.getAll(key).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * A presentable error (an `authorize()` denial among them) already carries its own sentence and
 * wins first. Otherwise, turns a DB trigger's own message into one readable sentence — the same
 * local, non-shared mapping `commissary/catalogue/actions.ts` keeps for its own triggers
 * (bible: `constraint-messages.ts` is shared and off-limits; each screen keeps its own).
 */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (/already in active count session/.test(raw)) {
    return 'One of those rooms is already frozen by another active count — finish or cancel that one first.';
  }
  if (/is frozen by an active count session/.test(raw)) {
    return 'That room is frozen by an active count — finish or cancel the count first.';
  }
  if (/count_lines_counted_non_negative/.test(raw)) {
    return 'A counted quantity cannot be negative.';
  }
  if (/count session .* is already committed/.test(raw)) {
    return 'This count was already committed — a count can only be committed once.';
  }
  return sharedErrorMessage(err);
}

export async function openCountSessionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/counts');
  const storeId = str(fd, 'storeId');
  const locationIds = list(fd, 'locationIds');
  const countedOn = str(fd, 'countedOn');
  const note = str(fd, 'note');

  let sessionId: string | null = null;
  let errorText: string | null = null;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      openCountSession(tx, actor, { storeId, locationIds, countedOn, note: note || null }),
    );
    if (result.ok) sessionId = result.sessionId;
    else errorText = result.reason;
  } catch (err) {
    errorText = errorMessage(err);
  }

  if (errorText || !sessionId) {
    redirect(`/inventory/counts?store=${storeId}&error=${encodeURIComponent(errorText ?? 'Could not open the count.')}`);
  }
  revalidatePath('/inventory/counts');
  redirect(`/inventory/counts/${sessionId}?ok=${encodeURIComponent('Count opened. The room is frozen for every other stock writer.')}`);
}

export async function recordCountAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/counts');
  const sessionId = str(fd, 'sessionId');
  const itemId = str(fd, 'itemId');
  const locationId = str(fd, 'locationId');
  const countedQuantity = str(fd, 'countedQuantity');

  let errorText: string | null = null;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      // T-371 S3: the raw figure goes to the domain, which parses it after `authorize()` (R5) into a presentable refusal.
      recordCount(tx, actor, { sessionId, itemId, locationId, countedQuantity }),
    );
    if (!result.ok) errorText = result.reason;
  } catch (err) {
    errorText = errorMessage(err);
  }

  if (errorText) {
    redirect(`/inventory/counts/${sessionId}?error=${encodeURIComponent(errorText)}`);
  }
  revalidatePath(`/inventory/counts/${sessionId}`);
  redirect(`/inventory/counts/${sessionId}?ok=${encodeURIComponent('Line saved.')}`);
}

export async function advanceCountAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/counts');
  const sessionId = str(fd, 'sessionId');

  let errorText: string | null = null;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) => advanceCountSession(tx, actor, { sessionId, to: 'reviewing' }));
    if (!result.ok) errorText = result.reason;
  } catch (err) {
    errorText = errorMessage(err);
  }

  if (errorText) {
    redirect(`/inventory/counts/${sessionId}?error=${encodeURIComponent(errorText)}`);
  }
  revalidatePath(`/inventory/counts/${sessionId}`);
  redirect(`/inventory/counts/${sessionId}?ok=${encodeURIComponent('Moved to reviewing.')}`);
}

export async function commitCountAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/counts');
  const sessionId = str(fd, 'sessionId');

  let errorText: string | null = null;
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) => commitCount(tx, actor, { sessionId }));
    if (!result.ok) {
      errorText = result.reason;
    } else {
      const posted = result.lines.filter((l) => l.movementId);
      message =
        posted.length === 0
          ? 'Committed. Every counted line matched the ledger exactly — nothing posted.'
          : `Committed. ${posted.length} line(s) posted a variance to 5400` +
            (result.shortEntryId ? ` (entry ${result.shortEntryId}${result.longEntryId ? `, and ${result.longEntryId}` : ''})` : result.longEntryId ? ` (entry ${result.longEntryId})` : '') +
            '.';
    }
  } catch (err) {
    errorText = errorMessage(err);
  }

  if (errorText) {
    redirect(`/inventory/counts/${sessionId}?error=${encodeURIComponent(errorText)}`);
  }
  revalidatePath(`/inventory/counts/${sessionId}`);
  revalidatePath('/inventory/counts');
  redirect(`/inventory/counts/${sessionId}?ok=${encodeURIComponent(message)}`);
}

export async function cancelCountAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/counts');
  const sessionId = str(fd, 'sessionId');

  let errorText: string | null = null;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) => cancelCountSession(tx, actor, { sessionId }));
    if (!result.ok) errorText = result.reason;
  } catch (err) {
    errorText = errorMessage(err);
  }

  if (errorText) {
    redirect(`/inventory/counts/${sessionId}?error=${encodeURIComponent(errorText)}`);
  }
  revalidatePath(`/inventory/counts/${sessionId}`);
  revalidatePath('/inventory/counts');
  redirect(`/inventory/counts/${sessionId}?ok=${encodeURIComponent('Count cancelled. The room is free again; nothing posted.')}`);
}
