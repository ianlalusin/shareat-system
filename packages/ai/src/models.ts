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
  // Claude prices: Anthropic first-party rates as of Nov 2026 (Haiku 5.5: $0.10/$0.50 per MTok up to 100K-token prompts; Sonnet 5.5: $2/$10).
  { provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fast, lowest cost)', centsPerMillionIn: 10, centsPerMillionOut: 50 },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (stronger)', centsPerMillionIn: 200, centsPerMillionOut: 1000 },
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
