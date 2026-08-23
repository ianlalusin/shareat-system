# ADR-003 — One backend, four front-ends

| | |
|---|---|
| **Status** | Accepted 2026-08-23. Sequencing and name confirmed by Ian |
| **Supersedes** | Nothing. Extends ADR-001 (Postgres) and ADR-002 (infrastructure) |
| **Evidence** | `docs/discovery/09-pos-system.md`, `10-customer-app.md`, `11-website.md`, `12-shared-infrastructure.md`, `docs/CROSS-APP-MAP.md` |

## Context

This project began as **ERPv2**, an accounting-correctness rebuild of one application. Discovery across all four
applications on 2026-08-23 showed that framing was too narrow.

**The four apps are already one system — badly.** Not by design, but by accretion:

| Evidence | Source |
|---|---|
| **Six Firestore collections written by BOTH POS and CUSTOMER** — `activeSessions`, `sessions`, `kitchentickets`, `rtKdsTickets`, `customers/{phone}`, `loyaltyRedemptions` | 10 §4a |
| **POS and CUSTOMER share one Firebase project** (`shareat-hub-v2`), and a CUSTOMER deploy can overwrite POS's 800-line production ruleset | 12 §1–2 |
| **The Website's Cloud Functions hold a cross-project service-account credential** (`HUB_SA_KEY`) into POS's database | 11 |
| **Auth is one tenant used in both directions** — a POS-minted ID token is verified by CUSTOMER's Admin Auth | 12 §4 |
| **Three independently-synced sources of branch identity** on the Website alone | 11 |
| **Three separate identity schemes** in CUSTOMER (device hash, phone-as-PK, game device id) | 10 §4c |
| **8 key-scoped HTTP routes** exist purely to move data between apps | `CROSS-APP-MAP.md` §3 |

Every one of these is a workaround for the absence of a shared database. Several are active
defects: a ruleset that can be clobbered by the wrong deploy, a storage upload that fails
closed, a `receipt.source` field written by one app and never read by the layer that needs it.

**Bible §4.2 rule 8 already names the disease** — *"One writer per table. If two code paths
write the same table, one of them is wrong."* Six shared collections is that rule violated six
times, across a process boundary, enforced by nothing.

## Decision

**PostgreSQL becomes the single backend for the whole business. The four applications become
front-ends over it, not systems that talk to each other.**

- **No app-to-app data linking.** The `api/external/*` routes, the API keys and key-scoping,
  `HUB_SA_KEY`, the sales pull and its field mapping, the payment-method mapping, the
  storefront-catalog feed, and the cross-app dedup maps are **deleted, not migrated**.
- One chart of accounts, one store table, one product master, one `person` spine.
- Revenue posts **from the receipt**, not from a re-keyed daily summary.

### What is NOT deleted

Two things resemble app-to-app linking and are not:

1. **The Lane A / Lane B Firestore edge cache** (bible §5). It exists for offline, not for
   sharing data between apps. Scope closed by §13 row 77.
2. **The historical ETL mapping** (T-113). History was recorded in the old shape and still has
   to load.

And critically — **the plumbing encodes business rules learned expensively. Harvest before
deleting** (§13 row 78). Named examples already found:

- **The bill is created on SERVE, not on order** (`billOnServe: true`). Recognise revenue at
  order instead and unserved orders become revenue.
- **Refill cooldown is 60s anchored on serve**, with 10-minute and 20-minute safety valves —
  all magic numbers in app code today; they become configuration.
- **Server-side repricing at order placement** on the Website's `/shop`.
- **Void-cash-retained disposition** — cash in the drawer with no backing sale.

## Sequencing — confirmed by Ian

**Ledger first. Then front-ends, one at a time, behind feature flags. Never two at once.**

```
Phase 1   accounting spine (T-101 … T-116)     ← the foundation everything posts into
Phase 2+  ERP front-end
then      POSv2
then      CUSTOMERv2
then      Website
```

Bible §13 row 20 already rejected big-bang rewrites of live production systems. Rebuilding
four apps onto a new backend *is* that failure mode if attempted as one move, and is safe if
each front-end follows the strangler fig separately. Building POSv2 before a ledger exists for
it to post into is backwards.

**T-101 is therefore designed for four consumers, not one.** That is the whole reason this ADR
precedes it.

## Availability and offline — settled

Ian, asked directly: **offline is needed for POS selling and the ERP biometric clock only.
Nothing else. An outage of 10 minutes to an hour is workable.**

This is a major simplification, recorded as §13 row 77:

- **No local Postgres per store.** No multi-master, no bidirectional sync.
- CUSTOMER and the Website are **online-only**.
- The two-lane model already designed for the clock terminal is sufficient, because an hour of
  tolerance turns offline from a correctness problem into queue-and-replay.

### The one hard problem: receipt numbering

POS today has **two sale-completion paths writing the same `receiptSeq` field from
non-comparable sequence spaces** — a server-arbitrated counter online, and a per-device daily
counter offline (`<store>-OL-<deviceTag>-<HHMM>-<NNN>`).

The offline design is right; the shared integer column is not. **v2 models it honestly:** a
composite `(device_id, local_seq)` plus a separate server sequence, never one column pretending
to be both.

**Related verified defect to fix in the rebuild, not port:** refunds are written with
`receiptSeq: 0` and `receiptNumber: RF-{parent}` with no suffix, so a second partial refund
against one parent mints an identical receipt number
(`POS/src/components/cashier/firestore.ts:1484-1485`).

## Consequences

**Accepted:**

- The project's scope is now the platform, not the ERP. §1 of the bible must be re-read in
  that light.
- Availability risk concentrates in one database. Mitigated by the 1-hour tolerance, pooling
  isolation, and a rehearsed restore (bible §15.8).
- Deleting the integration layer is irreversible once done — hence harvest-first.

**Gained:**

- The dual-writer bug class disappears by construction, not by discipline.
- Revenue classification stops depending on `dineInSales` meaning something non-obvious and
  `takeOutSales` being a subtraction.
- One deploy can no longer break another app's security rules.
- `float` money, duplicated rounding, and three identity schemes collapse into the primitives
  Shareat System already built.

**Open:**

| # | Question | Blocks |
|---|---|---|
| 1 | Does dine-in à la carte need its own account (4150), or is à la carte always take-out? | T-113 §6.6 |
| 2 | Opening-balance date for the detail load | T-115 |

*Resolved 2026-08-23: the project is named **Shareat System** (no version — "v1" already means
the legacy ERP in 170 places). The earlier question "should POS get a typed `fulfilment` field
as a stopgap" is **void**: the standing rule makes all four reference repos read-only (§13
row 80), so nothing is changed in POS. The fix lands in the rebuild as DEF-004/DEF-005.*
