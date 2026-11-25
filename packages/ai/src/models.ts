/**
 * T-640 - the models an admin may pick, as a LIST IN CODE (never typed: a mistyped model name took v1's Ask ERP down on 2026-08-20).
 * Adding or retiring a model is a change to this file. A listed model is still unusable until its Test call passes on the Settings screen.
 *
 * Prices are US cents per one million tokens, as published by each provider when this was written. They are what the cost in pesos is
 * worked out from, so a price change at a provider is a change here; check them before relying on the monthly cap for a new model.
 */
import type { AiProvider } from './types';

export interface CatalogueModel {
  readonly provider: AiProvider;
  readonly model: string;
  readonly label: string;
  readonly centsPerMillionIn: number;
  readonly centsPerMillionOut: number;
}

export const MODEL_CATALOGUE: readonly CatalogueModel[] = [
  { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast, low cost)', centsPerMillionIn: 100, centsPerMillionOut: 500 },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (stronger)', centsPerMillionIn: 300, centsPerMillionOut: 1500 },
  { provider: 'google', model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (lowest cost)', centsPerMillionIn: 10, centsPerMillionOut: 40 },
  { provider: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (fast, low cost)', centsPerMillionIn: 30, centsPerMillionOut: 250 },
  { provider: 'google', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (stronger)', centsPerMillionIn: 125, centsPerMillionOut: 1000 },
  { provider: 'openai', model: 'gpt-4o-mini', label: 'GPT-4o mini (lowest cost)', centsPerMillionIn: 15, centsPerMillionOut: 60 },
  { provider: 'openai', model: 'gpt-4.1-mini', label: 'GPT-4.1 mini (fast, low cost)', centsPerMillionIn: 40, centsPerMillionOut: 160 },
  { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1 (stronger)', centsPerMillionIn: 200, centsPerMillionOut: 800 },
];

export function catalogueModel(provider: string, model: string): CatalogueModel | undefined {
  return MODEL_CATALOGUE.find((m) => m.provider === provider && m.model === model);
}

export function modelsOf(provider: AiProvider): readonly CatalogueModel[] {
  return MODEL_CATALOGUE.filter((m) => m.provider === provider);
}
