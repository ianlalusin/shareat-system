/**
 * @shareat/domain — business rules that compose repository calls and own their own
 * transactions (PROJECT_BIBLE.md §4.3). Never imports from `apps/` (bible §8).
 */
export * from './shared/constraint-refusals';
/** ⭐ T-266 — the pure money-form rules, imported by BOTH the client component and the server
 *  action so the two cannot disagree about what a document allows. */
export * from './shared/money-lines';
export * from './shared/refusal'; // T-343 S5.0
export * from './ledger/post-entry';
export * from './ledger/inter-store';
export * from './ledger/reverse-entry';
export * from './reports/trial-balance';
export * from './reports/income-statement';
export * from './reports/balance-sheet';
export * from './reports/ap-aging';
export * from './reports/ar-aging';
export * from './reports/cash-flow';
export * from './reports/store-comparison';
export * from './reports/sales-rollup';
export * from './reports/pos-day-reconciliation';
export * from './expenses';
export * from './sales-days';
export * from './fixed-assets';
export * from './money-accounts';
export * from './money-transfers';
export * from './prepaid';
export * from './scheduler';
export * from './payroll';
export * from './remittance';
export * from './till';
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
export * from './trade/returns';
export * from './channel-settlements';
export * from './findings';
export * from './fiscal-periods';
export * from './cutover';
export * from './missed-months';

// ---- Phase 3, the inventory wave (T-160 to T-173) --------------------------------------------
// ⚠️ These had no export line at all until T-173. The package exposes only `.`, so nothing outside
// `packages/domain` could reach them — every UI route in the wave would have been blocked on this
// before it was blocked on anything interesting.
export * from './stock/quantity';
export * from './stock/layers';
export * from './stock/consume';
export * from './stock/receipt-posting';
export * from './stock/consumption-posting';
export * from './stock/invoice-link';
export * from './stock/wastage-reasons';
export * from './stock/usage';
export * from './stock/count-sessions';
export * from './stock/transfer-rules';
export * from './stock/transfers';
export * from './stock/supplier-returns';
export * from './stock-locations/rules';
export * from './deliveries/receive';
export * from './deliveries/duplicate-risk';
// DEF-135 (2026-09-03) — the four Phase 3 documents finally get their services and screens.
// ⚠️ Each of these had a tested engine and ZERO callers in apps/ for five days.
export * from './stock-locations/service';
export * from './deliveries/documents';
export * from './stock/usage-records';
export * from './stock/count-workflow';
export * from './commissary/outcome';
export * from './commissary/transfer';
export * from './commissary/discrepancy';
export * from './commissary/auto-order';
export * from './commissary/messages';
// T-172 / DEF-136 — the branch order's two sides, built 2026-09-03.
export * from './commissary/orders';
export * from './commissary/fulfilment';
// T-171 / DEF-129 — the catalogue's writers, built 2026-09-03.
export * from './commissary/catalogue';
export * from './statutory-discounts';
// T-154 — the staff master record: positions, employments, the roster (Phase 4, lane B).
export * from './people';
// T-155 — the shift-day calendar and attendance policy (Phase 4, lane B).
export * from './attendance';
// T-181 — the Lane A publisher, transport-free (Phase 4, lane B).
export * from './sync';
// T-176 — production: slab -> slice, recipe -> batch, and the payroll lock.
export * from './production';
export * from './production/validate';
export * from './production/unit-conversion';
// T-177 — POS item mapping and the daily usage pull.
export * from './pos/plan';
export * from './pos/item-map';
export * from './pos/usage-pull';
// T-210 — the daily sales pull, for the POS-day reconciliation report.
export * from './pos/sales-pull';
// T-375 S1 - the POS v1 day feed: the bridge fetchers and the store link.
export * from './pos/v1-feed';
export * from './pos/store-link';
export * from './pos/tenders';
export { normalizePosV1Alias, resolvePosV1Methods, type ResolvedMethods, type ResolverTender } from './pos/v1-methods';
// T-178 — order/channel wastage disposition.
export * from './wastage/orders';
export * from './wastage/settlement-match';
// T-222 — store creation and management.
export * from './stores/service';

// T-215 — expense budgets: the envelope, its cap, and the reissue schedule. Nothing posts.
export * from './budgets';

// T-216 — recurring-expense templates AND the daily drafting job (Part 2). ⛔ It DRAFTS and never
// auto-pays — Ian, 6-7 Sep 2026: a pending supplier invoice and a draft expense, and nothing on the
// ledger until a person attaches the real bill and approves. The job holds no privilege of its own;
// it acts as the template's creator through the ordinary gates.
export * from './recurring-expenses';

// T-228 — standing up an organization: the one flow with no Actor, because there is no principal
// before the org exists. Its only caller is scripts/bootstrap-org.ts.
export * from './organizations';

// T-230 — sales-channel administration (DEF-207) and the per-channel wastage policy (bible §13
// row 180). ⚠️ Separate from `stores/service` on purpose: that module is `manage_stores`
// (admin-only), this one is `manage_store_settings` (manager ✅).
export * from './sales-channels';
