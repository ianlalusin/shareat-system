/**
 * @shareat/domain — business rules that compose repository calls and own their own
 * transactions (PROJECT_BIBLE.md §4.3). Never imports from `apps/` (bible §8).
 */
export * from './ledger/post-entry';
