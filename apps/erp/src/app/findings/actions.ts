'use server';

/**
 * Server actions for `/findings`. T-135.
 *
 * ⛔ **There is exactly one action, and it is not "resolve".** The only way a finding leaves the
 * feed is for its condition to stop being true. Acknowledging says *"I accept this for now"*, is
 * still counted, ages visibly, and expires after 30 days on its own.
 */
import { redirect } from 'next/navigation';
import { acknowledgeFinding } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(params: Record<string, string>): never {
  redirect(`/findings?${new URLSearchParams(params).toString()}`);
}

export async function acknowledgeFindingAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const period = str(formData, 'period');
  const findingKey = str(formData, 'findingKey');
  const note = str(formData, 'note');

  try {
    // ⚠️ The gate lives inside `acknowledgeFinding` (`close_period`, store-scoped when the finding
    // names a store), not here — a gate in a server action protects one caller.
    await withOrgPrincipal(actor.orgId, (tx) =>
      acknowledgeFinding(tx, actor, { findingKey, period, note: note || null }),
    );
  } catch (err) {
    back({ error: errorMessage(err), period });
  }
  back({ ok: 'Accepted for now — it is still counted, and it will expire.', period });
}
