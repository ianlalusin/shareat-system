'use server';

/**
 * Server actions for the clock-terminal admin screen — T-203, closing DEF-133.
 *
 * ⭐ Every mutation runs under `withOrgPrincipal`, wired to the REAL Firestore driver
 * (`createFirestoreTerminalDriver()`, `packages/sync-firestore`) — this file is that driver's
 * first caller anywhere in `apps/`. A local dev run therefore mints a real Firebase custom token
 * and touches the real `shareat-hub-v2` Auth user store (spec §4), not an emulator.
 *
 * ⚠️ **`provisionTerminalAction` and `mintTerminalTokenAction` are called DIRECTLY by a client
 * component — not through a `<form action>` + redirect.** Their return value carries a one-time
 * custom token (`terminals.ts`'s own doc comment: *"Returned once and never stored"*), and a
 * redirect would have to carry it through a URL or a query string to survive the navigation —
 * exactly the kind of place invariant 2 forbids it from landing. Calling the action directly and
 * holding the result only in the caller's React state (`ProvisionForm.tsx`, `RepairButton.tsx`,
 * `TokenReveal.tsx`) means the token never touches a URL, a cookie, or anything a refresh replays.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createFirestoreTerminalDriver } from '@shareat/sync-firestore';
import { mintTerminalToken, provisionTerminal, revokeTerminal } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';

const RETURN_TO = '/attendance/terminals';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/may not 'provision_clock_terminal'/.test(raw)) {
    return 'Only an admin or super-admin scoped to this store may provision, re-pair or revoke a clock terminal.';
  }
  if (/may not 'manage_attendance'/.test(raw)) {
    return 'Only a manager, admin or super-admin scoped to this store may view its terminals.';
  }
  return sharedErrorMessage(err);
}

function back(storeId: string, extra: Record<string, string>): never {
  const params = new URLSearchParams({ store: storeId, ...extra });
  redirect(`${RETURN_TO}?${params.toString()}`);
}

export type ProvisionActionResult =
  | { ok: true; terminalId: string; label: string; customToken: string }
  | { ok: false; error: string };

export async function provisionTerminalAction(input: {
  storeId: string;
  label: string;
}): Promise<ProvisionActionResult> {
  const actor = await requireActor(RETURN_TO);
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      provisionTerminal(tx, actor, createFirestoreTerminalDriver(), {
        storeId: input.storeId,
        label: input.label,
      }),
    );
    revalidatePath(RETURN_TO);
    return {
      ok: true,
      terminalId: result.terminal.id,
      label: result.terminal.label,
      customToken: result.customToken,
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export type MintTokenActionResult = { ok: true; customToken: string } | { ok: false; error: string };

/** Re-pair: mints a FRESH one-time token for an already-provisioned terminal, same identity. */
export async function mintTerminalTokenAction(input: {
  terminalId: string;
}): Promise<MintTokenActionResult> {
  const actor = await requireActor(RETURN_TO);
  try {
    const { customToken } = await withOrgPrincipal(actor.orgId, (tx) =>
      mintTerminalToken(tx, actor, createFirestoreTerminalDriver(), { terminalId: input.terminalId }),
    );
    return { ok: true, customToken };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Revoke — a real capability cutoff for a physical device, not a label edit. The domain refuses an
 * empty reason (invariant 4); the required `reason` input is this screen's confirmation step, the
 * same "type why, then submit" friction every other destructive action in this app already uses
 * (`/trade/orders/[id]`'s Void, `/items`'s Reject) rather than a separate JS confirm dialog.
 */
export async function revokeTerminalAction(formData: FormData): Promise<void> {
  const actor = await requireActor(RETURN_TO);
  const storeId = str(formData, 'storeId');
  const terminalId = str(formData, 'terminalId');
  const reason = str(formData, 'reason');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      revokeTerminal(tx, actor, createFirestoreTerminalDriver(), { terminalId, reason }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  revalidatePath(RETURN_TO);
  back(storeId, {
    ok: 'Terminal revoked — it can no longer punch. It also stops appearing in the list below, which only shows live terminals; provision a new one rather than trying to revive it.',
  });
}
