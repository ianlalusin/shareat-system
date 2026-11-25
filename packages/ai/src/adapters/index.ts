/** T-640 - the provider adapters, by name. A new provider is a new file here plus its name in `AI_PROVIDERS` and its models in `MODEL_CATALOGUE`. */
import type { AiAdapter, AiProvider } from '../types';
import { anthropicAdapter } from './anthropic';
import { googleAdapter } from './google';
import { openaiAdapter } from './openai';

const ADAPTERS: Readonly<Record<AiProvider, AiAdapter>> = {
  anthropic: anthropicAdapter,
  google: googleAdapter,
  openai: openaiAdapter,
};

export function adapterFor(provider: AiProvider): AiAdapter {
  return ADAPTERS[provider];
}

export { anthropicAdapter, googleAdapter, openaiAdapter };
