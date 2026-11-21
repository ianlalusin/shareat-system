/// <reference types="react/canary" />
import * as React from 'react';

/**
 * T-602 S3: React's per-request `cache`, or a straight call-through where React has none (vitest, scripts).
 * React scopes `cache` to ONE server request; it is never module state, so nothing is shared between requests or people.
 * Use it only for page-level READS (the session lookup, the held-capability set). Never wrap `authorize()` / `can()` or an action's own checks.
 */
// shortcut: outside a React server render (vitest, scripts) this calls straight through with no memo; correct, only slower.
export const requestMemo: typeof React.cache = typeof React.cache === 'function' ? React.cache : ((fn) => fn);
