/** Pure label/ARIA state for SubmitButton (T-387 S2). No React, so it is unit-testable. */
export interface SubmitButtonStateInput {
  readonly pending: boolean;
  readonly label: string;
  readonly pendingLabel?: string;
}

export interface SubmitButtonState {
  readonly label: string;
  readonly ariaBusy: boolean;
  readonly disabled: boolean;
}

export const DEFAULT_PENDING_LABEL = 'Saving…';

export function submitButtonState(input: SubmitButtonStateInput): SubmitButtonState {
  if (!input.pending) return { label: input.label, ariaBusy: false, disabled: false };
  return { label: input.pendingLabel ?? DEFAULT_PENDING_LABEL, ariaBusy: true, disabled: true };
}
