# T-606 — A settle-later channel's receivable is 1220, always (DEF-924)

Status: SPEC (Opus), 2026-11-18. Fixes **DEF-924** (add the row in the DEF-866 format, marked `fixed - T-606`).
Risk: **high** (money, receivables). Builder: Sonnet. No new capability, no bible change. Migration: only S0, and only
if query Q0 says so. Line numbers are `origin/main` as of 18 Nov (includes T-592).

## What the owner hit

Correcting Lipa's Foodpanda sales from a platform file refused: *"Foodpanda doesn't use the standard channel receivable
account, so its sales can't be corrected from a platform file yet."* Lipa's Foodpanda and GrabFood channels are on
**1210 Accounts receivable**; every platform path reads **1220 Channel receivable**.

## The intended design (T-118, T-150, T-230, T-511)

- **1220 Channel receivable, party = channel**: what a delivery platform owes until it pays out. T-150 header
  (`repo/channel-settlements.ts:3-6`), POSTING-PATTERNS `channel_settlement` (lines 1163-1200), T-230 line 422
  (*"1220 Channel receivable is the answer in practice"*), the seed comment (`seed/chart-of-accounts.ts:141`).
- **1210 Accounts receivable, party = customer**: credit customers and franchise buyers (`repo/ar.ts:25`,
  `repo/customers.ts:22`, cutover tie-out T6 expects party `customer` on 1210, `domain/src/cutover/tie-out.ts:196-198`).
- T-230 invariant 4 asked only "postable, active, party-bearing", so 1210 slipped through. T-511 S6/S6c then gated
  correction and charges on 1220 "until slice 8 fixes `outstandingFor`"; slice 8 never widened it. The design answer is
  **1220 only**; we do not widen the settlement path to 1210 (that would mix platform debt into customer AR).

### BOSS's premise needs one check first (Q0)

`0001_chart_of_accounts_seed.sql:58` has **no** `requires_party` column: the column arrived in 0007 (default false) and
the canonical seed `seed/chart-of-accounts.ts:141` sets **1220 `requiresParty: true`**, same as 1210 (line 140). Orgs
are bootstrapped through `seedReferenceData` (`repo/organizations.ts:127-129`), and no migration flips 1210 alone. So
if Lipa's channels could be put on 1210, the picker very likely **already offers 1220** as its second row
("1220 · Channel receivable", right under "1210 · Accounts receivable"), and the real defect is that the picker offers
the wrong account first and nothing refuses it. Q0 settles it. If Q0 shows 1220 `requires_party = false`, run S0.

### End to end today

| Step | Channel on 1220 | Channel on 1210 |
|---|---|---|
| Sales day verify (`sales-days/routing.ts:230-245`) | Dr 1220 party channel. Works | Dr 1210 party channel. Posts, but sits in customer AR |
| Settlement (`channel-settlements/index.ts:598`, `:890`) | owed = 1220 balance; Cr 1220. Works | owed reads **0** (1220 only, `repo/channel-settlements.ts:221-236`); credit lands on 1220; 1210 never clears. **Broken** |
| Platform correction (`correction.ts:102`) | Works | **Refused** (today's message) |
| Period charge (`charge.ts:145`) | Works | **Refused** |
| Order wastage (`wastage/orders.ts:82`, `:203`) | Cr 1220. Works | Cr 1220 while the sale sits on 1210: 1220 goes negative. **Broken** |
| Outstanding on Settlements list (`repo/channel-settlements.ts:303-316`) | Right | Shows 0. **Wrong** |
| Platform aging (`repo/ar.ts:452-460`, `:513-525`) | Right | Shows the 1210 lines (joins the channel's own code); never ages down |
| Customer AR / cutover T6 | Untouched | 1210 control carries channel-party lines no customer report lists |

## Every place that validates or lists the channel receivable

| Site | Today | Change |
|---|---|---|
| `packages/db/src/repo/sales-days.ts:268-275` `receivableAccountOptions` | postable ∧ party ∧ active (offers 1210, 1140, 2110...) | S1: add `and code = ${CHANNEL_RECEIVABLE_CODE}` |
| `packages/domain/src/sales-channels/index.ts:97-125` `validateWiring` (used by create `:169`, update `:225`) | refuses non-party; **accepts 1210** | S1: settle-later must be 1220 |
| `packages/domain/src/sales-channels/index.ts:208-240` `updateSalesChannel` | switches code freely | S2: refuse a code change while a balance sits on the old code |
| `apps/erp/src/app/settings/sales-channels/actions.ts:71`, `:93` | sends the select as-is | S1: `null` when the channel reaches the till |
| `apps/erp/src/app/settings/sales-channels/page.tsx:450-462` (select), `:240`, `:257` (card) | lists the options; a 1210 channel's edit form defaults to "None" | S1 |
| `packages/domain/src/channel-settlements/correction.ts:101-107`, `:113` | 1220 gate; `old` filters on the account code | S3 |
| `packages/domain/src/channel-settlements/charge.ts:145-150` | 1220 gate | S3 (sentence only) |
| `packages/db/src/repo/channel-settlements.ts:21` `CHANNEL_RECEIVABLE_CODE` | the one constant | **the shared rule**; nothing new |
| `packages/domain/src/wastage/orders.ts:82`, settlement `index.ts:890`, `outstandingFor :221` | 1220 | none (correct once channels are on 1220) |
| Field rules `typed-forms.ts:9` | field list only | none |
| Store readiness `repo/store-readiness.ts`, POS preflight `domain/src/pos/preflight.ts`, soak `pos-soak/soak-checks.ts` | do not read channels' receivable (grep) | none |
| Seeds `scripts/dev-seed.ts:135-136`, `scripts/practice-erp-seed.ts:105`, test fixture `t398-s6-franchise.ts:128` | 1220 | none |
| Cutover / import | no path creates channels (only `createSalesChannel`, `actions.ts:67`) | none |
| DB CHECK `sales_channels_non_remitted_needs_receivable_check` (0016) | settle-later needs *a* code | later CHECK, see "Migration" |

## Option chosen: (b) a settle-later channel may only use 1220

| Option | Owner sees | Books |
|---|---|---|
| (a) accept party accounts OR 1220 | same list, 1210 still first | the trap stays: settlement, wastage, aging stay wrong for any 1210 channel |
| **(b) settle-later = 1220 only** | one choice, "1220 · Channel receivable"; existing 1210 channels must move | every platform path agrees with the setting, by one constant |
| (c) default 1220, hide the field | nothing to pick | cannot fix Lipa's channels on screen; hides a setting the sales-day screen still names |

**Pick (b).** Smallest change that makes the screen and the ledger unable to disagree: the picker and the domain both
read `CHANNEL_RECEIVABLE_CODE`, the same constant settlement, correction, charges and wastage already use. No new helper.

## Existing data: read-only queries for BOSS (do not run in this task)

Run in BOSS's usual read-only production session. Never print `.env.local`.

```sql
-- Q0 the two accounts as the org has them
select code, name, is_postable, requires_party, status from accounts where code in ('1210','1220') order by code;
-- Q1 channels by store, settle-later flag and receivable
select s.code store, sc.is_remitted_daily, sc.receivable_account_code, count(*), string_agg(sc.name, ', ')
  from sales_channels sc join stores s on s.id = sc.store_id group by 1,2,3 order by 1,2,3;
-- Q2 posted channel-party lines on 1210/1220 by channel, account and source
select s.code store, sc.name channel, a.code, je.source_type, count(*) lines, sum(jl.debit) dr, sum(jl.credit) cr
  from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
  join sales_channels sc on sc.id::text = jl.party_id and sc.org_id = je.org_id join stores s on s.id = sc.store_id
 where jl.party_type = 'channel' and je.status <> 'draft' and a.code in ('1210','1220')
 group by 1,2,3,4 order by 1,2,3,4;
-- Q3 open balance per channel, account and line store (what a move must carry)
select s.code store, sc.name channel, sc.receivable_account_code current_code, a.code, jl.store_id,
       sum(jl.debit - jl.credit) balance
  from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
  join sales_channels sc on sc.id::text = jl.party_id and sc.org_id = je.org_id join stores s on s.id = sc.store_id
 where jl.party_type = 'channel' and je.status <> 'draft' group by 1,2,3,4,5 having sum(jl.debit - jl.credit) <> 0;
-- Q4 (only if Q0 shows 1220 requires_party = false) party-less lines on 1220
select count(*) from journal_lines jl join accounts a on a.id = jl.account_id where a.code = '1220' and jl.party_type is null;
```

**If Q3 shows a 1210 balance for a channel**, it must move to 1220 before (or as) the channel switches, per channel and
line store, dated the first open date on or after today (Manila). New POSTING-PATTERNS entry
`channel_receivable.reclass` (v2-only, T-606), e.g. Lipa Foodpanda owed ₱12,345.00:

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| 1220 Channel receivable | 12,345.00 | | channel: Foodpanda (Lipa) |
| 1210 Accounts receivable | | 12,345.00 | channel: Foodpanda (Lipa) |

A net credit balance reverses the sides. Zero balance: no entry. **Who approves:** the owner or the accountant, by being
the one who presses the button: S4 gates it on `manage_chart_of_accounts` (super admin ✅, admin ✅, manager ✗;
CAPABILITY-MATRIX line 191). **Changing the code while a balance sits on the old one is refused** (S2) with a sentence
that names the amount and the button. Trap after a move: old days' aging restarts at the move date (accepted, recorded).

## Slices (one commit each)

**S0 (only if Q0 shows 1220 `requires_party = false`).** Migration `0265_t606_channel_receivable_party.sql`, per
ADR-012 §5: pre-check `do $$ ... raise exception` if Q4's count > 0 (party-less 1220 lines would become illegal); then
`update accounts set requires_party = true where code = '1220' and not requires_party;`. Integration test in
`packages/db/tests/integration/t606-migration.test.ts`: positive (flag flips), refusal (seed a party-less 1220 line →
raises), mutant (drop the pre-check → test red). If Q0 is true, skip S0 and 0265 stays free.

**S1. One rule for the screen and the domain.**
- `packages/db/src/repo/sales-days.ts:271` today `where org_id = ${orgId} and is_postable and requires_party and status = 'active'`
  → append `and code = ${CHANNEL_RECEIVABLE_CODE}` (import from `./channel-settlements`; it imports only schema, no cycle).
  Fix the doc comments at `:267` and domain `index.ts:448`.
- `packages/domain/src/sales-channels/index.ts`, after the `requiresParty` refusal (`:118-123`), add:
  `if (!isRemittedDaily && account.code !== CHANNEL_RECEIVABLE_CODE) throw new Error(\`A channel that settles later must
  use ${CHANNEL_RECEIVABLE_CODE} Channel receivable. Settlements, platform files and wastage all read that account, so
  ${account.code} ${account.name} would leave its sales uncollected.\`)`. Keep it LAST so test 5's four refusals keep
  their messages. Replace the old hint "such as 1220" with the constant.
- `actions.ts:71` and `:93`: `receivableAccountCode: remittance(fd) ? null : receivable(fd),` (a daily channel has none).
- `page.tsx:455` `defaultValue={channel?.receivableAccountCode ?? ''}` → for an existing settle-later channel default to
  `accounts[0]?.code ?? ''` (the only option), else `''`; new channel keeps blank (T-230, no preselection). At `:257`, when
  `settlesLater && !receivable` add one muted line: *"Its sales go to {code}, which payouts and platform files don't read.
  Edit the channel and choose 1220 Channel receivable."* (S4 changes this to point at the button when a balance exists).
- Tests, `packages/domain/tests/integration/sales-channels-admin.test.ts`:
  1. create settle-later on 1220 → ok (existing line 156 already); update a 1220 channel → ok.
  2. **refusal**: create and update settle-later on active 1210 → throws `/1220 Channel receivable/`; no row / row unchanged.
  3. **agreement guard** (new `it`): `receivableAccountOptions(tx, admin)` codes `toEqual([CHANNEL_RECEIVABLE_CODE])` on a
     seeded org, and every code it returns passes `createSalesChannel` settle-later, and 1210 does not. **Mutant:** drop the
     `code =` filter → red (1210 listed); drop the domain rule → red (1210 accepted).
  Web: `apps/erp/tests/integration/t389-s2-sales-channels-web.test.ts`, a daily channel submitted with
  `receivableAccountCode=1220` saves `null`. **Mutant:** revert `actions.ts:93` → red.

**S2. No switching away from a balance.**
- `packages/db/src/repo/channel-settlements.ts`, beside `outstandingFor` (`:221`): `partyBalancesByStore(tx, orgId,
  channelId, code)` → `{ storeId, balance }[]` (same where-clause as `outstandingFor`, `a.code = ${code}`, group by
  `jl.store_id`, having `<> 0`).
- `updateSalesChannel` (`index.ts:225`, before `updateChannel`): if `channel.receivableAccountCode` is non-null and differs
  from the validated new code, and `partyBalancesByStore(...old)` is non-empty, `throw refuse(...)` with
  *"{name} still has ₱{total} owed on {old code} {old name}. An owner or admin must press "Move to 1220 Channel
  receivable" on this channel first; it moves the balance and the setting together."* (₱ format: `@shareat/core/money`).
- Tests (same file): positive (1210 channel, zero balance → switches to 1220); **refusal** (post Dr 1210 party channel
  via the file's own posting helper at line ~600 → update refused, code unchanged); also 1220 → daily with a 1220 balance
  refused. **Mutant:** delete the guard → red. Check existing `it`s that flip a channel to daily after raising 1220.

**S3. Platform paths: right sentence, right "old" figure.**
- `correction.ts:105` and `charge.ts:148`: *"{name}'s sales go to a different receivable account, so they can't be
  corrected from a platform file. Open Settings › Sales channels and set this channel's receivable account to 1220
  Channel receivable."* (charge: "...so its charges can't be booked..."). Update both file headers (`:16`, `:17`):
  the gate is permanent design, not "until slice 8".
- `correction.ts:113` today `rows.filter((r) => r.accountCode === receivable && r.partyType === 'channel' && r.partyId === channel.id)`
  → drop `r.accountCode === receivable &&`. A day posted on 1210 before the move would otherwise read `old = 0` and book
  the **whole** file figure again as sales (double revenue).
- Tests, `packages/domain/tests/integration/t511-s6b-correct-platform-sales.test.ts`: positive (day verified on 1210,
  channel moved by S4, file 11,000 vs staff 10,000 → one Dr 1220 1,000 / Cr 4150 1,000); refusal (channel still on 1210
  → the new sentence, no entry). **Mutant:** restore the account filter → books 11,000, red.

**S4. "Move to 1220 Channel receivable" (the reclass), skip only if BOSS's Q3 is empty AND the owner agrees.**
- New `moveChannelToChannelReceivable(tx, actor, { channelId })` in `packages/domain/src/sales-channels/index.ts`:
  `channelById` → `authorize(tx, actor, 'manage_chart_of_accounts', { storeId: channel.storeId })` → refuse daily
  channels; already 1220 = no-op `{ moved: false }` → lock the channel row (`for update`; `sales_channels` is mutable) →
  `partyBalancesByStore(old)` → if any: `postEntry` source_type `channel_receivable_reclass`, source_id channel id,
  idempotency key `channel_receivable_reclass:${channelId}:${oldCode}`, date via
  `fiscalPeriodsRepo.firstOpenDateOnOrAfter` as `charge.ts:168-176`, lines per store as the pattern above → set the code to
  1220 through `salesDaysRepo.updateChannel` with the channel's other fields unchanged → `auditLogRepo.append`
  `sales_channel.receivable_moved` (money, high, store scope; amount, old code) as `charge.ts:236`.
- Action + button on the card (`page.tsx` near `:257`, `actions.ts`), shown only when settle-later and code ≠ the option.
- POSTING-PATTERNS: add `channel_receivable.reclass` after the channel charge section (line 1321); regenerate the TOC
  (`npm run toc`, light) and commit it.
- Tests, new `packages/domain/tests/integration/t606-move-channel-receivable.test.ts`: positive (₱12,345 on 1210 → one
  entry Dr 1220 / Cr 1210, party channel, store = line store; 1210 party balance 0; `outstandingFor` = 12,345; code 1220);
  second call no-op, one entry; negative balance reverses sides; **refusal** manager → capability refused, nothing
  posted; **mutant** swap Dr/Cr → red; drop the code update → red.

## Migration: later, not now

A CHECK `is_remitted_daily or receivable_account_code = '1220'` would make the database the authority (RULES §6.3), but
its pre-check must refuse Lipa's 1210 rows, so it can only land after the move. File it as a follow-up task once BOSS's
Q1 shows zero settle-later channels off 1220; take the next free number then (0265 if S0 did not use it).

## Builder commands (machine at its memory limit)

Typecheck only the touched workspaces locally if memory allows (names from the root `package.json`); otherwise push the branch
and let CI run. Files that matter most: `sales-channels-admin.test.ts`, `t511-s6b-correct-platform-sales.test.ts`,
`t606-move-channel-receivable.test.ts`, `t389-s2-sales-channels-web.test.ts`, then `t592-store-code.test.ts`,
`wastage-monitor.test.ts`, `t511-s7a-approve-day.test.ts` (regressions). Census and guards touched: domain export
census (one new export, `moveChannelToChannelReceivable`) and the audit-event registry if one lists event names; re-measure
with the census script the failing test names. Normalise line endings to LF before commit.

## Out of scope

Widening settlement/aging to any code other than 1220; customer AR; the DB CHECK (follow-up); a store-readiness check
for channel receivables; restoring the original age of moved balances.

## Decisions for the owner

1. Run Q0-Q3 now (BOSS). If Q3 shows money on 1210 for Foodpanda or GrabFood, approve moving it to 1220 with S4, and
   say who presses the button (owner or the accountant as admin).
2. Accept that a 1210 channel cannot be renamed or edited until it is moved (the same guard that protects the balance).

## Rulings

- **Ian, 18 Nov: no real balance; correct by void and re-post; S4 deferred.** Lipa has no real balance on the channel receivables, so existing rows are corrected by voiding and re-posting through the normal screens, not by a new action. S4 (the one-press move) is not built. S0 (the migration) is not built either (it waits on the Q0 check).
- **Ian, 18 Nov: dine-in, Xlice and branch sales can be credit; only platform channels are pinned to the channel receivable.** This replaces "a settle-later channel may only use 1220" and "a daily channel has no receivable" (S1) and "the picker shows only 1220". Built instead: a channel with a delivery platform (the T-592 `platform` column) must use `CHANNEL_RECEIVABLE_CODE` and its card shows that account fixed; a channel with no platform keeps exactly today's choice (receivable optional, from the party-bearing list, daily or settle-later); setting a platform on a channel whose receivable is not the channel receivable is refused with a sentence telling the user to change the receivable first; S2's balance guard applies to any change of receivable; the guard test pins the platform channel's only selectable code to what the settlement path accepts. S3 is unchanged.
- **Builder note, 18 Nov:** S2's refusal sentence cannot say "press Move to 1220" while S4 is not built; it says to void and re-post the sales so the balance clears, then change the account.
- **Ian, 18 Nov: "move the foodpanda and grab sales directly"; S4 restored after the live screens showed about 40 verified days with remittances.** Lipa's Foodpanda and Grabfood channels are on 1210 with about 40 verified sales days (1 Oct to 9 Nov, source POS) and remittances posted against them, so "void each day and re-post" is not workable (T-594 refuses voiding a verified day with a remittance). S4 is built in the same PR as the platform-only rule: an admin-only "Move to Channel receivable" on a platform channel whose receivable is not the channel receivable; one transaction locks the channel, posts Dr 1220 / Cr old per store (a credit balance the other way), sets the receivable, audits (`sales_channel.receivable_moved`). Dated today (Manila) when today's month is open, else refused with nothing changed. A second press does nothing; undoing it is a normal reversal of the entry by an admin. A platform-file correction and a period charge are refused only while the channel still holds a balance on another account; after the move the old day lines stay on 1210 and the correction books the difference on 1220.
- **Builder note, 18 Nov (audit follow-ups, BOSS):** a sales day cannot be verified for a platform channel on another receivable, and such a channel cannot be re-activated; the S2 sentence never shows a negative amount ("in its favour"). DEF-925 and DEF-926 are logged open (order wastage always credits 1220; retiring a channel leaves its balance behind and the guard takes no lock on the channel row).
