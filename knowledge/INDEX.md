# Shareat knowledge index

The map of everything written about how Shareat operates. **Read this first; open only the pages
you need.** Find by label (`about`, `readers`), then by topic.

Maintained by the `knowledge-intake` skill (`.claude/skills/knowledge-intake/`). Do not edit pages
without updating this file.

## Labels in use

**readers** — who may be shown a page: `public` (customers) · `staff` · `managers`

**about** — who a page is about:
`customer` · `cashier` · `server` · `cook` · `manager` · `franchisee` · `deputy` · `staff` (all positions)

**Topics** (top level — grows as pages are added):

| Topic | Covers |
|---|---|
| `company` | Who Shareat is, brand, stores, franchise |
| `customer-experience` | The customer journey, from arrival to leaving; ordering, the app, loyalty |
| `menu-and-food` | How the food and service model works (not prices — those live in the system) |
| `store-operations` | Opening, closing, daily routines, cleanliness, equipment |
| `staff` | Positions, duties, SOPs, conduct, schedules, HR rules |
| `cash-and-payments` | Cash handling, tenders, refunds, voids, end of day |
| `policies` | Store rules, safety, allergens, complaints, legal |
| `planned` | Changes decided but **not live** — never present them as working today |

⛔ **Menu items and prices are never written on a page.** Their single source of truth is POS v1
today and ERP v2 from v2 (bible row 383). Pages point to the system; an AI reads current values
from it.

⛔ **`related` links are for keeping pages consistent, not permission.** A public page may link to a
staff or managers page; before showing any page, check that page's own `readers`.

**must_be_exact: true** pages hold money, allergen or legal rules — quote them, never paraphrase
loosely or fill gaps.

**Future-franchise pages** record policy selected on 4 November 2026 for future agreements; they do not amend existing contracts or prove software deployment. All use `readers: managers`.

## Pages

### company

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [company/future-franchise-roles.md](company/future-franchise-roles.md) | Future franchised stores — roles, powers and data | franchisee, deputy, manager | managers | Roles, only written powers exist, approval vs payment, Annex A/B/C, (coming) features use paper, data rights | 2026-11-05 |
| [company/future-franchise-opening-and-provided-manager.md](company/future-franchise-opening-and-provided-manager.md) | Future franchised stores — opening, provided manager and handovers | franchisee, manager | managers | Opening approval in 7 days, first team up to 7, provided manager 1 to 6 months, later hires, handover, access removal in 72 hours | 2026-11-05 |
| [company/future-franchise-menu-promotions-and-support.md](company/future-franchise-menu-promotions-and-support.md) | Future franchised stores — menu, promotions, support and yearly review | franchisee, manager | managers | Manager sets prices, new products in 7 days, voluntary SharEat promotions, social media, visits, support, yearly review | 2026-11-05 |
| [company/future-franchise-scope.md](company/future-franchise-scope.md) | Future franchise responsibilities and scope | manager, staff, cashier | managers | Future franchises only: role definitions and map of all approved responsibility pages; existing agreements remain separate | 2026-11-04 |
| [company/future-franchise-commercial-terms.md](company/future-franchise-commercial-terms.md) | Future franchise commercial terms | manager, staff | managers | Future agreement fee, conditional refund, renewal cycle/notice, up-to-seven staffing and uniform exclusion | 2026-11-04 |
| [company/franchise-agreement-review.md](company/franchise-agreement-review.md) | Franchise agreement review and alignment | manager, staff | managers | Dated comparison of both supplied agreements; unresolved package, execution, legal-review and alignment items | 2026-11-04 |
| [company/future-franchise-brand-and-bookings.md](company/future-franchise-brand-and-bookings.md) | Future franchise brand communications and bookings | manager, cashier, staff | managers | Future franchise products/prices, promotions, social-media access/moderation, reservations and large events | 2026-11-04 |
| [company/future-franchise-support-and-reviews.md](company/future-franchise-support-and-reviews.md) | Future franchise support settlement and reviews | manager, staff, cashier | managers | Future franchise support cadence, extra retraining quote, monthly settlement/targets and annual reviews | 2026-11-04 |
| [company/future-franchise-open-items-and-sources.md](company/future-franchise-open-items-and-sources.md) | Future franchise open items and source records | manager, staff, cashier | managers | Resume point, unanswered payout-follow-up question, unset store terms, artifact versions and source references | 2026-11-04 |

### customer-experience

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [customer-experience/dine-in-journey.md](customer-experience/dine-in-journey.md) | Dine-in customer journey — arrival to payment | customer, cashier, server, cook | public | The standard visit: greeting, order at cashier, QR code, rules, seating, refills, bill and payment at cashier, review | 2026-10-26 |
| [customer-experience/take-out-in-store.md](customer-experience/take-out-in-store.md) | Walk-in take-out — ordering at the store | customer, cashier, cook | public | Order at cashier; waiting customers pay at order or pickup, leaving customers pay first. must_be_exact | 2026-10-23 |
| [customer-experience/online-orders.md](customer-experience/online-orders.md) | Online orders — Foodpanda, GrabFood, website, Facebook, call and text | customer, cashier | public | Channels per store, rider-app delivery or pickup, pay online first, COD only on some deliveries. must_be_exact | 2026-10-26 |
| [customer-experience/customer-app.md](customer-experience/customer-app.md) | The customer app during dine-in | customer, server, cook, manager | public | App buttons: refill, add griller, assistance, loyalty card, games, à la carte (if manager allows) | 2026-10-26 |

### store-operations

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [store-operations/opening-and-closing.md](store-operations/opening-and-closing.md) | Opening and closing the store — checklists | staff, manager | staff | Per-position checklists in ERP; prep starts after opening; closing open until 2 a.m.; photo items and AI checks set by manager; failures warn the manager; missed checklist = automatic infraction; scoped future-franchise responsibilities linked | 2026-11-04 |
| [store-operations/daily-usage.md](store-operations/daily-usage.md) | Nightly usage recording | staff, manager | staff | One staff per department records usage nightly in ERP; missed night = infraction + catch-up entry; monthly count mismatch = manager corrects and investigates; scoped future-franchise responsibilities linked | 2026-11-04 |
| [store-operations/future-franchise-approvals-people-and-stock.md](store-operations/future-franchise-approvals-people-and-stock.md) | Future franchised stores — who approves what: people, stock and buying | manager, franchisee, deputy, cashier, staff | managers | Tables: schedules, leave, overtime, discipline, payroll, orders, suppliers, counts, emergencies. must_be_exact | 2026-11-05 |
| [store-operations/future-franchise-approvals-cash-and-customers.md](store-operations/future-franchise-approvals-cash-and-customers.md) | Future franchised stores — who approves what: cash, platforms, customers and store | manager, franchisee, deputy, cashier, staff | managers | Tables: cash, remittance, advances, Foodpanda and Grab, refunds, comps, targets, outage. must_be_exact | 2026-11-05 |
| [store-operations/future-franchise-daily-operations.md](store-operations/future-franchise-daily-operations.md) | Future franchise daily operations and incidents | staff, manager, cashier | managers | Future franchise pre-opening task allocation, daily standards/checklists, backups, incidents, repairs and outage oversight | 2026-11-04 |
| [store-operations/future-franchise-stock-and-purchasing.md](store-operations/future-franchise-stock-and-purchasing.md) | Future franchise stock purchasing and deliveries | staff, manager, cashier | managers | Future franchise orders, alternative suppliers, receiving, receipts, usage/counts, franchisee-only stock adjustments and losses | 2026-11-04 |

### staff

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [staff/cashier-dine-in-sop.md](staff/cashier-dine-in-sop.md) | Cashier SOP — dine-in | cashier | staff | Order taking, starting the session, billing; bill not invoice (not BIR-accredited); manual OR on request. must_be_exact; scoped future-franchise responsibilities linked | 2026-11-04 |
| [staff/cashier-take-out-and-online-sop.md](staff/cashier-take-out-and-online-sop.md) | Cashier SOP — take-out and online orders | cashier, manager | staff | Walk-in take-out steps, online orders tab badge, rider booking, payment before dispatch, Foodpanda/Grab devices. must_be_exact; scoped future-franchise responsibilities linked | 2026-11-04 |
| [staff/server-and-kitchen-sop.md](staff/server-and-kitchen-sop.md) | Server and kitchen SOP | server, cook, cashier | staff | Greeting, seating, refills on device, kitchen display, bell, assistance alerts, leftover inspection, take-out and platform orders in the kitchen; scoped future-franchise responsibilities linked | 2026-11-04 |
| [staff/future-franchise-manager-training.md](staff/future-franchise-manager-training.md) | Future franchised stores — manager training and release | manager, franchisee | managers | Two files, must-pass tick-lists, two monthly checks, hard situations, weekly brief, training a replacement | 2026-11-05 |
| [staff/future-franchise-hiring-and-training.md](staff/future-franchise-hiring-and-training.md) | Future franchise hiring training and provided manager | staff, manager, cashier | managers | Future franchise up-to-seven initial staff, provided manager 1-6 months, employment/costs, onboarding and probation | 2026-11-04 |
| [staff/future-franchise-staff-management-and-access.md](staff/future-franchise-staff-management-and-access.md) | Future franchise staff management payroll and access | staff, manager, cashier | managers | Future franchise schedules/leave/overtime, franchisee-only payroll, discipline, manager transition and SharEat-administered access | 2026-11-04 |

### cash-and-payments

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [cash-and-payments/platform-wastage.md](cash-and-payments/platform-wastage.md) | Foodpanda and Grab wastage — refunded wrong or missing items | manager, staff | managers | Daily Gmail script feeds the ERP v1 wastage page; manager names staff, raises with platform (photos, CCTV), else expense or charge staff. must_be_exact; scoped future-franchise responsibilities linked | 2026-11-04 |
| [cash-and-payments/platform-payouts.md](cash-and-payments/platform-payouts.md) | Foodpanda and Grab payouts | manager | managers | Customers pay the platforms; Grab pays next business day, Foodpanda weekly; not in the POS. must_be_exact; scoped future-franchise responsibilities linked | 2026-11-04 |
| [cash-and-payments/future-franchise-staff-charges.md](cash-and-payments/future-franchise-staff-charges.md) | Future franchised stores — charging staff for losses | manager, franchisee, staff | managers | Four-step due process, applies to the manager too, Labor Code caution. must_be_exact | 2026-11-05 |
| [cash-and-payments/future-franchise-cash-and-sales-controls.md](cash-and-payments/future-franchise-cash-and-sales-controls.md) | Future franchise cash and sales controls | cashier, manager, staff | managers | Future franchise cash reports/custody/remittance, refunds/discounts/voids/Convert, advances and reimbursements | 2026-11-04 |
| [cash-and-payments/future-franchise-platform-settlement.md](cash-and-payments/future-franchise-platform-settlement.md) | Future franchise platform settlement and wastage | manager, cashier, staff | managers | Future franchise invoice settlement/reconciliation, manager wastage cases and staff-charge disputes; payout follow-up still open | 2026-11-04 |

### policies

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [policies/allergies-and-dietary-requests.md](policies/allergies-and-dietary-requests.md) | Allergies and dietary requests | customer, cashier, server, cook | public | Shared kitchen: no promise any dish is allergen-free; serious allergy goes to the manager on duty; no-pork tables get a clean setup all session (no trace not promised); no nuts added; seafood only on purpose; buffet can't be adjusted, à la carte can; never claim halal. must_be_exact | 2026-11-03 |
| [policies/leftover-policy.md](policies/leftover-policy.md) | No-leftover policy | customer, server, cashier | public | Leftovers charged, never taken home; amounts can change, the cashier gives the current amount. must_be_exact | 2026-10-26 |
| [policies/future-franchise-safety-and-incidents.md](policies/future-franchise-safety-and-incidents.md) | Future franchised stores — safety and incidents | manager, franchisee, staff | staff | Serious incident within 1 hour, stopping service, reopening, public replies. must_be_exact | 2026-11-05 |

### planned

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [planned.md](planned.md) | Planned changes — not live | customer, cashier, manager, staff | managers | v2: request the bill from the customer app; future: Foodpanda/Grab orders in the POS; v2: checklists in a slim staff-only ERP; future-franchise policy is scoped separately from deployment | 2026-11-04 |

<!-- Row format, under a "### <topic>" heading:
| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [customer-experience/arrival.md](customer-experience/arrival.md) | Customer journey — arrival to ordering | customer, cashier | public | Greeting, seating, how ordering starts | 2026-10-23 |
-->
