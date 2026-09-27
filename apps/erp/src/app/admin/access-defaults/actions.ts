'use server';

/**
 * Server actions for `/admin/access-defaults`. T-290.
 * `docs/tasks/290-access-defaults-screen.md` §C2, §C7.
 *
 * ⭐ **Thin adapters, exactly like `apps/erp/src/app/admin/users/actions.ts`.** Parse `FormData`,
 * call the gated domain function, redirect with a message. ⛔ **No `person_grants` write and no
 * `position_capability_defaults` write happens here** — every one is made by T-289's
 * `setPositionDefault` / `retireStorePosition`, which own the `authorize()` call, the store-in-org
 * check, the position-belongs-here check and the offerable check. Composing an
 * `authorize()`-then-write pair in this file would be exactly the mistake `admin/users/actions.ts`'s
 * own header warns about: *"a rule in one route file is a rule the next route file misses,"* which
 * is how DEF-180 and DEF-223 happened.
 *
 * ⚠️ The actor comes from the session (`requireActor`), never the form
 * (`tests/unit/no-client-supplied-actor.test.ts`, bible §7.1).
 */
import { redirect } from 'next/navigation';
import { accessRepo, type Tx } from '@shareat/db';
import { retireStorePosition, setPositionDefault } from '@shareat/domain';
import { type Capability } from '@shareat/auth';
import { requireActor } from '../../../lib/session';
import { activeDefaultsAtStore, bannerMessage, bulkBannerMessage, copyableDefaults, withOrgPrincipal } from './lib';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A presentable error (every `authorize()` denial among them) already carries its own sentence —
 * S2/S2b's — and wins first. Otherwise, turn a known refusal into a sentence a human can act on
 * rather than leaking a function name or a raw Postgres message. Most of `setPositionDefault` /
 * `retireStorePosition`'s own messages (`packages/domain/src/people/position-defaults.ts`) are
 * already written for exactly this screen and pass through unchanged.
 */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (/does not belong to this organisation/.test(raw)) {
    return 'That store does not belong to this organisation.';
  }
  if (/does not exist in this organisation/.test(raw)) {
    return 'That position does not exist in this organisation.';
  }
  if (
    /belongs to a different store|may not be defaulted to a position|already holds .* through the role matrix|is a canonical position and belongs to the organisation/.test(
      raw,
    )
  ) {
    return raw;
  }
  return sharedErrorMessage(err);
}

function backToGrid(storeId: string, extra: Record<string, string>): never {
  redirect(`/admin/access-defaults?${new URLSearchParams({ store: storeId, ...extra }).toString()}`);
}

/**
 * §C7 — one cell, one submission, one transaction. All-or-nothing is trivial at this grain (a
 * submission names exactly one cell), and the error already names the cell that caused it because
 * `setPositionDefault`'s own refusal messages (`packages/domain/src/people/position-defaults.ts`)
 * are written in terms of the position and capability the caller passed.
 *
 * ⚠️ **Deliberately per-cell, not a batched "tick several boxes, then Save."** §C5 requires the
 * grid to reflow into "one position per section" at phone width rather than a horizontally-
 * scrolling table (phone portrait is the canvas) — the same page therefore renders TWO markups of
 * the same cells (a `sm:` table and a mobile accordion), CSS-toggled, and BOTH are always present
 * in the DOM. A checkbox holding PENDING, un-submitted edits cannot safely exist twice for the
 * same cell — checking one copy does not check its sibling, so the two could disagree on submit
 * and silently apply the wrong state. A toggle button that always flips FROM THE CURRENT
 * PERSISTED STATE has no such hazard: both copies encode the identical action, so duplicating it
 * across the responsive layouts is safe. This mirrors the established idiom already in this app —
 * `setStoreScopeAction` / `admin/users/[personId]/page.tsx`'s "In scope — remove" button, one
 * immediate toggle per row, not a batch.
 */
export async function toggleDefaultAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/access-defaults');
  const storeId = str(formData, 'storeId');
  const positionId = str(formData, 'positionId');
  const capability = str(formData, 'capability') as Capability;
  const on = str(formData, 'on') === 'true';

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, async (tx: Tx) => {
      const result = await setPositionDefault(tx, actor, { positionId, storeId, capability, on });
      message = bannerMessage(result.affected, result.skippedSelf);
    });
  } catch (err) {
    // Amendment A1 point 1 — cap/pos ride BOTH the ok and error redirect, so the reopened area
    // survives whichever path the toggle took. Values are the ones already read from the form.
    backToGrid(storeId, { error: errorMessage(err), cap: capability, pos: positionId });
  }
  backToGrid(storeId, { ok: message, cap: capability, pos: positionId });
}

/**
 * §C7 — "Same for every store", offered on canonical rows only. Reads the SOURCE store's
 * currently-SAVED active defaults for one position (never the pending, unsaved grid state — this
 * bulk action applies what is already true, not what a half-filled form happens to hold), then
 * one `setPositionDefault(..., on: true)` per OTHER active store, in ONE transaction.
 * ⛔ All-or-nothing: `setPositionDefault` itself refuses a store-invented position aimed at a
 * store it does not belong to (T-289 §C8.3), which is what stops this ever reaching a
 * non-canonical position by a crafted POST — the domain owns that check, not this file.
 */
export async function sameForEveryStoreAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/access-defaults');
  const storeId = str(formData, 'storeId');
  const positionId = str(formData, 'positionId');

  let totalAffected = 0;
  let anySkippedSelf = false;
  let rowsWritten = 0;
  const storesReached = new Set<string>();
  try {
    const sourceDefaults = (await activeDefaultsAtStore(actor, storeId)).filter(
      (d) => d.positionId === positionId,
    );
    await withOrgPrincipal(actor.orgId, async (tx: Tx) => {
      const activeStoreIds = await accessRepo.activeStoreIdsForOrg(tx, actor.orgId);
      for (const targetStoreId of activeStoreIds) {
        if (targetStoreId === storeId) continue;
        for (const d of sourceDefaults) {
          const result = await setPositionDefault(tx, actor, {
            positionId: d.positionId,
            storeId: targetStoreId,
            capability: d.capability,
            on: true,
          });
          if (result.wroteDefault) {
            rowsWritten++;
            storesReached.add(targetStoreId);
          }
          totalAffected += result.affected;
          if (result.skippedSelf) anySkippedSelf = true;
        }
      }
    });
  } catch (err) {
    backToGrid(storeId, { error: errorMessage(err) });
  }
  backToGrid(storeId, { ok: bulkBannerMessage(rowsWritten, storesReached.size, totalAffected, anySkippedSelf) });
}

/**
 * §C7 — "Copy defaults from…". For each active default at the SOURCE store whose position is
 * canonical (`copyableDefaults`, §T1.4 — a store-invented position belongs to its own store and
 * never copies), one `setPositionDefault(..., on: true)` at the TARGET (current) store, in ONE
 * transaction. Copies, never links (decision 2) — this writes N new rows, not a relationship.
 */
export async function copyDefaultsAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/access-defaults');
  const targetStoreId = str(formData, 'storeId');
  const sourceStoreId = str(formData, 'sourceStoreId');

  let totalAffected = 0;
  let anySkippedSelf = false;
  let rowsWritten = 0;
  try {
    if (sourceStoreId === targetStoreId) {
      throw new Error('Choose a different store to copy from.');
    }
    const sourceDefaults = copyableDefaults(await activeDefaultsAtStore(actor, sourceStoreId));
    await withOrgPrincipal(actor.orgId, async (tx: Tx) => {
      for (const d of sourceDefaults) {
        const result = await setPositionDefault(tx, actor, {
          positionId: d.positionId,
          storeId: targetStoreId,
          capability: d.capability,
          on: true,
        });
        if (result.wroteDefault) rowsWritten++;
        totalAffected += result.affected;
        if (result.skippedSelf) anySkippedSelf = true;
      }
    });
  } catch (err) {
    backToGrid(targetStoreId, { error: errorMessage(err) });
  }
  backToGrid(targetStoreId, { ok: bulkBannerMessage(rowsWritten, rowsWritten > 0 ? 1 : 0, totalAffected, anySkippedSelf) });
}

/**
 * Retires a store-invented position (§C9 moment 6) — the domain's `retireStorePosition`, whose
 * spine (T-289) this screen is the FIRST caller of. ⚠️ Not detailed in T-290's contract sections
 * (C1-C10), but named as one of the two functions "this screen calls" in the task's own opening
 * paragraph, and required by §C9's exemption-deletion rule (deleting `retireStorePosition`'s
 * `EXEMPT` row without giving it a real caller would break
 * `tests/unit/domain-actions-have-callers.test.ts`'s own stale-exemption guard the other way).
 * Reported as a spec gap in this task's report; resolved here as a small, in-scope, judgement
 * call (RULES §0.1 — Claude decides HOW) rather than a blocker, since it is directly buildable and
 * squarely within the screen's stated purpose. Offered on non-canonical (store-invented) position
 * columns only — a canonical position cannot be retired and `retireStorePosition` refuses it
 * anyway if reached by a crafted POST.
 */
export async function retireStorePositionAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/access-defaults');
  const storeId = str(formData, 'storeId');
  const positionId = str(formData, 'positionId');

  try {
    await withOrgPrincipal(actor.orgId, (tx: Tx) => retireStorePosition(tx, actor, { positionId }));
  } catch (err) {
    backToGrid(storeId, { error: errorMessage(err) });
  }
  backToGrid(storeId, { ok: 'Position retired. Its defaults were revoked and every holder reconciled.' });
}
