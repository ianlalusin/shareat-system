# Shareat knowledge index

The map of everything written about how Shareat operates. **Read this first; open only the pages
you need.** Find by label (`about`, `readers`), then by topic.

Maintained by the `knowledge-intake` skill (`.claude/skills/knowledge-intake/`). Do not edit pages
without updating this file.

## Labels in use

**readers** — who may be shown a page: `public` (customers) · `staff` · `managers`

**about** — who a page is about:
`customer` · `cashier` · `server` · `cook` · `manager` · `staff` (all positions)

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

**must_be_exact: true** pages hold money, allergen or legal rules — quote them, never paraphrase
loosely or fill gaps.

## Pages

### customer-experience

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [customer-experience/dine-in-journey.md](customer-experience/dine-in-journey.md) | Dine-in customer journey — arrival to payment | customer, cashier, server, cook | public | The standard visit: greeting, order at cashier, QR code, rules, seating, refills, bill and payment at cashier, review | 2026-10-23 |
| [customer-experience/take-out-in-store.md](customer-experience/take-out-in-store.md) | Walk-in take-out — ordering at the store | customer, cashier, cook | public | Order at cashier; waiting customers pay at order or pickup, leaving customers pay first. must_be_exact | 2026-10-23 |
| [customer-experience/online-orders.md](customer-experience/online-orders.md) | Online orders — Foodpanda, GrabFood, website, Facebook, call and text | customer, cashier | public | Channels per store, rider-app delivery or pickup, pay online first, COD only via PandaGo. must_be_exact | 2026-10-23 |
| [customer-experience/customer-app.md](customer-experience/customer-app.md) | The customer app during dine-in | customer, server, cook, manager | public | App buttons: refill, add griller, assistance, loyalty card, games, à la carte (if manager allows) | 2026-10-23 |

### store-operations

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [store-operations/opening-and-closing.md](store-operations/opening-and-closing.md) | Opening and closing the store — checklists | staff, manager | staff | Per-position checklists in ERP; prep starts after opening; closing open until 2 a.m.; photo items and AI checks set by manager; failures warn the manager; missed checklist = automatic infraction | 2026-10-23 |
| [store-operations/daily-usage.md](store-operations/daily-usage.md) | Nightly usage recording | staff, manager | staff | One staff per department records usage nightly in ERP; missed night = infraction + catch-up entry; monthly count mismatch = manager corrects and investigates | 2026-10-23 |

### staff

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [staff/cashier-dine-in-sop.md](staff/cashier-dine-in-sop.md) | Cashier SOP — dine-in | cashier | staff | Order taking, starting the session, billing; bill not invoice (not BIR-accredited); manual OR on request. must_be_exact | 2026-10-23 |
| [staff/cashier-take-out-and-online-sop.md](staff/cashier-take-out-and-online-sop.md) | Cashier SOP — take-out and online orders | cashier, manager | staff | Walk-in take-out steps, online orders tab badge, rider booking, payment before dispatch, Foodpanda/Grab devices. must_be_exact | 2026-10-23 |
| [staff/server-and-kitchen-sop.md](staff/server-and-kitchen-sop.md) | Server and kitchen SOP | server, cook, cashier | staff | Greeting, seating, refills on device, kitchen display, bell, assistance alerts, leftover inspection, take-out and platform orders in the kitchen | 2026-10-23 |

### cash-and-payments

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [cash-and-payments/platform-wastage.md](cash-and-payments/platform-wastage.md) | Foodpanda and Grab wastage — refunded wrong or missing items | manager, staff | managers | Daily Gmail script feeds the ERP v1 wastage page; manager names staff, raises with platform (photos, CCTV), else expense or charge staff. must_be_exact | 2026-10-23 |
| [cash-and-payments/platform-payouts.md](cash-and-payments/platform-payouts.md) | Foodpanda and Grab payouts | manager | managers | Customers pay the platforms; Grab pays next business day, Foodpanda weekly; not in the POS. must_be_exact | 2026-10-23 |

### policies

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [policies/allergies-and-dietary-requests.md](policies/allergies-and-dietary-requests.md) | Allergies and dietary requests | customer, cashier, server, cook | public | No-pork tables get a clean setup all session; no nuts; seafood only on purpose; buffet can't be adjusted, à la carte can; never claim halal. must_be_exact | 2026-10-23 |
| [policies/leftover-policy.md](policies/leftover-policy.md) | No-leftover policy | customer, server, cashier | public | Leftovers charged, never taken home; server decides; amounts set in the POS. must_be_exact | 2026-10-23 |

### planned

| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [planned.md](planned.md) | Planned changes — not live | customer, cashier | managers | v2: request the bill from the customer app; future: Foodpanda/Grab orders in the POS; v2: checklists in a slim staff-only ERP | 2026-10-23 |

<!-- Row format, under a "### <topic>" heading:
| Page | Title | About | Readers | Summary | Updated |
|---|---|---|---|---|---|
| [customer-experience/arrival.md](customer-experience/arrival.md) | Customer journey — arrival to ordering | customer, cashier | public | Greeting, seating, how ordering starts | 2026-10-23 |
-->
