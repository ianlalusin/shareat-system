/**
 * T-389: the issue and revise forms keep what was typed after a refused save. Not a `'use server'` file, so the pages and the actions import one definition.
 * The issue form's record is the template's id (a refused Issue is the common case: a gap left in the wording); the revise form's record is the document's id.
 * The signing form keeps nothing: it asks for a PIN, which is never kept.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const DOCUMENT_ISSUE = defineTypedForm({ form: 'documents.issue', fields: ['body'] });
export const DOCUMENT_REVISE = defineTypedForm({ form: 'documents.revise', fields: ['body', 'reason'] });
