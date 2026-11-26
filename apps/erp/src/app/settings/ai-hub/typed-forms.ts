/**
 * T-640: the AI limits form keeps what was typed after a refused save. Not a 'use server' file, so the page and the action import one definition.
 * A per-organisation singleton. ⛔ The KEY form is deliberately NOT here: a provider key is never kept anywhere after a refusal, not even in the one-minute flash.
 */
import { defineTypedForm } from '@/lib/keep-typing';

export const AI_SETTINGS_EDIT = defineTypedForm({
  form: 'settings.aiHub',
  fields: ['enabled', 'monthlyCapPesos', 'dailyLimitPerPerson', 'pesosPerUsd', 'warnAtPercent'],
  singleton: true,
});
