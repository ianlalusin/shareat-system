/** T-640 - the AI hub. The screen (Settings > AI hub) reads and writes through `hub.ts`; features call `callAi` (S2). */
export { getAiHubView, saveProviderKey, removeProviderKey, activateAiModel, deactivateAiModel, moveAiModel, saveAiSettings, setAiStoreSwitch } from './hub';
export type { AiHubView, AiModelView, AiProviderView, AiUsageLine } from './hub';
export type { HubDeps, MasterKeyState, TxRunner, UsageLevel } from './shared';
