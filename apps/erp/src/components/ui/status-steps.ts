/**
 * Stage -> step mapping for StatusHero (T-387 S6). Pure: no React, no I/O.
 *
 * A step list is the chevron row; a stage or status is turned into the index of the current step. An unknown stage,
 * side, kind or status THROWS (never blank, NaN or -1): a state with no step is a bug the page must not hide.
 *
 * Exits (rejected, cancelled, void) carry a fixed fallback index here ("where it left" when no timestamp says more);
 * `exitStepFromTimestamps` refines it from the columns the record really has (L10: only columns that exist).
 */
export const branchOrderSteps = ['draft', 'submitted', 'accepted', 'ready', 'dispatched', 'received'] as const;
export const deliverySteps = ['draft', 'received'] as const;
/** No 'submitted': trade orders have no submittedAt column (L10). */
export const tradeOrderSteps = ['draft', 'confirmed', 'dispatched', 'received'] as const;

export type BranchExitStage = 'rejected' | 'cancelled';
export type OrderSide = 'branch' | 'commissary';

const EXIT_INDEX: Readonly<Record<BranchExitStage, number>> = { rejected: 1, cancelled: 0 };

const has = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export function isExitStage(stage: string): boolean {
  if (stage === 'rejected' || stage === 'cancelled') return true;
  if ((branchOrderSteps as readonly string[]).includes(stage)) return false;
  throw new Error(`isExitStage: unknown stage ${JSON.stringify(stage)}`);
}

/** Index of the current step for a branch-order stage; for an exit, the fixed fallback index. */
export function stepIndexFor(stage: string): number {
  const i = (branchOrderSteps as readonly string[]).indexOf(stage);
  if (i >= 0) return i;
  if (has(EXIT_INDEX, stage)) return EXIT_INDEX[stage as BranchExitStage];
  throw new Error(`stepIndexFor: unknown stage ${JSON.stringify(stage)}`);
}

const NEXT_LINE: Readonly<Record<string, Readonly<Record<OrderSide, string>>>> = {
  draft: {
    branch: 'Add your lines, then submit the order to the commissary.',
    commissary: 'The branch is still drafting this order.',
  },
  submitted: {
    branch: 'Waiting for the commissary to accept this order.',
    commissary: 'Review the lines, then accept or reject the order.',
  },
  accepted: {
    branch: 'The commissary is packing your order.',
    commissary: 'Pack the lines, then mark the order ready.',
  },
  ready: {
    branch: 'Your order is packed and waiting to be dispatched.',
    commissary: 'Dispatch the order when the goods are ready to leave.',
  },
  dispatched: {
    branch: 'On its way. Count the goods and receive the order.',
    commissary: 'Dispatched. Waiting for the branch to receive it.',
  },
  received: {
    branch: 'Received. This order is complete.',
    commissary: 'Received by the branch. This order is complete.',
  },
  rejected: {
    branch: 'The commissary rejected this order. You can order again.',
    commissary: 'You rejected this order. The branch can order again.',
  },
  cancelled: {
    branch: 'This order was cancelled. You can order again.',
    commissary: 'This order was cancelled.',
  },
};

export function nextLineFor(stage: string, side: string): string {
  if (!has(NEXT_LINE, stage)) throw new Error(`nextLineFor: unknown stage ${JSON.stringify(stage)}`);
  if (side !== 'branch' && side !== 'commissary') throw new Error(`nextLineFor: unknown side ${JSON.stringify(side)}`);
  return (NEXT_LINE[stage] as Readonly<Record<OrderSide, string>>)[side];
}

const SIMPLE: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  delivery: { draft: 0, received: 1, void: 0 },
  trade: { draft: 0, confirmed: 1, dispatched: 2, received: 3, void: 0 },
};

/** Delivery / trade-order status -> step index. `void` is an exit: the fixed fallback is the first step. */
export function simpleStepIndexFor(kind: string, status: string): number {
  if (!has(SIMPLE, kind)) throw new Error(`simpleStepIndexFor: unknown kind ${JSON.stringify(kind)}`);
  const statuses = SIMPLE[kind] as Readonly<Record<string, number>>;
  if (!has(statuses, status)) throw new Error(`simpleStepIndexFor: unknown ${kind} status ${JSON.stringify(status)}`);
  return statuses[status] as number;
}

export type ExitTimestamps = {
  readonly acceptedAt?: Date | string | null;
  readonly readyAt?: Date | string | null;
  readonly dispatchedAt?: Date | string | null;
  readonly receivedAt?: Date | string | null;
};

/**
 * Where a rejected / cancelled / void record left, from the furthest timestamp it actually has: the index of the
 * furthest step reached (that cell and every later one render exited). When no timestamp says more, `fallback`
 * (the fixed convention from `stepIndexFor` / `simpleStepIndexFor`) is returned. `branch` reads accepted / ready /
 * dispatched / received; `trade` reads dispatched / received only (no accepted or ready step there: L10).
 */
export function exitStepFromTimestamps(kind: 'branch' | 'trade', ts: ExitTimestamps, fallback: number): number {
  if (kind !== 'branch' && kind !== 'trade') throw new Error(`exitStepFromTimestamps: unknown kind ${JSON.stringify(kind)}`);
  const steps: readonly string[] = kind === 'branch' ? branchOrderSteps : tradeOrderSteps;
  const reached: Array<[string, unknown]> =
    kind === 'branch'
      ? [['received', ts.receivedAt], ['dispatched', ts.dispatchedAt], ['ready', ts.readyAt], ['accepted', ts.acceptedAt]]
      : [['received', ts.receivedAt], ['dispatched', ts.dispatchedAt]];
  for (const [step, at] of reached) {
    if (at) return Math.max(steps.indexOf(step), fallback);
  }
  return fallback;
}
