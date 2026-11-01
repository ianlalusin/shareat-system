# DEF-808: POS finds cash by `type === 'cash'`, but v1's live data types Cash as `other`

**Status:** SPEC 1 Nov 2026 (POS2 switch-on session). DEF-808 given by BOSS 1 Nov. **T-number: not yet given, ask BOSS.**
Process (BOSS): spec, then tests first, then the fix. No migration. Same fix as #113 (refund server) and #108 (refund screen).

## 1. The problem in plain words

v1's live Firebase data labels the Cash payment method `type: "other"` at every store (checked at Lipa, Malvar, Davao, Banay-Banay,
31 Oct). The refund screen (#108) and the refund server (#113) were fixed to accept type `cash` OR a name that is exactly "Cash".
Several other places in `apps/pos` still ask for `type === 'cash'` only:

| Site | What it does | Effect at Lipa today |
|---|---|---|
| `server/pos2/conversions.ts:61` | picks the cash method for a cash <-> e-wallet conversion | **Broken.** No cash found, so the server answers "That payment method is not available." |
| `server/pos2/z-readings.ts:50` | builds `cashNames` for the Z reading | **None** (no change, R3). `isCashMethod` (`lib/cash/cash-method.ts`) falls back to `/\bcash\b/i`, so a method named "Cash" is still counted. A cash method with no "cash" in its name would be missed. |
| `lib/cash/handover.ts:35` | tablet query `where type == cash` for cash names | **None** (no change, R4): same name fallback. |
| `components/cashier/payment-modal.tsx:215,254` | which payment method is pre-selected | Cosmetic. Cash is not pre-selected; the first method is. |

## 2. Rulings

- **R1.** One predicate, `isCashTender` (`lib/receipts/refund-cash-methods.ts`, already used by #108/#113): type `cash` OR name exactly "Cash" (trimmed, any case). Never "Gcash". Reuse it; do not write a second one.
- **R2.** `conversions.ts`: the cash method is the first active method (by `sortOrder`, then name) for which `isCashTender` is true.
- **R3. `z-readings.ts` and R4. `handover.ts`: NO CODE CHANGE** (ruled in tests-first, 1 Nov). `isCashTender` is a subset of what `isCashMethod` already counts (a configured name OR `cash`), so a method named exactly "Cash" is counted as cash whatever its type. Widening `cashNames` cannot change a single figure; changing money maths for no observable gain is risk. Pinned instead by a **characterisation test (C3)** that passes before and after, so a later "tidy" of `isCashMethod` cannot silently drop Cash typed `other`. Residual, accepted: a drawer with no "cash" in its name AND typed `other` is not counted; none exists in the live lists.
- **R5.** `payment-modal.tsx`: pre-select with `isCashTender`.
- **R6.** No change to `isCashMethod`, `computeZReading`, the Z or handover maths, or any stored document.
- **R7.** Out of scope, needs a ruling (**Q1**): the e-wallet side of Convert. The tablet's Convert sheet (`ConvertSheet.tsx:58`) and the server (`conversions.ts:63`) both require the wallet to be `type 'online'`. Lipa's GCash is typed `other`, so the sheet lists no wallet at all. Which Lipa methods count as an e-wallet (GCash yes; Bank Transfer? QRPH? Maya?) is a business decision, not a code guess.

## 3. Tests (written first; Vitest in `apps/pos`)

| Id | Case | Expected | Kills |
|---|---|---|---|
| C1 | Convert, store has Cash typed `other` and a wallet typed `online` | accepted; `fromMethod`/`toMethod` use "Cash" | strict type kept (R2) |
| C2 | Convert, only a Gcash typed `other` and no cash | refused "not available" | Gcash taken as cash |
| C3 | **Characterisation (passes before and after).** Z reading, store methods Cash typed `other`, Gcash typed `other`, one sale paid Cash and one paid Gcash | `cash.salesCentavos` counts only the Cash sale | a later change that drops Cash typed `other` (R3) |
| C4 | pre-selection helper (pure): methods [GCash, Cash typed `other`] | Cash id | R5 |

Existing conversion, Z and handover suites stay green. C1, C2 and C4 must FAIL on the old line (mutation check, as done for #113); C3 is the one that is expected to pass on both.

## 4. Fences
Write only: `conversions.ts`, `payment-modal.tsx` (pre-selection only), their tests, this spec, the DEF-808 register row. No schema, no ERP, no Firestore writes.
