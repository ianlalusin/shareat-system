# T-619: a promotion resets the person's PIN (DEF-920)

**Owner:** builder (Sonnet). An auth auditor reviews it. **Spec:** BOSS (Opus), 22 Nov 2026.
**Ian, 22 Nov 2026:** "yes", i.e. when a person is given a higher role, their old PIN stops working and they set a new one.
**No migration.**

## Rule

- When a person's role is raised (`staff` → `manager`, or anything → `admin` or `super_admin`), their PIN credential is revoked in the same transaction (`revoke_reason` "role raised to <role>"). Their sessions are ended too, because they signed in with a PIN known at the lower role.
  - Find the role writer (`assignRoleAsActor` / the roles module in `packages/auth`) and do it there, so every path is covered.
- A **lateral or lower** change (manager → staff, admin → manager) does **not** reset the PIN; the role loss already narrows access.
- The person then sets a new PIN through the existing Set PIN action. The rights to issue that PIN already follow T-603 S1 (a manager's or admin's PIN needs `manage_users`).
- One audit row, `credential.pin_reset_on_promotion`, with the old role and the new role. Raise the catalogue ceilings honestly.
- **The staff record and user page:** after a promotion, show "PIN reset: set a new PIN" until one is set.

## Tests (each with a mutant that goes red)

1. staff → manager: the old PIN no longer signs in, sessions are ended, and the audit row is written.
2. manager → admin: same.
3. manager → staff: the PIN is unchanged.
4. Setting a new PIN after promotion works.

- **Mutant:** skip the revoke, and test 1 goes red.
- **Pins:** the auth census, the audit catalogue ceilings, t343, domain-actions-have-callers, and the T-412 destructive census if a control is added.
