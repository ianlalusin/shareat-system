/**
 * T-389 (DEF-617): the fixed-asset forms that keep what was typed after a refused save. Not a `'use server'` file, so
 * the page and the actions import the same definitions. Only user-editable controls: never assetId, filterStore or
 * confirmedPlan. The two forms share the asset id as their record and carry DIFFERENT form keys, so a refusal of one
 * never reopens the other.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** Depreciation terms. The record is the asset id. */
export const ASSET_TERMS_EDIT = defineTypedForm({
  form: 'asset.terms',
  fields: ['name', 'category', 'usefulLifeMonths', 'interval', 'salvageValue', 'notes'],
});

/** In-service date. The record is the asset id. Only the plain-error branch keeps typing; the confirm checkpoint keeps its T-380 keep keys. */
export const ASSET_IN_SERVICE_EDIT = defineTypedForm({
  form: 'asset.inService',
  fields: ['mode', 'inServiceOn', 'reason'],
});
