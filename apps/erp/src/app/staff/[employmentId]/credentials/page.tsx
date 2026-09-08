import { notFound } from 'next/navigation';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { employmentRepo, schema } from '@shareat/db';
import { listCredentials, MAX_TEMPLATES, type CredentialSummary } from '@shareat/domain';
import { requireSession } from '../../../../lib/session';
import { listStores, withOrgPrincipal } from '../../../expenses/lib';
import { enrolCardAction, enrolFingerprintAction, revokeCredentialAction } from './actions';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Credentials — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

const INPUT =
  'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';

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
  const sp = await searchParams;
  const { actor } = await requireSession(`/staff/${employmentId}/credentials`);

  const { employment, personName } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const employment = await employmentRepo.getEmployment(tx, employmentId);
    if (!employment) return { employment: undefined, personName: undefined };
    const [person] = await tx
      .select({ displayName: schema.persons.displayName })
      .from(schema.persons)
      .where(eq(schema.persons.id, employment.personId))
      .limit(1);
    return { employment, personName: person?.displayName };
  });
  if (!employment || employment.orgId !== actor.orgId) notFound();

  const [stores, credentials] = await Promise.all([
    listStores(actor.orgId),
    withOrgPrincipal(actor.orgId, (tx) => listCredentials(tx, actor, { employmentId })),
  ]);
  const storeName = stores.find((s) => s.id === employment.storeId)?.name ?? employment.storeId;

  return (
    <Page density="form">
      <div>
        <Link
          href={`/staff/${employmentId}`}
          className="text-xs text-neutral-500 underline underline-offset-4 hover:no-underline"
        >
          ← Back to employment
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          Credentials{personName ? ` — ${personName}` : ''}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-mono">{employment.staffCode}</span> · {storeName}
          {employment.endedOn ? ' · employment ended' : ''}. What is enrolled here — hint and
          metadata only, never a secret a badge could be cloned from.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

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
                <form action={revokeCredentialAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="credentialId" value={c.id} />
                  <input type="hidden" name="employmentId" value={employmentId} />
                  <input name="reason" required placeholder="Reason to revoke" className={`${INPUT} w-40`} />
                  <button
                    type="submit"
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Revoke
                  </button>
                </form>
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
        <form action={enrolCardAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="employmentId" value={employmentId} />
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Card id</span>
            <input name="cardId" required autoFocus placeholder="Scan or type" className={`${INPUT} w-56`} />
          </label>
          <button type="submit" className={BTN}>
            Enrol card
          </button>
        </form>
      </section>

      <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
        <h2 className="font-medium text-amber-900 dark:text-amber-200">
          Enrol a fingerprint — not a working capture flow
        </h2>
        <p className="text-xs text-amber-800 dark:text-amber-300">
          ⚠️ There is no fingerprint reader wired into this app anywhere — that needs the native
          reader in the APK D2 parked. This form accepts raw template text, typed or pasted, one per
          line. It is useful only for seeding test data or as a target for a future reader
          integration; it is <strong>not</strong> how a real fingerprint gets enrolled today.
        </p>
        <form action={enrolFingerprintAction} className="space-y-2">
          <input type="hidden" name="employmentId" value={employmentId} />
          <textarea
            name="templates"
            rows={3}
            placeholder={`Up to ${MAX_TEMPLATES} templates, one per line`}
            className="w-full rounded border border-amber-300 bg-white p-2 font-mono text-xs dark:border-amber-800 dark:bg-neutral-950"
          />
          <button
            type="submit"
            className="rounded border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-neutral-950 dark:text-amber-200 dark:hover:bg-neutral-900"
          >
            Enrol fingerprint (test/dev only)
          </button>
        </form>
      </section>
    </Page>
  );
}
