'use server';

/**
 * Server actions for `/findings`. T-135.
 *
 * ⛔ **There is exactly one action, and it is not "resolve".** The only way a finding leaves the
 * feed is for its condition to stop being true. Acknowledging says *"I accept this for now"*, is
 * still counted, ages visibly, and expires after 30 days on its own.
 */
import { redirect } from 'next/navigation';
import { acknowledgeFinding, closePeriod } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
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

/**
 * T-264 / DEF-284 slice 2 — the close action. ⛔ **`ready === true` on this page is a hint, never
 * the authority.** Every gate — the capability, the unposted-draft check, `closeReadiness`, the
 * earlier-period-open rule — is re-checked inside `closePeriod` itself, so a stale page or a
 * button clicked twice cannot close a period that is not actually closeable.
 */
export async function closePeriodAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const period = str(formData, 'period');

  try {
    await withOrgPrincipal(actor.orgId, (tx) => closePeriod(tx, actor, { period }));
  } catch (err) {
    back({ error: errorMessage(err), period });
  }
  back({ ok: `${period} is closed.`, period });
}
