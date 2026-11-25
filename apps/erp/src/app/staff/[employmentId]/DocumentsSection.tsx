import type { IssuedDocumentSummary } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { ACTION_LINK } from '@/components/action-link';
import { Badge } from '@/components/ui';

/**
 * T-584 - the documents issued for this employment, on the staff page. Shown only to someone who may read documents at this store (the page passes null
 * otherwise). Each number opens the document, where it can be printed again. A void document stays in the list, marked void.
 */
export function DocumentsSection({ documents }: { documents: IssuedDocumentSummary[] | null }) {
  if (documents === null) return null;
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="font-medium">Documents</h2>
      {documents.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing has been issued for this person.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <a href={`/documents/${d.id}`} className={`${ACTION_LINK} font-mono`}>
                {d.number}
              </a>
              <span>
                {d.templateName} · {d.kindName} · version {d.currentVersionNo}
              </span>
              <span className="text-muted">{formatBusinessDateTime(d.issuedAt, { dateStyle: 'medium' })}</span>
              {d.voided && <Badge tone="danger" label="VOID" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
