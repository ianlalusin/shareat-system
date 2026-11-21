import { notFound } from 'next/navigation';
import { ENDED_STATUSES } from '@shareat/db/schema';
import { formatBusinessDateTime, formatBusinessDayLong, toBusinessDate } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import {
  activateAccountAction,
  endEmploymentAction,
  issuePinAction,
  reinstateAccountAction,
  suspendAccountAction,
  removeStaffPhotoAction,
  removeStaffSignatureAction,
  renamePersonAction,
  setGovernmentIdsAction,
  setPositionsAction,
  setStaffPhotoAction,
  setStaffSignatureAction,
} from '../actions';
import { DeductionAgreementsSection } from './DeductionAgreementsSection';
import { Avatar } from './Avatar';
import { RefillForm } from './RefillForm';
import { DocumentsSection } from './DocumentsSection';
import { accessOffAtStoreFor, deductionAgreementsFor, documentsFor, employmentDetail, governmentIdsFor, livePinFor, mediaFor, otherOpenBranchesFor, pinResetPendingFor, positionsForStore } from '../lib';
import { PhotoUpload } from '@/components/upload/PhotoUpload';
import { SignaturePad } from '@/components/SignaturePad';
import { Page } from '@/components/shell/Page';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { staffRoleTitle } from '../role-title';
import { STAFF_END_RULES, STAFF_GOV_ID_RULES, STAFF_PIN_RULES, STAFF_RENAME_RULES, STAFF_SUSPEND_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Badge, Banner, Button, ConfirmDestructive, DialogActions, Field, FlashBanner, FormGrid, FormModal, HelpTip, Input } from '@/components/ui';
import { ActionIcon } from '@/components/ui/action-icons';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { STAFF_POSITIONS, STAFF_RENAME } from '../typed-forms';

export const metadata = { title: 'Employment — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const CARD = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';
const ACCESS_ROW = 'flex min-h-11 items-center justify-between gap-3 py-2';

/** T-612: the account status as a badge and a sentence. `ended` has no button: it is the End employment action, undone by hiring again. */
const ACCOUNT_BADGE = {
  pending: { tone: 'warning', label: 'Pending', note: 'Waiting for a manager to activate this account. They cannot sign in yet.' },
  active: { tone: 'success', label: 'Active', note: 'Can sign in.' },
  suspended: { tone: 'danger', label: 'Suspended', note: 'Paused. Their role and access are kept, but they cannot sign in until you reinstate them.' },
  ended: { tone: 'closed', label: 'Ended', note: 'Access ended. Hire again to restore.' },
} as const;

const capital = (v: string) => {
  const t = v.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0 text-muted">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

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
  const roleOnly = detail.role === 'manager' || detail.role === 'admin' || detail.role === 'super_admin';
  const [positions, livePin, otherBranches, govIds, media, agreements, documents, accessOff, pinReset] = await Promise.all([
    positionsForStore(actor.orgId, detail.employment.storeId),
    livePinFor(actor, detail.employment.personId),
    // ⭐ T-302 — read BEFORE the form renders, because the warning it feeds has to be on screen
    // before the button is pressed, not in a toast after the write.
    otherOpenBranchesFor(actor, detail.employment.personId, detail.employment.storeId),
    // T-190 - personal data, shown only to someone holding enrol_staff at this store (null hides the section).
    governmentIdsFor(actor, detail.employment.personId, detail.employment.storeId),
    mediaFor(actor, employmentId),
    deductionAgreementsFor(actor, detail.employment.personId, detail.employment.storeId),
    // T-584: documents issued for this employment; null (hidden) without view_documents at the store.
    documentsFor(actor, employmentId, detail.employment.storeId),
    // T-609: an ended employment shows whether the person's access is really off here.
    isEnded ? accessOffAtStoreFor(actor, detail.employment.personId, detail.employment.storeId) : Promise.resolve(false),
    // T-619: a promotion retired the PIN; say so until a new one is set.
    pinResetPendingFor(actor, detail.employment.personId),
  ]);
  const assignedIds = new Set(detail.positions.map((p) => p.positionId));
  const primaryId = detail.positions.find((p) => p.isPrimary)?.positionId;
  const typedName = typedFor(sp, STAFF_RENAME, employmentId, actor.personId);
  const typedPositions = typedFor(sp, STAFF_POSITIONS, employmentId, actor.personId);
  // Every assigned position, primary first; "(primary)" only says something when there is more than one.
  const ordered = [...detail.positions].sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary));
  const positionsText = ordered.map((p) => (p.isPrimary && ordered.length > 1 ? `${p.name} (primary)` : p.name)).join(', ');
  const editPositions = !isEnded && (roleOnly ? detail.positions.length > 0 : true);
  const rest = [detail.storeName, capital(detail.employment.employmentStatus), `Started ${formatBusinessDayLong(detail.employment.startedOn)}`]
    .map((t) => ` · ${t}`)
    .join('');

  const account = ACCOUNT_BADGE[detail.accountStatus];
  const statePills = (
    <>
      {isEnded ? (
        <Badge tone="closed" label={`Ended on ${formatBusinessDayLong(detail.employment.endedOn!)}`} />
      ) : (
        <Badge tone={account.tone} label={account.label} />
      )}
      {!isEnded && !livePin && <Badge tone="warning" label="No sign-in PIN" />}
      {isEnded && accessOff && <Badge tone="closed" label="Access: off" />}
    </>
  );

  return (
    <Page view="detail" sectioned density="table">
      <div className="space-y-2">
        <a href="/staff" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Staff
        </a>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-center gap-4">
            {isEnded ? (
              <Avatar name={detail.personName} photoFileId={media.photoFileId} />
            ) : (
              <FormModal
                trigger={
                  <>
                    <Avatar name={detail.personName} photoFileId={media.photoFileId} inLink />
                    <span aria-hidden="true" className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-canvas ring-2 ring-surface">
                      <ActionIcon name="camera" size={14} />
                    </span>
                  </>
                }
                triggerLabel="Change photo"
                triggerVariant="ghost"
                triggerClassName="relative h-16 w-16 shrink-0 !border-0 !p-0"
                title="Staff photo"
                size="md"
              >
                <div className="space-y-3">
                  <p className="text-sm text-muted">Prints on the ID card.</p>
                  <form action={setStaffPhotoAction} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="employmentId" value={employmentId} />
                    <PhotoUpload
                      name="photo"
                      purpose="staff_photo"
                      label="Staff photo"
                      capture="user"
                      storeId={detail.employment.storeId}
                      existing={media.photoFileId ? { fileId: media.photoFileId, kind: 'image' } : undefined}
                    />
                    <Button type="submit" variant="primary">
                      Save photo
                    </Button>
                  </form>
                  {media.photoFileId && (
                    <form action={removeStaffPhotoAction}>
                      <input type="hidden" name="employmentId" value={employmentId} />
                      <Button type="submit" variant="secondary" icon={null}>Remove photo</Button>
                    </form>
                  )}
                </div>
              </FormModal>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold">{detail.personName}</h1>
                {!isEnded && (
                  <FormModal
                    trigger="Edit name"
                    triggerVariant="ghost"
                    triggerClassName="-my-2 h-11 w-11 min-h-11 min-w-11 !bg-transparent !text-muted hover:!bg-canvas hover:!text-ink"
                    title="Edit name"
                    size="md"
                    defaultOpen={typedName !== null}
                  >
                    <CheckedForm rules={STAFF_RENAME_RULES} action={renamePersonAction} className="space-y-3">
                      <RefillForm formKey={STAFF_RENAME.form} typed={typedName} />
                      <input type="hidden" name="employmentId" value={employmentId} />
                      {detail.nameParts.lastName === null && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          {`Saved as "${detail.personName}" in one box. Type the last, first and middle name to split it; it then reads "Last, First M.".`}
                        </p>
                      )}
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
                      <DialogActions>
                        <Button type="submit" variant="primary">Save</Button>
                      </DialogActions>
                    </CheckedForm>
                  </FormModal>
                )}
                {statePills}
              </div>
              <div className="flex flex-wrap items-center gap-x-1 text-sm text-neutral-500 dark:text-neutral-400">
                {roleOnly ? (
                  <span>{staffRoleTitle(detail.role, null)}</span>
                ) : detail.positions.length === 0 ? (
                  <span className="text-muted">No position yet</span>
                ) : (
                  <span>{positionsText}</span>
                )}
                {editPositions && (
                  <FormModal
                    trigger="Edit positions"
                    triggerVariant="ghost"
                    triggerClassName="-my-2 h-11 w-11 min-h-11 min-w-11 !bg-transparent !text-muted hover:!bg-canvas hover:!text-ink"
                    title="Edit positions"
                    size="md"
                    defaultOpen={!roleOnly && typedPositions !== null}
                  >
                    {roleOnly ? (
                      <div className="space-y-3 text-sm">
                        <p className="text-muted">This role does not need a staff position. Access continues to follow the role and store scope.</p>
                        <form action={setPositionsAction} className="space-y-2">
                          <input type="hidden" name="employmentId" value={employmentId} />
                          <p className="text-xs text-muted">Previous assignments: {detail.positions.map((p) => p.name).join(', ')}.</p>
                          <Button type="submit" variant="secondary">Remove staff positions</Button>
                        </form>
                      </div>
                    ) : (
                      <form action={setPositionsAction} className="space-y-3">
                        <RefillForm formKey={STAFF_POSITIONS.form} typed={typedPositions} />
                        <input type="hidden" name="employmentId" value={employmentId} />
                        <div className="space-y-2">
                          {positions.map((p) => (
                            <div key={p.id} className="flex items-center gap-3 text-sm">
                              <label className="flex items-center gap-2">
                                <input type="checkbox" name="positionIds" value={p.id} defaultChecked={assignedIds.has(p.id)} className="h-4 w-4" />
                                {p.name}
                              </label>
                              <label className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                                <input type="radio" name="primaryPositionId" value={p.id} defaultChecked={primaryId === p.id} />
                                primary
                              </label>
                            </div>
                          ))}
                        </div>
                        <DialogActions>
                          <Button type="submit" variant="primary">Save</Button>
                        </DialogActions>
                      </form>
                    )}
                  </FormModal>
                )}
                <span>{rest}</span>
              </div>
              <p className="text-xs text-muted">Staff code {detail.employment.staffCode}</p>
            </div>
          </div>
          {!isEnded && (
            /*
              ⛔ T-302 — the warning sits BEFORE the field on purpose. A person now holds ONE PIN for the
              whole organisation, so issuing one here changes the six digits they type at every other
              store too. A confirmation after the write would not be a control, and "this affects
              somewhere else" is not something an admin can act on — so it names the stores.
            */
            <FormModal
              trigger={livePin ? 'Re-issue PIN' : 'Issue PIN'}
              triggerVariant={livePin ? 'secondary' : 'primary'}
              triggerIcon={null}
              title={livePin ? 'Re-issue sign-in PIN' : 'Issue sign-in PIN'}
              size="md"
            >
              <div className="space-y-3">
                {otherBranches.branches.length + otherBranches.hiddenCount > 0 && (
                  <Banner tone="warning">
                    This person works at{' '}
                    <strong>
                      {[detail.storeName, ...otherBranches.branches.map((b) => b.storeName)].join(', ')}
                      {otherBranches.hiddenCount > 0 &&
                        ` and ${otherBranches.hiddenCount} other store${otherBranches.hiddenCount === 1 ? '' : 's'}`}
                    </strong>. They have one PIN
                    for the whole business, so issuing a new one here{' '}
                    <strong>changes the PIN they use there too</strong>. Tell them the new digits before
                    their next shift at any of these stores.
                  </Banner>
                )}
                <CheckedForm rules={STAFF_PIN_RULES} action={issuePinAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="employmentId" value={employmentId} />
                  <Field label={`${livePin ? 'New PIN' : 'PIN'} (6 digits)`} rule={STAFF_PIN_RULES.pin} className="flex-1 sm:min-w-48">
                    <Input {...nativeAttrs(STAFF_PIN_RULES.pin)} placeholder="000000" className="w-full font-mono" />
                  </Field>
                  <Button type="submit" variant="primary">
                    {livePin ? 'Re-issue PIN' : 'Issue PIN'}
                  </Button>
                </CheckedForm>
                {livePin && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Re-issuing replaces the current PIN and signs this person out everywhere right now, not only at {detail.storeName}.
                  </p>
                )}
              </div>
            </FormModal>
          )}
        </div>
        {isEnded && (
          <p className="inline-block rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            This employment has ended. The record stays visible; ending is not deleting.
          </p>
        )}
      </div>

      <FlashBanner flash={sp} />

      <div className="grid gap-6 lg:grid-cols-3 xl:gap-4">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {govIds && (
            <section className={CARD}>
              <h2 className="font-medium">
                Government numbers
                <HelpTip label="Government numbers">
                  Payroll deducts SSS, PhilHealth and Pag-IBIG only for an agency whose number is filled in here. A blank box means that agency is
                  not deducted from this person&rsquo;s payslips (and nothing is caught up later). Digits only; dashes and spaces are ignored.
                </HelpTip>
              </h2>
              <EditableRecord action={setGovernmentIdsAction} label="government numbers"
                // Personal data: the page never shows these numbers while locked, so the summary says only whether one is on file.
                summary={[
                  { label: 'SSS number', value: govIds.sssNo ? 'On file' : null },
                  { label: 'PhilHealth number', value: govIds.philhealthNo ? 'On file' : null },
                  { label: 'Pag-IBIG number', value: govIds.pagibigNo ? 'On file' : null },
                  { label: 'TIN', value: govIds.tin ? 'On file' : null },
                ]}
                hidden={{ employmentId }} typed={null} rules={STAFF_GOV_ID_RULES}>
                <FormGrid layout="pairs">
                  <Field width="code" label="SSS number" hint="10 digits" rule={STAFF_GOV_ID_RULES.sssNo}>
                    <Input {...nativeAttrs(STAFF_GOV_ID_RULES.sssNo)} defaultValue={govIds.sssNo ?? ''} className="w-full font-mono" />
                  </Field>
                  <Field width="code" label="PhilHealth number" hint="12 digits" rule={STAFF_GOV_ID_RULES.philhealthNo}>
                    <Input {...nativeAttrs(STAFF_GOV_ID_RULES.philhealthNo)} defaultValue={govIds.philhealthNo ?? ''} className="w-full font-mono" />
                  </Field>
                  <Field width="code" label="Pag-IBIG number" hint="12 digits" rule={STAFF_GOV_ID_RULES.pagibigNo}>
                    <Input {...nativeAttrs(STAFF_GOV_ID_RULES.pagibigNo)} defaultValue={govIds.pagibigNo ?? ''} className="w-full font-mono" />
                  </Field>
                  <Field width="code" label="TIN" hint="9 to 12 digits" rule={STAFF_GOV_ID_RULES.tin}>
                    <Input {...nativeAttrs(STAFF_GOV_ID_RULES.tin)} defaultValue={govIds.tin ?? ''} className="w-full font-mono" />
                  </Field>
                </FormGrid>
              </EditableRecord>
            </section>
          )}

          <DeductionAgreementsSection view={agreements} employmentId={employmentId} storeId={detail.employment.storeId} />

          <DocumentsSection documents={documents} />
        </div>

        <div className="min-w-0 space-y-4">
          <section className={CARD}>
            <h2 className="font-medium">Access</h2>
            <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
              <li className={ACCESS_ROW}>
                <span className="min-w-0">
                  <span className="block font-medium">Sign-in PIN</span>
                  {livePin ? (
                    <span className="block text-neutral-600 dark:text-neutral-400">
                      Issued {formatBusinessDateTime(livePin.issuedAt, { dateStyle: 'long' })}
                    </span>
                  ) : (
                    isEnded ? (
                      <span className="block text-muted">Not needed — this employment has ended</span>
                    ) : (
                      <span className="block text-warning-ink">
                        {pinReset ? 'PIN reset: set a new PIN. Their role was raised, so the old PIN no longer works.' : 'Not issued — this person cannot sign in'}
                      </span>
                    )
                  )}
                </span>
              </li>
              <li className={ACCESS_ROW}>
                <span className="min-w-0">
                  <span className="block font-medium">Account: {account.label}</span>
                  <span className="block text-neutral-600 dark:text-neutral-400">{account.note}</span>
                  {detail.accountStatus === 'pending' && !livePin && <span className="block text-warning-ink">Set a PIN so they can sign in.</span>}
                </span>
                {detail.canManageAccount && detail.accountStatus === 'pending' && (
                  <form action={activateAccountAction}>
                    <input type="hidden" name="employmentId" value={employmentId} />
                    <Button type="submit" variant="primary">Activate</Button>
                  </form>
                )}
                {detail.canManageAccount && detail.accountStatus === 'suspended' && (
                  <form action={reinstateAccountAction}>
                    <input type="hidden" name="employmentId" value={employmentId} />
                    <Button type="submit" variant="primary">Reinstate</Button>
                  </form>
                )}
                {detail.canManageAccount && detail.accountStatus === 'active' && !detail.isSelf && (
                  <FormModal trigger="Suspend" triggerVariant="danger" triggerIcon={null} title="Suspend account" size="md">
                    <CheckedForm rules={STAFF_SUSPEND_RULES} action={suspendAccountAction} className="space-y-3">
                      <input type="hidden" name="employmentId" value={employmentId} />
                      <Field label="Reason" rule={STAFF_SUSPEND_RULES.reason}>
                        <Input {...nativeAttrs(STAFF_SUSPEND_RULES.reason)} placeholder="Why is this account being suspended?" className="w-full" />
                      </Field>
                      <ConfirmDestructive
                        tier="retype"
                        label="Suspend account"
                        consequence="Signs them out now and blocks sign-in. Their role and access are kept, paused; Reinstate restores them exactly."
                        expectedName={detail.personName}
                      />
                    </CheckedForm>
                  </FormModal>
                )}
              </li>
              <li>
                <a href={`/admin/users/${detail.employment.personId}`} className={`${ACCESS_ROW} no-underline`}>
                  <span className="min-w-0">
                    <span className="block font-medium">Role and access</span>
                    <span className="block text-neutral-600 dark:text-neutral-400">Which screens they can open</span>
                  </span>
                  <Chevron />
                </a>
              </li>
              <li>
                <a href={`/staff/${employmentId}/credentials`} className={`${ACCESS_ROW} no-underline`}>
                  <span className="min-w-0 font-medium">Clock-in card and fingerprint</span>
                  <Chevron />
                </a>
              </li>
            </ul>
          </section>

          <section className={CARD}>
            <h2 className="font-medium">Signature</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Prints on payslips and cash forms.</p>
            <div className="space-y-2 text-sm">
              {!media.hasSignature && <p className="text-neutral-500 dark:text-neutral-400">No signature on file.</p>}
              {media.hasSignature && !media.signatureFileId && <p>Signature on file.</p>}
              {!isEnded ? (
                <SignaturePad
                  personId={detail.employment.personId}
                  employmentId={employmentId}
                  action={setStaffSignatureAction}
                  signatureFileId={media.signatureFileId}
                />
              ) : (
                <SignaturePad
                  personId={detail.employment.personId}
                  employmentId={employmentId}
                  action={setStaffSignatureAction}
                  signatureFileId={media.signatureFileId}
                  readOnly
                />
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
        </div>
      </div>

      <section className={CARD}>
        {isEnded ? (
          <>
            <h2 className="font-medium">End employment</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Ended {formatBusinessDayLong(detail.employment.endedOn!)} as {detail.employment.employmentStatus.replace(/-/g, ' ')}.
            </p>
            {accessOff && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Access: off. To switch it back on, hire them again, then set a new PIN. A former manager or administrator comes back as staff; an administrator gives the role again. Extra access an administrator gave by hand is not brought back; an administrator grants it again.
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h2 className="font-medium">End employment</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                The record stays visible. An administrator approves with their own PIN.
              </p>
            </div>
            <FormModal trigger="End employment" triggerVariant="danger" triggerIcon={null} title="End employment" size="md">
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
                        {capital(s)}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="basis-full text-sm text-neutral-700 dark:text-neutral-300">
                  {otherBranches.branches.length + otherBranches.hiddenCount > 0
                    ? `This signs them out of ${detail.storeName} and removes their access there. Their PIN and access at their other store${otherBranches.branches.length + otherBranches.hiddenCount === 1 ? '' : 's'} stay.`
                    : `This signs them out everywhere and removes their PIN, role and all access, at ${detail.storeName} and every other store.`}
                </p>
                <ConfirmDestructive
                  tier="admin-pin"
                  label="End employment"
                  consequence={
                    otherBranches.branches.length + otherBranches.hiddenCount > 0
                      ? `Ends this employment and removes their access at ${detail.storeName}. The record stays visible. An administrator must approve with their own PIN.`
                      : 'Ends this employment, signs them out everywhere and removes their PIN, role and all access. The record stays visible. An administrator must approve with their own PIN.'
                  }
                />
              </CheckedForm>
            </FormModal>
          </div>
        )}
      </section>
    </Page>
  );
}
