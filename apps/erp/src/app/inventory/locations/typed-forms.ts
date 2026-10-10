/**
 * T-389 S4 (DEF-617): the room edit form keeps what was typed after a refused save. Not a `'use server'` file.
 * Only user-editable controls: never the hidden storeId or id. The record is the room id.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const LOCATION_EDIT = defineTypedForm({ form: 'location.edit', fields: ['name', 'typeId', 'role'] });
