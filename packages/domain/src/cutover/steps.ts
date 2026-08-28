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
  /**
   * ⚠️ **USER-FACING COPY, rendered on the wizard.** Plain prose only — no ⭐/⚠️/⛔ markers, which
   * are a convention for readers of this source and read as noise to somebody doing a stock count.
   * Found the hard way: they shipped to the screen and were spotted by looking at it.
   */
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
      'What we paid for stock is least reliable for exactly the stock being counted. Counting ' +
      'before the backlog is cleared values the newest — and only — stock at nothing. That is why ' +
      'the count cannot start until this is done.',
    cannotVerifyHere:
      'the check is over deliveries in the old system, and this one deliberately holds none of its ' +
      'history. Somebody has to vouch for it instead.',
  },
  {
    code: 'A2',
    phase: 'A',
    title: 'Final depreciation run in the old system',
    kind: 'verified',
    perStore: false,
    why:
      'It lands directly in the opening balance. This is the run that quietly stopped for two ' +
      'months once before, and only a data check found it.',
    cannotVerifyHere:
      'the check is over depreciation in the old system, which this one never holds. Depreciation ' +
      'in THESE books is checked automatically — but that is a different question.',
  },
  {
    code: 'A3',
    phase: 'A',
    title: 'Reconcile every cash and bank account to 31 December',
    kind: 'attested',
    perStore: false,
    why:
      'A transfer that left one account and never arrived in the other is the commonest way a ' +
      'conversion goes wrong, and an unreconciled bank account is the step most often skipped. It ' +
      'used to be assumed inside the export — and assumed is how a step gets missed.',
  },
  {
    code: 'A4',
    phase: 'A',
    title: 'Export May–December figures',
    kind: 'attested',
    perStore: false,
    why:
      'Feeds the 2026 spreadsheet. These are old-system figures and unaudited, so they stay in a ' +
      'spreadsheet rather than being shown here as if they were part of these books.',
  },

  // ---------------------------------------------------------------- Phase B — 31 December
  {
    code: 'B1',
    phase: 'B',
    title: 'Valued stock count',
    kind: 'attested',
    perStore: true,
    why: 'One confirmation per store, not one for all of them. A single tick hides the store nobody visited.',
  },
  {
    code: 'B2',
    phase: 'B',
    title: 'Asset walk-round',
    kind: 'attested',
    perStore: true,
    why:
      'Confirms the asset is really there, and how much life it has left. Without the remaining ' +
      'life, nothing can be depreciated at all.',
  },
  {
    code: 'B3',
    phase: 'B',
    title: 'Enter counted quantities',
    kind: 'verified',
    perStore: true,
    why:
      'An item nobody counted looks exactly like an item counted as zero, which is how stock goes ' +
      'missing from an opening balance. Every item needs a number, and an empty shelf is a typed ' +
      'zero.',
  },

  // ---------------------------------------------------------------- Phase C — 1 January
  {
    code: 'C1',
    phase: 'C',
    title: 'Backup taken and restore REHEARSED',
    kind: 'attested',
    perStore: false,
    why:
      '"A backup was taken" is not the claim that matters. The one that matters is that a restore ' +
      'was actually run and worked.',
  },
  {
    code: 'C2',
    phase: 'C',
    title: 'Run the purge',
    kind: 'performed',
    perStore: false,
    why: 'Dry-run first, always. The checks run inside the same transaction, so a bad purge undoes itself.',
  },
  {
    code: 'C3',
    phase: 'C',
    title: 'Enter opening balances',
    kind: 'performed',
    perStore: false,
    why:
      'A draft built up over days, not one sitting — fourteen suppliers were never going to be ' +
      'entered at once. The difference still to explain is shown the whole time.',
  },
  {
    code: 'C4',
    phase: 'C',
    title: '3900 nets to exactly zero',
    kind: 'verified',
    perStore: false,
    why:
      'If anything is left over, this stops. Most accounting software would park the difference in ' +
      'a holding account and open the books anyway; that exists for people who cannot ask anyone. ' +
      'A difference here has to be found.',
  },
  {
    code: 'C5',
    phase: 'C',
    title: 'Trial balance ties, then POST',
    kind: 'performed',
    perStore: false,
    why: 'Posting is what makes the opening entry final. After this, the books are open.',
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
      'Counting before the backlog is cleared values the newest stock at nothing, and that only ' +
      'came to light by counting.',
  },
  {
    after: 'C2',
    before: 'C3',
    because:
      'Opening balances entered while the old pilot data is still here are meaningless, not merely ' +
      'risky.',
  },
  { after: 'C3', before: 'C4', because: 'There is nothing to check against until the figures are in.' },
  { after: 'C4', before: 'C5', because: 'The books cannot open on an entry that does not balance.' },
] as const;

export function stepDef(code: string): StepDef | undefined {
  return CUTOVER_STEPS.find((s) => s.code === code);
}

/** The gates standing in front of this step, if any. */
export function gatesBefore(code: string): readonly { after: string; before: string; because: string }[] {
  return CUTOVER_GATES.filter((g) => g.before === code);
}
