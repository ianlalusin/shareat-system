/**
 * T-389: the kind-rename form keeps what was typed after a refused save (a duplicate name, say). Not a `'use server'` file, so the page and the action import one definition.
 * The record is the kind's id. (The template editor keeps its own typing in the browser: its save returns the refusal instead of redirecting.)
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const DOCUMENT_KIND_EDIT = defineTypedForm({ form: 'documents.kind', fields: ['name'] });
