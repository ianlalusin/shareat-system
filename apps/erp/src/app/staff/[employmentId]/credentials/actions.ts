'use server';

/**
 * Server actions for the credential-enrolment screen — T-203, closing DEF-133.
 *
 * `enrolCard` / `enrolFingerprint` / `revokeCredential` / `listCredentials`
 * (`packages/domain/src/attendance/credentials.ts`, T-185) had zero callers outside their own
 * tests until this screen. Every mutation runs `withOrgPrincipal`, the same pattern
 * `items/actions.ts` and `commissary/catalogue/actions.ts` already use.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { enrolCard, enrolFingerprint, revokeCredential } from '@shareat/domain';
import { withOrgPrincipal } from '../../../expenses/lib';
import { requireActor } from '../../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(employmentId: string, extra: Record<string, string>): never {
  const path = `/staff/${employmentId}/credentials`;
  const qs = new URLSearchParams(extra).toString();
  redirect(qs ? `${path}?${qs}` : path);
}

/** The keyboard-wedge reader types digits and Enter exactly like a keyboard — a plain text field
 *  submitted on Enter is the real interface here, the same shape `/clock`'s scan box already uses. */
export async function enrolCardAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const employmentId = str(formData, 'employmentId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      enrolCard(tx, actor, { employmentId, cardId: str(formData, 'cardId') }),
    );
  } catch (err) {
    back(employmentId, { error: errorMessage(err) });
  }
  revalidatePath(`/staff/${employmentId}/credentials`);
  back(employmentId, { ok: 'Card enrolled.' });
}

/**
 * ⚠️ NOT a working biometric capture flow — spec §2. There is no fingerprint reader wired into
 * this app (the domain module's own header: *"fingerprint needs the native reader in the APK that
 * D2 parked"*). This accepts pasted/typed template text, useful only for seeding test data or a
 * future reader integration to target — the UI says so plainly, and so does this comment.
 */
export async function enrolFingerprintAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const employmentId = str(formData, 'employmentId');
  const templates = str(formData, 'templates')
    .split(/\r?\n|,/)
    .map((t) => t.trim())
    .filter(Boolean);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => enrolFingerprint(tx, actor, { employmentId, templates }));
  } catch (err) {
    back(employmentId, { error: errorMessage(err) });
  }
  revalidatePath(`/staff/${employmentId}/credentials`);
  back(employmentId, {
    ok: 'Template(s) recorded — this is the test/dev enrolment path; no reader is wired into this app.',
  });
}

export async function revokeCredentialAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const employmentId = str(formData, 'employmentId');
  const credentialId = str(formData, 'credentialId');
  const reason = str(formData, 'reason');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => revokeCredential(tx, actor, { credentialId, reason }));
  } catch (err) {
    back(employmentId, { error: errorMessage(err) });
  }
  revalidatePath(`/staff/${employmentId}/credentials`);
  back(employmentId, { ok: 'Credential revoked.' });
}
