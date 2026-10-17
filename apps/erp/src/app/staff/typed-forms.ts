/**
 * T-389 (DEF-617): the positions form keeps what was ticked after a refused save. Not a 'use server' file, so the
 * page and the action import one definition. The record is the employment id; never the hidden employmentId.
 * Nothing here is a credential: the Issue-PIN form on the same page is a command and is never kept.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const STAFF_POSITIONS = defineTypedForm({
  form: 'staff.positions',
  fields: ['positionIds', 'primaryPositionId'],
});

/** T-438 S2b: the Name form keeps what was typed after a refused save (a person's name is not a secret). */
export const STAFF_RENAME = defineTypedForm({
  form: 'staff.rename',
  fields: ['lastName', 'firstName', 'middleName'],
});
