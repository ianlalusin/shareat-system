# T-568 S2 - Administrator PIN row on /staff

Ian, 2026-11-09: the PIN field sits on the same row as its button, and issuing asks for a confirmation first.

| Before | After |
|---|---|
| "New PIN (6 digits)" field above its own button, nothing asked before issuing | Field and button on one row; submitting opens a dialog that explains what an administrator PIN approves, that a new PIN replaces the old one and ends live sessions, and that it must be handed over privately |

- [Admin PIN row - desktop](./compare-pin-inline-desktop.png)
- [Confirmation - desktop](./after-pin-confirm-desktop.png)
- [Confirmation - phone](./after-pin-confirm-phone.png)

Audit fixes (UI-001, UI-006, UI-007) are described in docs/tasks/568-groups-pass.md, S2.
