import { FormDisclosure } from '@/components/forms/FormDisclosure';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { employmentRepo, schema } from '@shareat/db';
import { listCredentials, MAX_TEMPLATES, type CredentialSummary } from '@shareat/domain';
import { requirePageAccess } from '../../../../lib/page-access';
import { can } from '@shareat/auth';
import { listStores, withOrgPrincipal } from '../../../expenses/lib';
import { enrolCardAction, enrolFingerprintAction, revokeCredentialAction } from './actions';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { Button, ConfirmDestructive, Field, FlashBanner, Input, Textarea } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { STAFF_CARD_RULES, STAFF_CREDENTIAL_REVOKE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Credentials — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

function fmt(d: Date): string {
  return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}

function summaryLine(c: CredentialSummary): string {
  if (c.kind === 'card') return c.cardHint ? `Card …${c.cardHint}` : 'Card';
  return `Fingerprint — ${c.fingerCount} finger${c.fingerCount === 1 ? '' : 's'} enrolled`;
}

/*
  ⭐ T-203, closing DEF-133. `enrolCard` / `enrolFingerprint` / `revokeCredential` / `listCredentials`
  (T-185) had zero callers outside their own tests until this screen. Reached from an employment
  that already exists (T-202) — this page 404s on a bad or cross-org id rather than crashing.

  ⛔ **Never render a raw card id or a fingerprint template.** `listCredentials` already returns only
  `CredentialSummary` — id, kind, a card HINT (last 4 chars), finger count, who/when enrolled — and
  this page does not work around that by, say, echoing a submitted card id back onto the page.
*/
export default async function CredentialsPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { employmentId } = await params;
  const sp = await withFlash(searchParams);
  // T-435 / bible row 353 - the read gate; the person's name is read only AFTER the employment is proven to be at a store the
  // viewer holds (enrol_staff or manage_attendance), so another store's employment is the same notFound as a forged id.
  const { actor, refusal } = await requirePageAccess(`/staff/${employmentId}/credentials`);
  if (refusal) return refusal;

  const { employment, personName } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const employment = await employmentRepo.getEmployment(tx, employmentId);
    if (!employment) return { employment: undefined, personName: undefined };
    if (!(await can(tx, actor, 'enrol_staff', { storeId: employment.storeId })) && !(await can(tx, actor, 'manage_attendance', { storeId: employment.storeId }))) {
      return { employment: undefined, personName: undefined };
    }
    const [person] = await tx
      .select({ displayName: schema.persons.displayName })
      .from(schema.persons)
      .where(eq(schema.persons.id, employment.personId))
      .limit(1);
    return { employment, personName: person?.displayName };
  });
  if (!employment || employment.orgId !== actor.orgId) notFound();

  // Credentials are listed under manage_attendance; someone who holds only enrol_staff gets a plain refusal, not a throw.
  const mayListCredentials = await withOrgPrincipal(actor.orgId, (tx) => can(tx, actor, 'manage_attendance', { storeId: employment.storeId }));
  if (!mayListCredentials) {
    return (
      <Page density="table">
        <h1 className="text-2xl font-semibold">Credentials</h1>
        <p className="mt-4 text-sm">You do not have access to this screen. Credentials need the manage_attendance capability at this store.</p>
      </Page>
    );
  }

  const [stores, credentials] = await Promise.all([
    listStores(actor.orgId),
    withOrgPrincipal(actor.orgId, (tx) => listCredentials(tx, actor, { employmentId })),
  ]);
  const storeName = stores.find((s) => s.id === employment.storeId)?.name ?? employment.storeId;

  return (
    <Page density="table">
      <div>
        <Link
          href={`/staff/${employmentId}`}
          className={`${ACTION_LINK} text-neutral-500 underline-offset-4 hover:no-underline`}
        >
          ← Back to employment
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          Credentials{personName ? ` — ${personName}` : ''}
        </h1>
        <PageDescription>
          <span className="font-mono">{employment.staffCode}</span> · {storeName}
          {employment.endedOn ? ' · employment ended' : ''}. What is enrolled here — hint and
          metadata only, never a secret a badge could be cloned from.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <section className="space-y-3">
        <h2 className="font-medium">
          Enrolled <span className="text-sm font-normal text-neutral-500">({credentials.length})</span>
        </h2>
        {credentials.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing enrolled yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {credentials.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <div>
                  <div className="font-medium">{summaryLine(c)}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    Enrolled {fmt(c.enrolledAt)}
                  </div>
                </div>
                <CheckedForm rules={STAFF_CREDENTIAL_REVOKE_RULES} action={revokeCredentialAction} className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:min-w-64 sm:flex-1 sm:justify-end">
                  <input type="hidden" name="credentialId" value={c.id} />
                  <input type="hidden" name="employmentId" value={employmentId} />
                  <Field label="Reason to revoke" rule={STAFF_CREDENTIAL_REVOKE_RULES.reason} className="w-full sm:w-auto sm:min-w-48 sm:flex-1">
                    <Input {...nativeAttrs(STAFF_CREDENTIAL_REVOKE_RULES.reason)} placeholder="Reason to revoke" className="w-full" />
                  </Field>
                  <ConfirmDestructive
                    tier="retype"
                    label="Revoke credential"
                    consequence="Revokes this credential."
                    expectedName={personName ?? ''}
                  />
                </CheckedForm>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Enrol a card</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Type the card id, or scan it with a keyboard-wedge reader — it types the digits and Enter
          exactly like a keyboard, the same interface the clock terminal&rsquo;s own scan box uses.
        </p>
        <CheckedForm rules={STAFF_CARD_RULES} action={enrolCardAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="employmentId" value={employmentId} />
          <Field label="Card id" rule={STAFF_CARD_RULES.cardId} className="min-w-0 flex-1 sm:min-w-48">
            <Input {...nativeAttrs(STAFF_CARD_RULES.cardId)} autoFocus placeholder="Scan or type" className="w-full" />
          </Field>
          <Button type="submit" variant="primary">
            Enrol card
          </Button>
        </CheckedForm>
      </section>

      <section className="space-y-3 rounded-lg border border-warning bg-warning-soft p-4">
        <h2 className="font-medium text-warning-ink">
          Enrol a fingerprint — not a working capture flow
        </h2>
        <p className="text-xs text-warning-ink">
          ⚠️ There is no fingerprint reader wired into this app anywhere — that needs the native
          reader in the APK D2 parked. This form accepts raw template text, typed or pasted, one per
          line. It is useful only for seeding test data or as a target for a future reader
          integration; it is <strong>not</strong> how a real fingerprint gets enrolled today.
        </p>
        <FormDisclosure><form action={enrolFingerprintAction} className="space-y-2">
          <input type="hidden" name="employmentId" value={employmentId} />
          <Textarea
            name="templates"
            rows={3}
            placeholder={`Up to ${MAX_TEMPLATES} templates, one per line`}
            className="w-full font-mono text-xs"
          />
          <Button type="submit" variant="secondary">
            Enrol fingerprint (test/dev only)
          </Button>
        </form></FormDisclosure>
      </section>
    </Page>
  );
}
