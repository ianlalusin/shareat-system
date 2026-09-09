# T-254 — DEF-248: the two dead dark-mode classes on the cutover back-links

> **Status: RESERVED by the orchestrator, 2026-09-10. Assigned to lane B, AFTER T-253.**
> Number reserved so no peer takes it. Nothing below is built.

Both `cutover` back-links carry `text-neutral-500 … dark:text-neutral-500`, where the dark variant
restates the light value, so it can only have been meant to be something else. Every sibling
back-link in the app uses `dark:text-neutral-400`.

| File | Line |
|---|---|
| `apps/erp/src/app/cutover/count/page.tsx` | 48 |
| `apps/erp/src/app/cutover/opening/page.tsx` | 50 |

Siblings that establish the convention: `admin/users/[personId]:50`, `items/[id]:57`,
`staff/hire:56`, `staff/[employmentId]:41`.

- One class per file: `dark:text-neutral-500` → `dark:text-neutral-400`.
- ⛔ **Ships as its own commit, separate from T-253.** DEF-248's own register row records why it was
  kept out of T-250: *"a diff that silently repaints two links while resizing five is an
  unreviewable diff."* Bundling it now would repeat the mistake the row exists to name.

See `docs/DEFECTS-REGISTER.md` DEF-248. Found 2026-09-09 by lane B while specifying T-250.
