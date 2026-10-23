import {
  ATTENDANCE_LEAVE_RECORD_RULES,
  ATTENDANCE_LEAVE_REQUEST_RULES,
  ATTENDANCE_LEAVE_VOID_RULES,
  nativeAttrs,
} from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import {
  groupByRequest,
  holdsManageAttendance,
  labelFor,
  listStores,
  loadBalanceOf,
  loadMine,
  loadProofFileId,
  loadRequestDetail,
  loadRoster,
  loadStoreLeave,
  type RequestGroup,
} from './lib';
import {
  approveLeaveAction,
  attachLeaveDocumentAction,
  cancelLeaveAction,
  recordLeaveAction,
  rejectLeaveAction,
  requestLeaveAction,
  voidLeaveAction,
} from './actions';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { PhotoUpload } from '@/components/upload/PhotoUpload';
import { CertificateView } from './CertificateView';
import { Badge, Button, Field, FlashBanner, FormGrid, Input, Select, Textarea , FormSection} from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { ACTION_LINK } from '@/components/action-link';

export const metadata = { title: 'Leave — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  from?: string;
  to?: string;
  request?: string;
  ok?: string;
  error?: string;
}


/*
  ⭐ **Leave: ask for a day off, and decide on it.** T-436.

  Everyone sees the top half (their own balance, a request form, their own requests). A manager (anyone holding
  `manage_attendance`) also sees the half below it: what is waiting for a decision, what is approved, and a form to record an absence
  after the fact. Every rule - the monthly and yearly limits, the 5 paid Service Incentive Leave days, "you cannot approve your own
  leave" - is enforced in the domain, not on this page: the page only shows why something was refused.

  ⛔ A medical note and a certificate photo are personal data (bible row 353). The lists below show the KIND of leave only. The
  note is read only on the person's own side of the page, and a certificate is opened only by the certificate viewer (the shared Lightbox),
  which is drawn only when `loadProofFileId` hands this viewer the id; each open leaves a row in the activity log.
*/
export default async function LeavePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/attendance/leave');

  const mine = await loadMine(actor);
  const isManager = await holdsManageAttendance(actor);

  const stores = isManager ? await listStores(actor.orgId) : [];
  const storeId = sp.store || stores[0]?.id;
  const today = toBusinessDate();
  const from = sp.from || `${today.slice(0, 7)}-01`;
  const to = sp.to || addDays(today, 60);

  let groups: RequestGroup[] = [];
  let roster: Awaited<ReturnType<typeof loadRoster>> = [];
  let managerError: string | null = null;
  if (isManager && storeId) {
    try {
      groups = groupByRequest(await loadStoreLeave(actor, { storeId, from, to }));
      roster = await loadRoster(actor, storeId);
    } catch {
      managerError = 'You do not manage attendance at this store, so its leave is not shown.';
    }
  }
  // The certificate id, per request, only for a viewer the T-436 decision lets open it (decide only: no audit row is written here).
  const proofFileIds = new Map<string, string>();
  for (const g of groups) {
    if (!g.hasProof) continue;
    const id = await loadProofFileId(actor, g.requestId);
    if (id) proofFileIds.set(g.requestId, id);
  }
  const pending = groups.filter((g) => g.status === 'pending');
  // The balance a manager needs to decide a pending request: that person's Service Incentive Leave in the year of its first date.
  const balances = new Map<string, { entitlement: number; used: number; remaining: number }>();
  for (const g of pending) {
    const year = Number((g.dates[0] ?? g.restDays[0] ?? today).slice(0, 4));
    const key = `${g.personId}:${year}`;
    if (!balances.has(key)) {
      const b = await loadBalanceOf(actor, g.personId, year);
      if (b) balances.set(key, b);
    }
  }
  // One request in full (the only place a note is shown). A refusal comes back as null: "not available", never a half-view.
  const wanted = sp.request && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.request) ? sp.request : null;
  const detail = wanted ? await loadRequestDetail(actor, wanted) : null;
  const approved = groups.filter((g) => g.status === 'approved');
  const kinds = mine.types;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Leave</h1>
        <PageDescription>
          Ask for a day off, and see where your request stands. Managers decide requests and record absences here. The monthly and yearly
          limits and the 5 paid Service Incentive Leave days are checked when a manager approves.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {wanted && (
        <section className="space-y-2 rounded border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Request details</h2>
          {detail ? (
            <>
              <p className="text-sm">
                {labelFor(mine.types, detail.leaveType)} · <Badge status={detail.status} />
                {detail.hasProof ? <span className="ml-2 text-xs text-neutral-500">Proof attached</span> : null}
              </p>
              <p className="text-xs tabular-nums text-neutral-500">{detail.days.map((d) => d.date).join(', ')}</p>
              <p className="text-sm">
                <span className="text-neutral-500">Reason or note: </span>
                {detail.note ?? 'none'}
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-500">This request is not available to you.</p>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">My leave</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Service Incentive Leave {mine.year}: <strong>{mine.balance.remaining}</strong> of {mine.balance.entitlement} paid days left.
          Unused days are paid out in cash at year end.
        </p>
        {mine.employments.length === 0 ? (
          <p className="rounded border border-dashed border-surface-border p-6 text-center text-sm text-neutral-500">
            You have no open job on record, so there is nothing to request leave against.
          </p>
        ) : (
            <CheckedForm rules={ATTENDANCE_LEAVE_REQUEST_RULES} action={requestLeaveAction} className="space-y-3 rounded border border-surface-border p-4">
              <>
                <FormSection title="Leave request">
                  <FormGrid layout="fields">
                    <div className="min-w-0">
                      {mine.employments.length > 1 ? (
                        <Field label="Job">
                          <Select name="employmentId" className="mt-1 w-full">
                            {mine.employments.map((e) => (
                              <option key={e.employmentId} value={e.employmentId}>
                                {e.storeName}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ) : (
                        <input type="hidden" name="employmentId" value={mine.employments[0]!.employmentId} />
                      )}
                    </div>
                    <div className="min-w-0">
                      <Field label="Kind of leave">
                        <Select name="leaveType" className="mt-1 w-full">
                          {kinds.map((k) => (
                            <option key={k.code} value={k.code}>
                              {k.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  </FormGrid>
                </FormSection>
                <FormSection title="Dates and entitlement">
                  <FormGrid layout="fields">
                    <div className="min-w-0 erp-field-date">
                      <Field rule={ATTENDANCE_LEAVE_REQUEST_RULES.from} label="First day">
                        <Input {...nativeAttrs(ATTENDANCE_LEAVE_REQUEST_RULES.from)}  type="date"  className="mt-1 w-full" />
                      </Field>
                    </div>
                    <div className="min-w-0 erp-field-date">
                      <Field rule={ATTENDANCE_LEAVE_REQUEST_RULES.to} label="Last day" hint="Leave empty for a single day.">
                        <Input {...nativeAttrs(ATTENDANCE_LEAVE_REQUEST_RULES.to)}  type="date" className="mt-1 w-full" />
                      </Field>
                    </div>
                    <div className="min-w-0 erp-field-short">
                      <Field label="Days in that range you have off anyway" hint="Dates like 2026-03-04, 2026-03-05 - not counted as leave." span="wide">
                        <Input name="restDays" className="mt-1 w-full" />
                      </Field>
                    </div>
                    <div className="min-w-0 erp-field-date">
                      <Field rule={ATTENDANCE_LEAVE_REQUEST_RULES.birthDate} label="Date of the birth" hint="Maternity and paternity leave only.">
                        <Input {...nativeAttrs(ATTENDANCE_LEAVE_REQUEST_RULES.birthDate)}  type="date" className="mt-1 w-full" />
                      </Field>
                    </div>
                  </FormGrid>
                </FormSection>
                <FormSection title="Note">
                  <FormGrid layout="fields">
                    <div className="min-w-0 erp-field-long">
                      <Field label="Reason or medical note" hint="Only you and your managers can read this." span="full">
                        <Textarea name="note" rows={2} className="mt-1 w-full" />
                      </Field>
                    </div>
                  </FormGrid>
                </FormSection>
              </>
              <Button type="submit" variant="primary">
                Request leave
              </Button>
            </CheckedForm>
        )}

        {mine.requests.length > 0 && (
          <ul className="space-y-2">
            {mine.requests.map((r) => (
              <li key={r.requestId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-surface-border p-3 text-sm">
                <span>
                  <span className="tabular-nums">
                    {r.firstDate === r.lastDate ? r.firstDate : `${r.firstDate} to ${r.lastDate}`}
                    <span className="text-neutral-500"> ({r.dayCount} d)</span>
                  </span>
                  {' · '}
                  {labelFor(mine.types, r.leaveType)}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge status={r.status} />
                  {r.status === 'approved' && <PayBadge paid={r.paid === true} />}
                  {r.hasProof && <span className="text-xs text-neutral-500">Proof attached</span>}
                  <a href={`/attendance/leave?request=${r.requestId}`} className={ACTION_LINK}>
                    Details
                  </a>
                  {r.status === 'pending' && (
                    <form action={cancelLeaveAction}>
                      <input type="hidden" name="requestId" value={r.requestId} />
                      <Button type="submit" variant="secondary">
                        Cancel
                      </Button>
                    </form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isManager && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Decide leave</h2>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
              Store
              <Select name="store" defaultValue={storeId} className="w-full">
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
              From
              <Input name="from" type="date" defaultValue={from} className="w-full" />
            </label>
            <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
              to
              <Input name="to" type="date" defaultValue={to} className="w-full" />
            </label>
            <Button type="submit" variant="secondary">
              Show
            </Button>
          </form>

          {managerError && <p className="rounded border border-warning p-3 text-sm text-warning-ink">{managerError}</p>}

          {!managerError && storeId && (
            <p>
              <a href={`/attendance/leave/export?store=${storeId}&from=${from}&to=${to}`} className={ACTION_LINK}>
                Download this register as CSV
              </a>
            </p>
          )}

          {!managerError && (
            <>
              <div className="space-y-2">
                <h3 className="font-medium">
                  Waiting for a decision <span className="text-sm font-normal text-neutral-500">({pending.length})</span>
                </h3>
                {pending.length === 0 ? (
                  <p className="rounded border border-dashed border-surface-border p-4 text-center text-sm text-neutral-500">
                    Nothing is waiting in this period.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {pending.map((g) => (
                      <li key={g.requestId} className="space-y-2 rounded border border-warning p-3">
                        <RequestHead group={g} kinds={kinds} />
                        <PendingFacts group={g} balance={balances.get(`${g.personId}:${(g.dates[0] ?? g.restDays[0] ?? today).slice(0, 4)}`)} />
                        <div className="flex flex-wrap items-end gap-3">
                          <form action={approveLeaveAction} className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="requestId" value={g.requestId} />
                            <Select name="pay" defaultValue="" aria-label="Pay">
                              <option value="">Pay as the kind decides</option>
                              <option value="paid">Approve as paid</option>
                              <option value="unpaid">Approve as unpaid</option>
                            </Select>
                            <Button type="submit" variant="primary">
                              Approve
                            </Button>
                          </form>
                          <form action={rejectLeaveAction} className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="requestId" value={g.requestId} />
                            <Input name="reason" placeholder="Reason (optional)" aria-label="Reason" />
                            <Button type="submit" variant="secondary">
                              Reject
                            </Button>
                          </form>
                          <Certificate group={g} storeId={storeId ?? ''} proofFileId={proofFileIds.get(g.requestId) ?? null} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="font-medium">
                  Approved <span className="text-sm font-normal text-neutral-500">({approved.length})</span>
                </h3>
                {approved.length === 0 ? (
                  <p className="rounded border border-dashed border-surface-border p-4 text-center text-sm text-neutral-500">
                    No approved leave in this period.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {approved.map((g) => (
                      <li key={g.requestId} className="space-y-2 rounded border border-surface-border p-3">
                        <RequestHead group={g} kinds={kinds} />
                        <div className="flex flex-wrap items-end gap-3">
                          <CheckedForm rules={ATTENDANCE_LEAVE_VOID_RULES} action={voidLeaveAction} className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="requestId" value={g.requestId} />
                            <Field label="Reason to void" rule={ATTENDANCE_LEAVE_VOID_RULES.reason}>
                              <Input {...nativeAttrs(ATTENDANCE_LEAVE_VOID_RULES.reason)} placeholder="Why void it?" />
                            </Field>
                            <Button type="submit" variant="secondary">
                              Void
                            </Button>
                          </CheckedForm>
                          <Certificate group={g} storeId={storeId ?? ''} proofFileId={proofFileIds.get(g.requestId) ?? null} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <CheckedForm rules={ATTENDANCE_LEAVE_RECORD_RULES} action={recordLeaveAction} className="space-y-3 rounded border border-surface-border p-4">
                <h3 className="font-medium">Record an absence that already happened</h3>
                <FormGrid>
                  <Field label="Person">
                    <Select name="employmentId" className="mt-1 w-full">
                      {roster.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.displayName} ({r.staffCode})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Kind">
                    <Select name="leaveType" className="mt-1 w-full">
                      <option value="no_show">Absent without notice</option>
                      {kinds.map((k) => (
                        <option key={k.code} value={k.code}>
                          {k.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="First day" rule={ATTENDANCE_LEAVE_RECORD_RULES.from}>
                    <Input type="date" {...nativeAttrs(ATTENDANCE_LEAVE_RECORD_RULES.from)} className="mt-1 w-full" />
                  </Field>
                  <Field label="Last day" hint="Leave empty for a single day." rule={ATTENDANCE_LEAVE_RECORD_RULES.to}>
                    <Input type="date" {...nativeAttrs(ATTENDANCE_LEAVE_RECORD_RULES.to)} className="mt-1 w-full" />
                  </Field>
                  <Field label="Pay">
                    <Select name="pay" defaultValue="" className="mt-1 w-full">
                      <option value="">As the kind decides</option>
                      <option value="paid">Paid</option>
                      <option value="unpaid">Unpaid</option>
                    </Select>
                  </Field>
                  <Field label="Date of the birth" hint="Maternity and paternity only." rule={ATTENDANCE_LEAVE_RECORD_RULES.birthDate}>
                    <Input type="date" {...nativeAttrs(ATTENDANCE_LEAVE_RECORD_RULES.birthDate)} className="mt-1 w-full" />
                  </Field>
                  <Field label="Note" hint="Only managers of this store can read it." span="full">
                    <Textarea name="note" rows={2} className="mt-1 w-full" />
                  </Field>
                </FormGrid>
                <Button type="submit" variant="primary">
                  Record absence
                </Button>
              </CheckedForm>
            </>
          )}
        </section>
      )}
    </Page>
  );
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** What the manager needs beside the buttons: the person's paid-leave balance, and where the reason is. */
function PendingFacts({ group, balance }: { group: RequestGroup; balance: { entitlement: number; used: number; remaining: number } | undefined }) {
  return (
    <p className="text-xs text-neutral-500">
      {balance ? `Service Incentive Leave: ${balance.remaining} of ${balance.entitlement} paid days left. ` : ''}
      <a href={`/attendance/leave?request=${group.requestId}`} className={ACTION_LINK}>
        Read the reason
      </a>
    </p>
  );
}

function PayBadge({ paid }: { paid: boolean }) {
  return <Badge tone={paid ? 'success' : 'closed'} label={paid ? 'Paid' : 'Unpaid'} className="ml-2" />;
}

function RequestHead({ group, kinds }: { group: RequestGroup; kinds: readonly { code: string; label: string }[] }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {group.personName} · {labelFor(kinds, group.leaveType)}
        </span>
        <span>
          <Badge status={group.status} />
          {group.status === 'approved' && <PayBadge paid={group.paid} />}
          {group.clash && <Badge tone="warning" label="Punches that day" className="ml-2" />}
        </span>
      </div>
      <p className="text-xs tabular-nums text-neutral-500">
        {group.dates.join(', ') || '—'}
        {group.restDays.length > 0 ? ` · rest days: ${group.restDays.join(', ')}` : ''}
      </p>
    </div>
  );
}

/** Attach a certificate photo (a manager's act) and, when the deciding loader handed over an id, a button that opens it in the Lightbox. */
function Certificate({ group, storeId, proofFileId }: { group: RequestGroup; storeId: string; proofFileId: string | null }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <form action={attachLeaveDocumentAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="requestId" value={group.requestId} />
        <PhotoUpload name="certificate" purpose="leave_document" label="Medical certificate" storeId={storeId} />
        <Button type="submit" variant="secondary">
          Attach certificate
        </Button>
      </form>
      {group.hasProof && !proofFileId && <span className="text-xs text-neutral-500">Proof attached</span>}
      {proofFileId && <CertificateView fileId={proofFileId} />}
    </div>
  );
}
