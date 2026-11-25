/**
 * @shareat/ai - T-640. The ONLY code that talks to a model provider: adapters (plain HTTPS), the model list, prices, the privacy guard and
 * the key cipher. Nothing here touches the database or knows about people or stores: `packages/domain/src/ai` owns who may do what,
 * the caps, the priority order and the call log, and calls this.
 */
export * from './types';
export * from './errors';
export * from './http';
export * from './models';
export * from './pricing';
export * from './crypto';
