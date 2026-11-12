# T-556 - a replay is acknowledged only when it carries the same content (audit P-001)

Owner: AUDIT. Number given by BOSS 10 Nov 2026 (block T-552..T-557, DEF-819..820). No migration. Source finding:
`shareat-audits/OPEN/2026-11-09-pos-domain.md` (P-001). Base: origin/main d50a4e0.

## Defect (re-located on main d50a4e0)

T-524's contract (R9): the same id with the same content is a no-op; different content is refused. Two places acknowledge a replay
after looking at ids only.

1. `packages/domain/src/pos/sale.ts` `completeSale`, the prior-receipt fast path (line 142):
   `if (prior.id === receiptId && prior.terminalSeq === terminalSeq && terminal?.id === prior.terminalId) return { wrote: false, receiptId }`.
   Payments, `issuedAtDevice`, `offline`, the device total and the statutory-holder entries are never compared, so a new inbox
   event reusing the receipt/session/terminal ids with DIFFERENT payments is acknowledged as applied though it was not recorded.
   No second receipt or money row is written; the defect is the false acknowledgement.
2. `packages/domain/src/pos/order.ts` `sameLine` (line 119): compares session, menu item, note and qty only. It ignores the
   chosen variant and option values, and a bundle line (`bundleHeads !== null`) is treated as equal for ANY qty, so a replay of a
   line id with another variant, other options or another head count is silently skipped.

## Fix

1. **Sale replay.** In the fast path, after the three id checks, also require equality with what the frozen receipt recorded:
   `prior.offline === offline`; `prior.issuedAtDevice` equal to `issuedAt` (compare `getTime()`); `prior.deviceTotal` equal to the
   input `device.total` in centavos (use the file's `sameCentavos`); the payments as a multiset of
   `(tenderId, amount centavos, referenceNo ?? '', toCheck)` against the stored `pos_sales_receipt_payments` rows (amount is the
   tendered figure; `changeGiven` is derived and not compared); and the statutory entries as a set of
   `(dinerNo, kind, idNumber, holderName)` against what the receipt recorded, if a plain reader for it exists. Any difference ->
   `throw recordedDifferently()` (same refusal the file already uses for the same id with other content). Add the needed read
   functions to `packages/db/src/repo/pos-v2.ts` (SQL lives only in repo; `tx: Tx` first param; org-scoped). Do not store any new
   column and do not write anything on a replay. If the statutory idNumber/holderName are not readable back as entered (masked or
   hashed), compare `(dinerNo, kind)` plus the count and add `// shortcut: card details not comparable, ...` naming the limit.
2. **Line replay.** Extend `sameLine` with the input's `variantId` (or whatever column the line stores for the variant), the set of
   chosen option value ids (read what the line stores; compare as sets), and for a bundle line compare the stored head count
   (`bundleHeads`) with the input qty (heads) instead of ignoring qty. Read `writeLines` (order.ts ~160) and the line schema first;
   the replay check must use the SAME canonical form the write path stores, including the derived second "extra heads" line of a
   bundle (ruling 3: its id is derived from the first, a replay must still be a no-op).

Files: `packages/domain/src/pos/sale.ts`, `packages/domain/src/pos/order.ts`, `packages/db/src/repo/pos-v2.ts`; tests
`packages/domain/tests/integration/t556-replay-same-content.test.ts` (new, real PostgreSQL; fixture style of `t524-pos-domain.test.ts`
and the inbox style of `t525-pos-inbox.test.ts`). T-552 edits `optionDelta` in order.ts in another branch: keep your edits inside
`sameLine` and its call so the two merge cleanly.

## Tests (write FIRST, red on d50a4e0)

Sale: identical replay -> `wrote:false`, no new rows; same receipt/session/terminal ids with other payment amount / tender /
reference / toCheck -> refused as recorded differently; other `offline`; other `issuedAtDevice`; other device total; (inbox) a
NEW sequence with the same receipt ids and different payments is refused/quarantined, never acknowledged applied. Line: same
line id with other variant, other option set, other bundle head count -> refused; identical replay (incl. a bundle with extra
heads) still a no-op. Existing T-524/T-525 tests stay green.

## Out of scope

P-002 (underpaid vs "mismatch must not refuse", needs Ian's written accounting rule); P-003 (T-552).
