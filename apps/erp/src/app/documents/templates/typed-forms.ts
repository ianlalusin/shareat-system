/**
 * T-389: the template form keeps what was typed after a refused save. Not a `'use server'` file, so the page and the action import one definition.
 * The record is the template's id; the "new template" form is the record `new`.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const DOCUMENT_TEMPLATE_EDIT = defineTypedForm({
  form: 'documents.template',
  fields: ['name', 'kindId', 'body', 'slot'],
});

export const NEW_TEMPLATE_RECORD = 'new';
