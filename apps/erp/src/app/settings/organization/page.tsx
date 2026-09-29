import { requirePageAccess } from '../../../lib/page-access';
import { setOrganizationIdentityAction } from './actions';
import { identityView } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Organisation — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  ok?: string;
  error?: string;
}

/**
 * `/settings/organization`. T-229 slice 4 — **DEF-208's remedy.**
 *
 * ⭐ **This closes a replatform LOSS, not a missing screen.** v1 records a legal name, a TIN and a
 * tax type on every store (`admin/stores/store-editor.tsx:56-70`, section "Identity & Tax"); v2
 * carried none of them across. A statutory identifier that exists in the live system today had
 * nowhere in v2 to land.
 *
 * ⭐ **The placement is corrected on the way back in.** In PH a corporation holds ONE TIN and each
 * branch carries a code against it, so the organisation owns the registered name, the TIN and the
 * tax type, and each store owns its branch code and trading address. v1 put all of it on every
 * store because v1 had no organisation entity — copying that would be one number in seven places
 * to go wrong, the failure discovery 23 §1 already recorded for `taxType` across ERP and POS.
 *
 * ⚠️ **NOTHING HERE IS A COMPLIANCE FEATURE, and it must not grow into one.** Bible §13 row 75:
 * this is a management ledger, never a statutory filing basis, and no output may be labelled or
 * exported as BIR-ready. The tax type computes nothing — there is no VAT engine — and these fields
 * exist so a document can print the right identity.
 *
 * ⭐ **Why the columns are nullable and this banner exists instead.** A `NOT NULL` TIN would assert
 * that the system cannot represent a business without one, and would make an organisation
 * un-creatable before somebody looks the number up — inverting `bootstrap-org.ts`'s first step. So
 * the database permits an incomplete identity and the SCREEN is what insists: it names exactly what
 * is unset and what it costs, the same shape `/settings/wastage-monitor` uses.
 */
export default async function OrganizationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/settings/organization');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const identity = await identityView(actor);

  const missing = [
    identity.legalName ? null : 'registered name',
    identity.tin ? null : 'TIN',
    identity.taxType ? null : 'tax type',
  ].filter((x): x is string => x !== null);

  return (
    <Page density="form">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className="underline">
            Settings
          </a>{' '}
          / Organisation
        </p>
        <h1 className="text-2xl font-semibold">Organisation</h1>
        <PageDescription>
          The registered identity the books are kept under — what a document printed from this
          system should carry. Each branch&apos;s own address and TIN branch code live on{' '}
          <a href="/admin/stores" className="underline">
            its store
          </a>
          .
        </PageDescription>
      </div>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      {/* ⭐ The insistence the nullable columns deliberately do not provide. */}
      {missing.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong>
            This organisation has no {missing.join(', no ')} recorded.
          </strong>{' '}
          Anything printed from these books will carry the trading name{' '}
          <strong>{identity.name}</strong> and nothing else — which is not the identity the business
          is registered under.
        </div>
      )}

      <form action={setOrganizationIdentityAction} className="space-y-4 text-sm">
        <label className="block">
          <span className="text-neutral-600 dark:text-neutral-400">
            Registered name{' '}
            <span className="text-neutral-400">
              — the everyday name stays &ldquo;{identity.name}&rdquo;
            </span>
          </span>
          <input
            name="legalName"
            defaultValue={identity.legalName ?? ''}
            placeholder="Shareat Food Corporation"
            className={`${FIELD} mt-1 w-full max-w-md`}
          />
        </label>

        <label className="block">
          <span className="text-neutral-600 dark:text-neutral-400">
            TIN <span className="text-neutral-400">— digits; dashes are fine and are removed</span>
          </span>
          <input
            name="tin"
            defaultValue={identity.tin ?? ''}
            inputMode="numeric"
            placeholder="123-456-789"
            className={`${FIELD} mt-1 w-full max-w-xs tabular-nums`}
          />
        </label>

        <label className="block">
          <span className="text-neutral-600 dark:text-neutral-400">Tax type</span>
          <select name="taxType" defaultValue={identity.taxType ?? ''} className={`${FIELD} mt-1`}>
            {/* ⭐ A real choice, not a placeholder: blank means "not stated" and is stored as null. */}
            <option value="">— not stated —</option>
            <option value="vat">VAT-registered</option>
            <option value="non_vat">Non-VAT</option>
          </select>
        </label>

        <button type="submit" className={BTN}>
          Save
        </button>
      </form>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ⚠️ These books are a <strong>management record, not a statutory filing basis</strong>.
        Recording a tax type here changes nothing that is calculated — no VAT is computed from it —
        and nothing produced by this system should be treated as a BIR submission.
      </p>
    </Page>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
