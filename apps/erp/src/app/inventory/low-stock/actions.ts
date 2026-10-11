'use server';

/**
 * Server actions for the low-stock screen — T-175.
 *
 * Thin adapters: parse `FormData`, authorise, call the repo, revalidate. ⭐ **The actor comes from
 * the session, never the form** (T-138) — `tests/unit/no-client-supplied-actor.test.ts` fails the
 * build if that ever changes.
 */
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { LOW_STOCK_THRESHOLD } from './typed-forms';
import { revalidatePath } from 'next/cache';
import { authorize } from '@shareat/auth';
import { lowStockRepo } from '@shareat/db';
import { parseDecimalInput } from '@shareat/domain/money-input';
import { requireActor } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setThresholdAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/low-stock');
  const storeId = str(fd, 'storeId');
  const itemId = str(fd, 'itemId');
  const raw = str(fd, 'threshold');

  // ⚠️ `redirect()` works by throwing, so it sits OUTSIDE the try (siblings: fixed-assets, locations) — no NEXT_REDIRECT is ever caught here.
  let failure: string | null = null;
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // ⭐ Store-scoped, staff and up. The person who notices the shelf is empty is the person on
      // the floor, and an unset threshold is INVISIBLE — the item just never appears on this list —
      // so friction here has no counter-pressure.
      await authorize(tx, actor, 'set_item_threshold', { storeId });

      // ⚠️ An empty box CLEARS the threshold rather than meaning zero. Zero is a real setting that
      // means "tell me the moment it runs out"; they are different states and the form must not
      // collapse them.
      if (raw === '') {
        await lowStockRepo.clearThreshold(tx, storeId, itemId);
        return;
      }
      // ⭐ T-371 — a direct repo write, so the parse lives here, AFTER `authorize()` (R5): the typed figure is minted at the
      // column's (14,3) shape, and `'abc'` / `'NaN'` get a sentence naming the field instead of the database's finite CHECK.
      const threshold = parseDecimalInput(raw, '14,3', 'setThresholdAction: the low-stock threshold', 'Low-stock threshold');
      await lowStockRepo.setThreshold(tx, {
        orgId: actor.orgId,
        storeId,
        itemId,
        threshold,
        setBy: actor.personId,
      });
    });
  } catch (err) {
    failure = errorMessage(err);
  }
  if (failure !== null) {
    return await redirectWithFlash('/inventory/low-stock', { store: storeId }, { error: failure, typed: keepTyping(fd, LOW_STOCK_THRESHOLD, itemId, { actorId: actor.personId }) });
  }

  revalidatePath('/inventory/low-stock');
}
