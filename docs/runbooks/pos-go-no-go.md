# Go / no-go checklist: Lipa on the new POS

**Purpose:** the checklist for the go/no-go meeting. Ian decides go or no-go. **Owner:** Ian (decides); BOSS fills the evidence. Written for T-533 (R4), 15 Nov 2026.

**Target meeting date: Fri 4 Dec 2026.** The target go-live is Mon 7 Dec, but the real date depends on the soak and the printing check. If either slips, the meeting and the live date move. Ian decides. If go-live slips past 31 Dec, the December bridge no longer applies (it ends 31 Dec) and design section 8a option (c) (go live Mon 11 Jan) applies.

Lipa stays OFF or TEST until Ian says "go" (bible row 435). Nothing below switches it.

## The two gates (both must pass)
| Gate | Pass mark | Result | Date | Evidence |
|---|---|---|---|---|
| **1. Soak** (`pos-soak-plan.md`; 24 h on two tablets per row 431, `docs/ops/pos-v2-soak.md`) | 0 sales lost, 0 sales doubled, no open blocker | _(Pass / Fail)_ | | _(defect ids, receipt counts)_ |
| **2. Printing check** (APK shell, T-532; `pos-lipa-switch.md` section B) | Every slip prints, readable, right totals, nothing doubled | _(Pass / Fail)_ | | _(photos, notes)_ |

If either gate is a Fail, the answer is **No-go** for that date. Fix, then retest (soak #2 by Wed 2 Dec at the latest, then re-check the date).

## Soak results block
| | |
|---|---|
| Soak #1 date | Sat 21 Nov 2026, Chrome, TEST mode |
| Soak #2 date (if run) | Sat 28 Nov 2026, 2-4 pm, or Wed 2 Dec at the latest |
| Steps passed / failed / skipped | _ / _ / _ (4 skipped for printing, T-532) |
| Sales lost | _ (must be 0) |
| Sales doubled | _ (must be 0) |
| Blockers open | _ (must be 0) |
| Defects filed | _ (ids) |

## Checklist
Tick each line with a date and who checked.

### Code and deploy
- [ ] Every PR merged **and deployed**: #196, T-539 S3, T-546, T-529, T-531, T-530a, T-528e, and T-533 (switch screen, Lipa load, pre-flight, docs).
- [ ] CI is green on `main` at the deployed commit.
- [ ] `erp2.shareat.net` is healthy (home page and `/pos` load).
- [ ] Migration 0247 (the v1 import guard) is on production.

### Lipa setup
- [ ] Lipa pre-flight (`/admin/stores/[id]/pos-preflight`) shows **no blocking items**. Warnings are read and accepted by Ian.
- [ ] Lipa's business rules are seeded on production (VAT, SC/PWD, start hour, table warning).
- [ ] `npm run pos:load-setup` ran on production (dry run, then real, then a second run that changed nothing). It runs on **Ian's PC, never the droplet**, with `POS_BRIDGE_SA_KEY_FILE` (a READ-ONLY key for the v1 POS Firebase project) in that PC's `.env.local`. This is not `POS_FIREBASE_SA_KEY_FILE`, which the server's pre-flight checks.
- [ ] Every tender has a v1 name and the v1 key file for the December bridge is on the server.
- [ ] At least one manager with a PIN and "approve a POS correction". Staff have badge codes and PINs.
- [ ] Tablets paired and linked to Lipa's till (Settings > POS tablet).
- [ ] Staff have read `pos-staff-sheet.md` (Tagalog lines filled in).

### Safety net
- [ ] **Backups verified**: the latest database backup restores (restore test dated: ___ ).
- [ ] **Roll-back understood**: next morning only, before any Z, by an admin on `/admin/stores/[id]` (New POS card, Change POS mode = Test or Off). Ian and the admin both know who does it and how (`pos-lipa-switch.md` section H).
- [ ] The trial app will be signed out on every tablet on closing night.
- [ ] The first-week daily checks have an owner each morning (`pos-lipa-switch.md` section G).
- [ ] The December bridge works for a Z on a test day (or is accepted as untested by Ian).

### Business
- [ ] December stock usage will be typed by hand in v1 (the bridge sends day totals only).
- [ ] Ian knows which Lipa day is the first live business day, and that Lipa's v1 import stops from that date.

## The decision
| | |
|---|---|
| **Decision** | Go / No-go |
| **Decided by** | Ian |
| **Date and time** | |
| **Live-from date (if go)** | _(Mon 7 Dec target)_ |
| **Reason / conditions** | |

If **Go**: an admin sets Lipa to Live from the chosen date on opening morning, following `pos-lipa-switch.md` sections E and F. The admin enters a reason.
If **No-go**: Lipa stays in TEST or OFF. BOSS writes the blockers and the next meeting date here.
