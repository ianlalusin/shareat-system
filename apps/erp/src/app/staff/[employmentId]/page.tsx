import { notFound } from 'next/navigation';
import { ENDED_STATUSES } from '@shareat/db/schema';
import { toBusinessDate } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import {
  endEmploymentAction,
  issuePinAction,
  removeStaffPhotoAction,
  removeStaffSignatureAction,
  renamePersonAction,
  setGovernmentIdsAction,
  setPositionsAction,
  setStaffPhotoAction,
  setStaffSignatureAction,
  viewStaffSignatureAction,
} from '../actions';
import { employmentDetail, governmentIdsFor, livePinFor, mediaFor, otherOpenBranchesFor, positionsForStore } from '../lib';
import { PhotoInput } from '@/components/PhotoInput';
import { SignaturePad } from '@/components/SignaturePad';
import { Page } from '@/components/shell/Page';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { STAFF_END_RULES, STAFF_GOV_ID_RULES, STAFF_PIN_RULES, STAFF_RENAME_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, ConfirmDestructive, Field, FlashBanner, FormGrid, Input } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { STAFF_POSITIONS, STAFF_RENAME } from '../typed-forms';

export const metadata = { title: 'Employment — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export default async function EmploymentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { employmentId } = await params;
  const sp = await withFlash(searchParams);
  // T-435 / bible row 353 - the read gate, then the by-id scope (the same notFound for another store's employment as for a forged id).
  const { actor, refusal } = await requirePageAccess(`/staff/${employmentId}`);
  if (refusal) return refusal;
  const detail = await employmentDetail(actor, employmentId);
  if (!detail) notFound();

  const isEnded = detail.employment.endedOn !== null;
  const [positions, livePin, otherBranches, govIds, media] = await Promise.all([
    positionsForStore(actor.orgId, detail.employment.storeId),
    livePinFor(actor, detail.employment.personId),
    // ⭐ T-302 — read BEFORE the form renders, because the warning it feeds has to be on screen
    // before the button is pressed, not in a toast after the write.
    otherOpenBranchesFor(actor, detail.employment.personId, detail.employment.storeId),
    // T-190 - personal data, shown only to someone holding enrol_staff at this store (null hides the section).
    governmentIdsFor(actor, detail.employment.personId, detail.employment.storeId),
    mediaFor(actor, employmentId),
  ]);
  const assignedIds = new Set(detail.positions.map((p) => p.positionId));
  const primaryId = detail.positions.find((p) => p.isPrimary)?.positionId;

  return (
    <Page density="table">
      <div>
        <a href="/staff" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Staff
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{detail.personName}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          <span className="font-mono text-xs">{detail.employment.staffCode}</span> ·{' '}
          {detail.storeName} · {detail.employment.employmentStatus.replace(/-/g, ' ')} · started{' '}
          {detail.employment.startedOn}
          {isEnded && ` · ended ${detail.employment.endedOn}`}
        </p>
        {isEnded && (
          <p className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            This employment has ended. The record stays visible — ending is not deleting (T-154
            invariant 4).
          </p>
        )}
      </div>

      <FlashBanner flash={sp} />

      {!isEnded && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Name</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {detail.nameParts.lastName === null
              ? `Saved as "${detail.personName}" (one box, from before names were split). Type the last, first and middle name once to fix it; it then reads "Last, First M.".`
              : 'Shown everywhere as "Last, First M.". Saving rewrites it.'}
          </p>
          <EditableRecord action={renamePersonAction} label="name" hidden={{ employmentId }} typed={typedFor(sp, STAFF_RENAME, employmentId, actor.personId)} rules={STAFF_RENAME_RULES}>
            <FormGrid>
              <Field label="Last name" rule={STAFF_RENAME_RULES.lastName}>
                <Input {...nativeAttrs(STAFF_RENAME_RULES.lastName)} defaultValue={detail.nameParts.lastName ?? ''} className="mt-1 w-full" />
              </Field>
              <Field label="First name" rule={STAFF_RENAME_RULES.firstName}>
                <Input {...nativeAttrs(STAFF_RENAME_RULES.firstName)} defaultValue={detail.nameParts.firstName ?? ''} className="mt-1 w-full" />
              </Field>
              <Field label="Middle name (optional)">
                <Input name="middleName" defaultValue={detail.nameParts.middleName ?? ''} className="mt-1 w-full" />
              </Field>
            </FormGrid>
          </EditableRecord>
        </section>
      )}

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Positions</h2>
        {isEnded ? (
          <ul className="flex flex-wrap gap-2 text-sm">
            {detail.positions.length === 0 ? (
              <li className="text-neutral-500 dark:text-neutral-400">None assigned.</li>
            ) : (
              detail.positions.map((p) => (
                <li
                  key={p.positionId}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
                >
                  {p.name}
                  {p.isPrimary && <span className="ml-1 text-xs text-neutral-400">(primary)</span>}
                </li>
              ))
            )}
          </ul>
        ) : (
          <EditableRecord action={setPositionsAction} label="positions" hidden={{ employmentId }} typed={typedFor(sp, STAFF_POSITIONS, employmentId, actor.personId)}>
            <div className="space-y-2">
            {positions.map((p) => (
              <div key={p.id} className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="positionIds"
                    value={p.id}
                    defaultChecked={assignedIds.has(p.id)}
                    className="h-4 w-4"
                  />
                  {p.name}
                </label>
                <label className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                  <input type="radio" name="primaryPositionId" value={p.id} defaultChecked={primaryId === p.id} />
                  primary
                </label>
              </div>
            ))}
            </div>
          </EditableRecord>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Sign-in PIN</h2>
        {livePin ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Issued {livePin.issuedAt.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}. One
            PIN per person — it signs them in at every branch they work at, not only{' '}
            {detail.storeName}.
          </p>
        ) : (
          <p className="text-sm text-warning-ink">
            No sign-in PIN issued yet — this person cannot sign in.
          </p>
        )}
        {/*
          ⛔ T-302 — the warning sits BEFORE the form on purpose. A person now holds ONE PIN for the
          whole organisation, so issuing one here changes the six digits they type at every other
          branch too. A confirmation after the write would not be a control, and "this affects
          somewhere else" is not something an admin can act on — so it names the branches.
        */}
        {!isEnded && otherBranches.branches.length + otherBranches.hiddenCount > 0 && (
          <Banner tone="warning">
            ⚠️ This person works at{' '}
            <strong>
              {[detail.storeName, ...otherBranches.branches.map((b) => b.storeName)].join(', ')}
              {otherBranches.hiddenCount > 0 &&
                ` and ${otherBranches.hiddenCount} other branch${otherBranches.hiddenCount === 1 ? '' : 'es'}`}
            </strong>. They have one PIN
            for the whole business, so issuing a new one here{' '}
            <strong>changes the PIN they use there too</strong> — tell them the new digits before
            their next shift at either branch.
          </Banner>
        )}
        {!isEnded && (
          <CheckedForm rules={STAFF_PIN_RULES} action={issuePinAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="employmentId" value={employmentId} />
            <Field label={`${livePin ? 'New PIN' : 'PIN'} (6 digits)`} rule={STAFF_PIN_RULES.pin} className="flex-1 sm:min-w-48">
              <Input {...nativeAttrs(STAFF_PIN_RULES.pin)} placeholder="000000" className="w-full font-mono" />
            </Field>
            <Button type="submit" variant="primary">
              {livePin ? 'Re-issue PIN' : 'Issue PIN'}
            </Button>
          </CheckedForm>
        )}
        {livePin && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Re-issuing replaces the current PIN and ends this person&rsquo;s live sessions
            everywhere, right now — not only at {detail.storeName}.
          </p>
        )}
      </section>

      {govIds && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Government numbers</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Payroll deducts SSS, PhilHealth and Pag-IBIG only for an agency whose number is filled in here. A blank box means that agency is
            not deducted from this person&rsquo;s payslips (and nothing is caught up later). Digits only; dashes and spaces are ignored.
          </p>
          <EditableRecord action={setGovernmentIdsAction} label="government numbers" hidden={{ employmentId }} typed={null} rules={STAFF_GOV_ID_RULES}>
            <FormGrid>
              <Field label="SSS number (10 digits)" rule={STAFF_GOV_ID_RULES.sssNo}>
                <Input {...nativeAttrs(STAFF_GOV_ID_RULES.sssNo)} defaultValue={govIds.sssNo ?? ''} className="w-full font-mono" />
              </Field>
              <Field label="PhilHealth number (12 digits)" rule={STAFF_GOV_ID_RULES.philhealthNo}>
                <Input {...nativeAttrs(STAFF_GOV_ID_RULES.philhealthNo)} defaultValue={govIds.philhealthNo ?? ''} className="w-full font-mono" />
              </Field>
              <Field label="Pag-IBIG number (12 digits)" rule={STAFF_GOV_ID_RULES.pagibigNo}>
                <Input {...nativeAttrs(STAFF_GOV_ID_RULES.pagibigNo)} defaultValue={govIds.pagibigNo ?? ''} className="w-full font-mono" />
              </Field>
              <Field label="TIN (9 to 12 digits)" rule={STAFF_GOV_ID_RULES.tin}>
                <Input {...nativeAttrs(STAFF_GOV_ID_RULES.tin)} defaultValue={govIds.tin ?? ''} className="w-full font-mono" />
              </Field>
            </FormGrid>
          </EditableRecord>
        </section>
      )}

      <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Role and access</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          A sign-in PIN lets this person authenticate; their <em>role</em> is what decides whether
          any screen will serve them. Role, store scope and capability grants belong to the person,
          not to this employment (one person can hold two), so they live on their own screen.
        </p>
        <a
          href={`/admin/users/${detail.employment.personId}`}
          className="text-sm underline underline-offset-4"
        >
          Manage role and access →
        </a>
      </section>

      <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Clock-in credentials</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Card and fingerprint enrolment live on their own screen (T-203).
        </p>
        <a href={`/staff/${employmentId}/credentials`} className="text-sm underline underline-offset-4">
          Manage credentials →
        </a>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Photo and signature</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The photo is for this store&rsquo;s ID card. The signature is printed on documents (payslips, cash advance forms); it is not
          an approval, PINs do that. Staff cannot change their own.
        </p>
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">Photo</h3>
          {media.photoFileId ? (
            <a href={`/files/${media.photoFileId}`} className="inline-block py-1 underline underline-offset-4">
              View photo
            </a>
          ) : (
            <p className="text-neutral-500 dark:text-neutral-400">No photo on file.</p>
          )}
          {!isEnded && (
            <form action={setStaffPhotoAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="employmentId" value={employmentId} />
              <PhotoInput name="photo" required accept="image/*" capture="user" />
              <Button type="submit" variant="primary">
                {media.photoFileId ? 'Replace photo' : 'Save photo'}
              </Button>
            </form>
          )}
          {!isEnded && media.photoFileId && (
            <form action={removeStaffPhotoAction}>
              <input type="hidden" name="employmentId" value={employmentId} />
              <Button type="submit">Remove photo</Button>
            </form>
          )}
        </div>
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">Signature</h3>
          {media.hasSignature ? (
            <p>Signature on file.</p>
          ) : (
            <p className="text-neutral-500 dark:text-neutral-400">No signature on file.</p>
          )}
          {media.hasSignature && media.canViewSignature && (
            <form action={viewStaffSignatureAction}>
              <input type="hidden" name="employmentId" value={employmentId} />
              <input type="hidden" name="personId" value={detail.employment.personId} />
              <Button type="submit">View signature</Button>
              <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">Each view is recorded. The link lasts one minute.</span>
            </form>
          )}
          {!isEnded && (
            <SignaturePad personId={detail.employment.personId} employmentId={employmentId} action={setStaffSignatureAction} />
          )}
          {!isEnded && media.hasSignature && (
            <form action={removeStaffSignatureAction}>
              <input type="hidden" name="employmentId" value={employmentId} />
              <input type="hidden" name="personId" value={detail.employment.personId} />
              <Button type="submit">Remove signature</Button>
            </form>
          )}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">End employment</h2>
        {isEnded ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Ended {detail.employment.endedOn} as {detail.employment.employmentStatus.replace(/-/g, ' ')}.
          </p>
        ) : (
          <CheckedForm rules={STAFF_END_RULES} action={endEmploymentAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="employmentId" value={employmentId} />
            <Field label="End date" rule={STAFF_END_RULES.endedOn} className="flex-1 sm:min-w-48">
              <Input type="date" {...nativeAttrs(STAFF_END_RULES.endedOn)} defaultValue={toBusinessDate()} className="w-full" />
            </Field>
            <Field label="Status" rule={STAFF_END_RULES.employmentStatus} className="flex-1 sm:min-w-48">
              <select {...nativeAttrs(STAFF_END_RULES.employmentStatus)} defaultValue="" className={`${INPUT} mt-1 w-full`}>
                <option value="" disabled>
                  Select
                </option>
                {ENDED_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <ConfirmDestructive
              tier="admin-pin"
              label="End employment"
              consequence="Ends this employment. The record stays visible. An administrator must approve with their own PIN."
            />
          </CheckedForm>
        )}
      </section>
    </Page>
  );
}
