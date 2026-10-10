import { requirePageAccess } from '../../../lib/page-access';
import { setOrganizationIdentityAction } from './actions';
import { identityView } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { EditableRecord } from '@/components/forms';
import { Banner, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';

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
  const sp = await withFlash(searchParams);
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
    <Page density="table">
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

      <FlashBanner flash={sp} />

      {/* ⭐ The insistence the nullable columns deliberately do not provide. */}
      {missing.length > 0 && (
        <Banner tone="warning">
          <strong>
            This organisation has no {missing.join(', no ')} recorded.
          </strong>{' '}
          Anything printed from these books will carry the trading name{' '}
          <strong>{identity.name}</strong> and nothing else — which is not the identity the business
          is registered under.
        </Banner>
      )}

      <EditableRecord action={setOrganizationIdentityAction} label="Organisation" hidden={{}}>
        <FormGrid className="text-sm">
          <Field
            span="full"
            label={
              <span className="text-neutral-600 dark:text-neutral-400">
                Registered name{' '}
                <span className="text-neutral-400">
                  — the everyday name stays &ldquo;{identity.name}&rdquo;
                </span>
              </span>
            }
          >
            <Input
              name="legalName"
              defaultValue={identity.legalName ?? ''}
              placeholder="Shareat Food Corporation"
              className="mt-1 w-full"
            />
          </Field>

          <Field
            label={
              <span className="text-neutral-600 dark:text-neutral-400">
                TIN <span className="text-neutral-400">— digits; dashes are fine and are removed</span>
              </span>
            }
          >
            <Input
              name="tin"
              defaultValue={identity.tin ?? ''}
              inputMode="numeric"
              placeholder="123-456-789"
              className="mt-1 w-full tabular-nums"
            />
          </Field>

          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Tax type</span>}>
            <Select name="taxType" defaultValue={identity.taxType ?? ''} className="mt-1 w-full">
              {/* ⭐ A real choice, not a placeholder: blank means "not stated" and is stored as null. */}
              <option value="">— not stated —</option>
              <option value="vat">VAT-registered</option>
              <option value="non_vat">Non-VAT</option>
            </Select>
          </Field>
        </FormGrid>
      </EditableRecord>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ⚠️ These books are a <strong>management record, not a statutory filing basis</strong>.
        Recording a tax type here changes nothing that is calculated — no VAT is computed from it —
        and nothing produced by this system should be treated as a BIR submission.
      </p>
    </Page>
  );
}
