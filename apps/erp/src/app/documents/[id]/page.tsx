import { notFound } from 'next/navigation';
import { can } from '@shareat/auth';
import { getIssuedDocument, SLOT_WORDS, type IssuedDocumentVersion } from '@shareat/domain';
import { DOCUMENT_REASON_RULES, DOCUMENT_SIGN_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import type { SignatureSlot } from '@shareat/db/schema';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { typedFor } from '../../../lib/keep-typing';
import { DocumentBlock } from '@/components/documents/DocumentDoc';
import { WordingField } from '@/components/documents/WordingField';
import { validateDoc } from '@shareat/domain/documents/doc';
import { reviseDocumentAction, signDocumentAction, voidDocumentAction } from '../actions';
import { withOrgPrincipal } from '../lib';
import { DOCUMENT_REVISE } from '../typed-forms';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { Badge, Button, ConfirmDestructive, Field, FlashBanner, FormGrid, Input, Textarea } from '@/components/ui';

export const metadata = { title: 'Document — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/documents/[id]`. T-584 S3 and S4.
 *
 * One issued document: its current wording, the signatures it needs and has, and its history. A signature is added only when its owner types their OWN
 * Employee ID and PIN; the saved signature is copied then, so a later change to it does not alter this document. Changing the wording saves a NEW
 * version (same number) and every signature is needed again; every earlier version and its signatures stay below. A void document stays here, marked void.
 */
export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/documents/${id}`);
  if (refusal) return refusal;
  if (!UUID.test(id)) notFound();

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    let got;
    try {
      got = await getIssuedDocument(tx, actor, id);
    } catch (err) {
      // A permission refusal and a missing document read the same: the framework's 404, so a guessed id learns nothing (the print page does the same).
      if (err instanceof Error && (err.name === 'AuthorizationError' || err.name === 'RefusalError')) return null;
      throw err;
    }
    const d = got.document;
    const canIssue = d.storeId ? await can(tx, actor, 'issue_documents', { storeId: d.storeId }) : await can(tx, actor, 'manage_document_templates', {});
    return { got, canIssue } as const;
  });
  if (!loaded) notFound();
  const { got, canIssue } = loaded;
  const { document: doc, versions } = got;
  const current = versions[0]!;
  // After a revision the server turned down, the editor reopens with what was typed (when it was small enough to keep).
  const typedRevision = typedFor(sp, DOCUMENT_REVISE, doc.id, actor.personId);
  const revisedDoc = typedRevision?.kind === 'typed' && typeof typedRevision.fields.bodyDoc === 'string' ? safeDoc(typedRevision.fields.bodyDoc) : null;
  const open = !doc.voided;

  return (
    <Page view="detail" sectioned density="table" className="space-y-6">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/documents" className={ACTION_LINK}>
            Documents
          </a>{' '}
          / {doc.number}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{doc.number}</h1>
          {doc.voided && <Badge tone="danger" label="VOID" />}
        </div>
        <p className="mt-1 text-sm text-muted">
          {doc.templateName} · {current.letterhead.kindName ?? doc.kindName} · Version {current.versionNo} of {doc.number} · for {doc.employeeName ?? 'no one in particular'} · {doc.storeName ?? 'whole company'}
        </p>
        <p className="text-sm text-muted">
          Issued {formatBusinessDateTime(doc.issuedAt)} by {doc.issuedByName}
          {doc.voided && doc.voidedAt ? ` · Voided ${formatBusinessDateTime(doc.voidedAt)} by ${doc.voidedByName ?? 'someone'}: ${doc.voidReason ?? ''}` : ''}
        </p>
        <p className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <a href={`/documents/${doc.id}/print`} target="_blank" rel="noopener" className={ACTION_LINK}>
            Print or save as PDF
          </a>
        </p>
      </div>

      <FlashBanner flash={sp} />

      <article className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <DocumentBlock doc={current.doc} />
      </article>

      {doc.signatureSlots.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Signatures on version {current.versionNo}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {doc.signatureSlots.map((slot) => (
              <SignatureCard key={slot} slot={slot} documentId={doc.id} version={current} open={open} waitingFor={slot === 'issuer' ? current.createdByName : (doc.employeeName ?? 'the employee')} />
            ))}
          </div>
        </section>
      )}

      {open && canIssue && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-lg font-semibold">Change this document</h2>
          <p className="text-sm text-muted">
            Saving makes version {current.versionNo + 1} of {doc.number}. Every signature is needed again; version {current.versionNo} and its signatures stay in the history.
          </p>
          <EditableRecord
            action={reviseDocumentAction}
            label={`${doc.number} wording`}
            hidden={{ documentId: doc.id }}
            editText="Change the wording"
            rules={DOCUMENT_REASON_RULES}
            typed={typedRevision}
          >
            <Field label="Wording" span="full">
              <WordingField name="bodyDoc" label="Wording" initialDoc={revisedDoc ?? current.doc} />
            </Field>
            <Field label="Why is it changing?" span="full" hint="Kept with the new version. At most 500 characters." rule={DOCUMENT_REASON_RULES.reason}>
              <Textarea {...nativeAttrs(DOCUMENT_REASON_RULES.reason)} rows={2} defaultValue="" className="w-full" />
            </Field>
          </EditableRecord>
        </section>
      )}

      {open && canIssue && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-lg font-semibold">Void this document</h2>
          <p className="text-sm text-muted">Use this when it was issued by mistake. It stays in the register marked void, and its print says VOID. It cannot be changed or signed afterwards.</p>
          <CheckedForm rules={DOCUMENT_REASON_RULES} action={voidDocumentAction} className="space-y-3 text-sm">
            <input type="hidden" name="documentId" value={doc.id} />
            <Field label="Why is it void?" span="full" hint="At most 500 characters." rule={DOCUMENT_REASON_RULES.reason}>
              <Textarea {...nativeAttrs(DOCUMENT_REASON_RULES.reason)} rows={2} defaultValue="" className="w-full" />
            </Field>
            <ConfirmDestructive tier="retype" label="Void document" consequence={`${doc.number} will be marked void everywhere. This cannot be undone.`} expectedName={doc.number} />
          </CheckedForm>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">History</h2>
        <ul className="space-y-4 text-sm">
          {versions.map((v) => (
            <li key={v.id} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <p className="font-medium">
                Version {v.versionNo} {v.versionNo === current.versionNo && <Badge tone="info" label="Current" />}
              </p>
              <p className="text-muted">
                {formatBusinessDateTime(v.createdAt)} · {v.createdByName}
                {v.reason ? ` · Why: ${v.reason}` : ''}
              </p>
              <p className="text-muted">
                {v.signatures.length === 0
                  ? 'Not signed'
                  : `Signed: ${v.signatures.map((s) => `${SLOT_WORDS[s.slot]} ${s.personName} (${formatBusinessDateTime(s.signedAt, { dateStyle: 'medium' })})`).join(', ')}`}
              </p>
              <p className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
                <a href={`/documents/${doc.id}/print?v=${v.versionNo}`} target="_blank" rel="noopener" className={ACTION_LINK}>
                  Print version {v.versionNo}
                </a>
              </p>
              {v.versionNo !== current.versionNo && (
                <details className="mt-2">
                  <summary className="inline-flex min-h-8 cursor-pointer items-center text-neutral-600 dark:text-neutral-400">Show the wording of version {v.versionNo}</summary>
                  <DocumentBlock doc={v.doc} className="mt-2" />
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}

function SignatureCard({ slot, documentId, version, open, waitingFor }: { slot: SignatureSlot; documentId: string; version: IssuedDocumentVersion; open: boolean; waitingFor: string }) {
  const signed = version.signatures.find((s) => s.slot === slot);
  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <h3 className="font-medium">{SLOT_WORDS[slot]} signature</h3>
      {signed ? (
        <>
          {/* The image comes through a route that checks view_documents at this document's store; a plain <img> keeps it a normal GET. */}
          <img src={`/documents/signature/${signed.id}`} alt={`Signature of ${signed.personName}`} className="h-20 max-w-full object-contain" />
          <p>
            Signed by {signed.personName}, {formatBusinessDateTime(signed.signedAt)}
          </p>
        </>
      ) : !open ? (
        <p className="text-muted">Not signed.</p>
      ) : (
        <CheckedForm rules={DOCUMENT_SIGN_RULES} action={signDocumentAction} className="space-y-3">
          <input type="hidden" name="documentId" value={documentId} />
          <input type="hidden" name="slot" value={slot} />
          <input type="hidden" name="versionNo" value={String(version.versionNo)} />
          <p className="text-muted">
            Waiting for {waitingFor}. They type their own Employee ID and PIN to add their saved signature.
          </p>
          <FormGrid>
            <Field label="Employee ID" rule={DOCUMENT_SIGN_RULES.employeeId} hint="The number on the staff badge, for example 7. Leave empty if there is none.">
              <Input {...nativeAttrs(DOCUMENT_SIGN_RULES.employeeId)} name="employeeId" autoComplete="off" className="w-full" />
            </Field>
            <Field label="PIN" rule={DOCUMENT_SIGN_RULES.pin}>
              <Input {...nativeAttrs(DOCUMENT_SIGN_RULES.pin)} type="password" autoComplete="off" className="w-full" />
            </Field>
          </FormGrid>
          <Button type="submit" variant="primary">
            Sign
          </Button>
        </CheckedForm>
      )}
    </div>
  );
}

function safeDoc(raw: string) {
  try {
    const c = validateDoc(JSON.parse(raw));
    return c.ok ? c.doc : null;
  } catch {
    return null;
  }
}
