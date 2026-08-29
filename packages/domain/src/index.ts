/**
 * @shareat/domain — business rules that compose repository calls and own their own
 * transactions (PROJECT_BIBLE.md §4.3). Never imports from `apps/` (bible §8).
 */
export * from './ledger/post-entry';
export * from './ledger/reverse-entry';
export * from './reports/trial-balance';
export * from './reports/income-statement';
export * from './expenses';
export * from './sales-days';
export * from './fixed-assets';
export * from './money-accounts';
export * from './money-transfers';
export * from './prepaid';
export * from './scheduler';
export * from './remittance';
export * from './files';
export * from './loans';
export * from './cash-requests';
export * from './owners';
export * from './liabilities';
export * from './customers';
export * from './ap';
export * from './items';
export * from './ar';
export * from './trade';
export * from './channel-settlements';
export * from './findings';
export * from './cutover';
// T-154 — the staff master record: positions, employments, the roster (Phase 4, lane B).
export * from './people';
// T-155 — the shift-day calendar and attendance policy (Phase 4, lane B).
export * from './attendance';
// T-160 — the Lane A publisher, transport-free (Phase 4, lane B).
export * from './sync';
