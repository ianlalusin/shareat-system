'use client';
/** T-440 - the check context. `null` outside any checked form, so a stray ruled Field or a plain SubmitButton changes nothing. */
import { createContext } from 'react';
import type { CheckCtx } from './check-state';

export const CheckContext = createContext<CheckCtx | null>(null);
