/**
 * T-389 (DEF-617): the registered-identity form keeps what was typed after a refused save. Not a 'use server'
 * file, so the page and the action import one definition. A per-organisation singleton, so the record is ''.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const ORGANIZATION_IDENTITY = defineTypedForm({
  form: 'organization.identity',
  fields: ['legalName', 'tin', 'taxType'],
  singleton: true,
});
