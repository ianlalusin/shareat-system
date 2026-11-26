'use client';
/**
 * The wording of a document being issued or revised. T-637. The document editor with no field tags (the wording is already filled), carrying its document to the server as JSON in a
 * hidden input of the surrounding form. The server judges it against the same whitelist as a template; a `[missing: x]` gap left in it blocks issue.
 */
import { useState } from 'react';
import type { DocJson } from '@shareat/domain/documents/doc';
import { DocumentEditor } from './DocumentEditor';

export function WordingField({ name, initialDoc, label }: { name: string; initialDoc: DocJson; label: string }) {
  const [doc, setDoc] = useState<DocJson>(initialDoc);
  return (
    <div>
      <input type="hidden" name={name} value={JSON.stringify(doc)} />
      <DocumentEditor label={label} fields={false} initialDoc={initialDoc} onChange={setDoc} />
    </div>
  );
}
