/**
 * The twelve steps of the 31 December conversion, and the four gates between them. T-134.
 *
 * ⭐ **A pure declaration**, so the ordering and the gates can be reasoned about — and tested —
 * without a database. `index.ts` is what asks the ledger whether each one holds.
 */

export type StepKind = 'verified' | 'attested' | 'performed';
export type Phase = 'A' | 'B' | 'C';

export interface StepDef {
  code: string;
  phase: Phase;
  title: string;
  kind: StepKind;
  /** One row PER STORE. ⭐ A single tick across four stores hides the store nobody visited. */
  perStore: boolean;
  why: string;
  /**
   * ⚠️ Set when the step is declared ✅ in the spec but **this database cannot check it**, with
   * the reason. It then behaves as attested, and says so rather than showing a green tick it has
   * not earned.
   */
  cannotVerifyHere?: string;
}

export const CUTOVER_STEPS: readonly StepDef[] = [
  // ---------------------------------------------------------------- Phase A — in v1, in December
  {
    code: 'A1',
    phase: 'A',
    title: 'Clear the delivery-expensing backlog',
    kind: 'verified',
    perStore: false,
    why:
      'ADR-009: the cost basis is weakest for exactly the stock being valued. Counting first ' +
      'prices the newest — and only — stock at nothing. ⭐ That inversion took COUNTING to find; ' +
      'nobody would have reasoned their way to it, which is why A1 → B1 is a hard gate.',
    cannotVerifyHere:
      'The check is over v1 deliveries, and v2 holds no v1 data — it opens from a zero starting ' +
      'point by design. Recorded as an attestation here, and it renders as one.',
  },
  {
    code: 'A2',
    phase: 'A',
    title: 'Final v1 depreciation run',
    kind: 'verified',
    perStore: false,
    why: 'It lands directly in the opening balance. DEF-044 proved it stops silently.',
    cannotVerifyHere:
      'The check is over v1 depreciation legs, which v2 never holds. ⚠️ v2’s own equivalent IS ' +
      'machine-checked — T-135’s depreciationNotBooked — but that watches v2, not v1.',
  },
  {
    code: 'A3',
    phase: 'A',
    title: 'Reconcile every cash and bank account to 31 December',
    kind: 'attested',
    perStore: false,
    why:
      'Partial transfers are a named top-of-list migration failure, and an unreconciled bank ' +
      'account is the classic one skipped. It was implicit inside the export step — and implicit ' +
      'is how a step gets missed.',
  },
  {
    code: 'A4',
    phase: 'A',
    title: 'Export May–December figures',
    kind: 'attested',
    perStore: false,
    why:
      'Feeds the 2026 spreadsheet (ADR-005). ⚠️ Legacy basis, unaudited — and it stays a ' +
      'spreadsheet, never a comparatives screen.',
  },

  // ---------------------------------------------------------------- Phase B — 31 December
  {
    code: 'B1',
    phase: 'B',
    title: 'Valued stock count',
    kind: 'attested',
    perStore: true,
    why: 'Four attestations, not one. ⭐ A single tick hides a store nobody visited.',
  },
  {
    code: 'B2',
    phase: 'B',
    title: 'Asset walk-round',
    kind: 'attested',
    perStore: true,
    why:
      'Confirms existence AND remaining useful life — without which v2 cannot depreciate ' +
      'anything at all.',
  },
  {
    code: 'B3',
    phase: 'B',
    title: 'Enter counted quantities',
    kind: 'verified',
    perStore: true,
    why:
      '⭐ An item silently absent is indistinguishable from an item counted as zero. The check ' +
      'demands a row for every active item, so a zero has to be entered on purpose.',
  },

  // ---------------------------------------------------------------- Phase C — 1 January
  {
    code: 'C1',
    phase: 'C',
    title: 'Backup taken and restore REHEARSED',
    kind: 'attested',
    perStore: false,
    why: 'Bible §15.8. ⚠️ "A backup was taken" is not the claim that matters — a restore that ran is.',
  },
  {
    code: 'C2',
    phase: 'C',
    title: 'Run the purge',
    kind: 'performed',
    perStore: false,
    why: 'Dry-run first, always. Post-conditions assert inside the transaction (T-119).',
  },
  {
    code: 'C3',
    phase: 'C',
    title: 'Enter opening balances',
    kind: 'performed',
    perStore: false,
    why:
      '⭐ A mutable DRAFT built up over days, not one sitting — fourteen suppliers were never ' +
      'going to be entered at once. The running residual is visible throughout.',
  },
  {
    code: 'C4',
    phase: 'C',
    title: '3900 nets to exactly zero',
    kind: 'verified',
    perStore: false,
    why:
      '⛔ A residual HALTS. There is no plug account and no code path that creates one. ' +
      'Auto-plugging is the majority behaviour in the field and it is scale-driven — those ' +
      'vendors serve millions of self-serve tenants who cannot get a human’s attention. One ' +
      'company, one cutover, Ian personally available: none of that applies.',
  },
  {
    code: 'C5',
    phase: 'C',
    title: 'Trial balance ties, then POST',
    kind: 'performed',
    perStore: false,
    why: 'Posting is what makes C3 immutable. The books are open.',
  },
] as const;

/**
 * ⭐ **The ONLY enforced ordering.** Four gates, each already argued for by an existing ADR or
 * defect.
 *
 * ⚠️ A blanket "no step starts until its prerequisites verify" rule would be **stricter than every
 * system studied** — Xero's steps are freely re-editable, ERPNext locks nothing, Odoo has no
 * ordering check at all — and it would be stricter for no evidenced reason. A2/A3/A4 are free
 * among themselves, B1/B2 likewise, and all four stores are independent.
 */
export const CUTOVER_GATES: readonly { after: string; before: string; because: string }[] = [
  {
    after: 'A1',
    before: 'B1',
    because:
      'ADR-009. Counting before the delivery-expensing backlog is cleared prices the newest stock ' +
      'at nothing, and the inversion took counting to find.',
  },
  {
    after: 'C2',
    before: 'C3',
    because:
      'Opening balances entered into a database still holding pilot data are meaningless, not ' +
      'merely risky.',
  },
  { after: 'C3', before: 'C4', because: 'The check has nothing to check against otherwise.' },
  { after: 'C4', before: 'C5', because: "ADR-005's own stated order." },
] as const;

export function stepDef(code: string): StepDef | undefined {
  return CUTOVER_STEPS.find((s) => s.code === code);
}

/** The gates standing in front of this step, if any. */
export function gatesBefore(code: string): readonly { after: string; before: string; because: string }[] {
  return CUTOVER_GATES.filter((g) => g.before === code);
}
