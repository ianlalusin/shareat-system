# T-618: the remaining open defects (DEF-921, 922, 925-930)

**Owner:** builder (Sonnet), with a Sonnet money auditor. **Spec:** BOSS (Opus), 22 Nov 2026.
**Source:** each DEF's row in `docs/DEFECTS-REGISTER.md` on main. **Read each row in full first;** the row states the defect and often the fix.
One commit per DEF, each with a test that fails without the fix (a mutant). Mark the row fixed (T-618). No migration expected; if one seems needed, stop and report.

| DEF | Short | Notes |
|---|---|---|
| 921 | Other writers of the inter-store pair skip the store-pair lock | Make every writer of the 1250/2150 pair take `lockInterStorePair` in the same order as T-594 (`createMoneyTransfer`, `voidMoneyTransfer`, `settleBetweenStores`): the channel settlement cross-store loan legs and any other writer the row names. Test a race. |
| 922 | Settlement vs approve-day lock order | `recordChannelSettlement` takes loan rows then the day; approve-day takes the day then the loans. Pick one order (the day first, as approve-day does) for both. Test two concurrent paths: no deadlock. |
| 925 | Order wastage credits 1220 for any channel | Credit the channel's **own** receivable account (as T-606 made sales days do), not `CHANNEL_RECEIVABLE_CODE` always. |
| 926 | Retire and re-create strands a channel balance; no row lock in the receivable guard | Refuse to retire a channel with a non-zero receivable balance (plain sentence), and take the channel row lock in the `updateSalesChannel` receivable-change guard. |
| 927 | Sales channels receivable picker offers cash, payable and equity accounts | Limit the picker **and** the server check to receivable accounts. |
| 928 | A non-platform settle-later card says "Owed by the platform" | Wording and the platform picker show only for platform channels. |
| 929 | A stale-tab replay of the channel move flashes "nothing to do" | Read the row's register text; make the replay give the true current state. |
| 930 | A POS correction that zeroes a platform line nets on the OLD account after a move | Net against the channel's current account, per the register row. |

## Out (with reasons)

- **DEF-920** (PIN not reset on a role upgrade): needs Ian's decision.
- **DEF-923** (remittance with a pre-T-594 voided leg): needs a production check and a one-off repair, which is BOSS's job with Ian.
