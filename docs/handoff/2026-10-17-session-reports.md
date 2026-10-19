# Side-session reports, 17 Oct 2026 (saved before Ian cleared the sessions)

Three sessions ran beside the orchestrator on 17 Oct. Ian cleared them at wrap-up; this file is
their last known state so a fresh session can re-adopt the work. Each was paused by Ian ("pause
work for now") with everything committed.

## 1. POS v2 build — was session `local_69ee3ed8…` ("POS v2 build (PC-3, PC-7, PC-0)")

- **Worktree:** `C:\Users\ianla\webapps\shareat-system\.claude\worktrees\pos-v2-907a29`
  (a NESTED worktree — walkers must skip `.claude/`, DEF-669).
- **Branch:** `claude/pos-v2-907a29` at **`68b5c39`**. Local only — NOT pushed, NOT merged into main.
  (Orchestrator rule: another session's branch is merged/pushed only on Ian's own word.)
- **Tasks (numbers 425-429 are this lane's):**

| Task | State at pause |
|---|---|
| **T-425** offline selling (PC-5) | Built, committed as WIP, **not audited**. The builder disputes two tests: `reconcile.test.ts:211` and `xSlipFormatter.test.ts:100` — a tester must rule on them, then audit. |
| **T-426** senior/PWD discount (PC-6) | Spec reviewed twice + red tests committed (`4c984da`). Build not started. Law notes in the spec: RA 9994 §9 whichever-is-higher; DOJ Legal Opinion 45 (2024) — a PWD's 20% covers only food the PWD alone ate (own package head + dishes marked theirs). |
| **T-427** Convert (GCash cash-in/out; bible row 359) | Spec + red tests committed (`eea1b0a`, `e9830c6`). Build not started. Orchestrator ruling: a Convert that takes a method below zero is recorded and the day flagged (not refused); gated on an open ERP till shift (row 319). v1 data: 588 conversions (Lipa 546, Malvar 42), 0 negative days in 120 days — the ERP-side conversion import is a follow-up, not a go-live blocker. |
| **T-428** POS v2 till screen | Research done. Key finding: the ERP terminal person cannot be the Actor for till actions; it needs the cashier's own ERP identity or a PIN. Spec not written. Must land before 11 Jan (first store on v2, row 348). |
| **T-429** | Reserved: build the redesigned table + payment screens once Ian approves the mock-ups (PC-7 mock-up v3: https://claude.ai/artifact/K84oKCZbCcU7DW1xtT9Xox; Ian agreed the payment screen; rows 357-358 stand numbers, package + à la carte). |

- **Defect it reported:** DEF-677 (logged) — `apps/pos/scripts/build-cap.mjs` deleted `apps/pos/src/server`
  (22 files) during an APK build; restored from git, nothing lost. Fix: merge the stash back in a `finally`,
  never delete a non-empty stash.
- **Open Questions it posted for Ian:** stand numbers (refuse a stand already in use? how many stands per
  store?), the senior/PWD share question (updated to the DOJ opinion).

## 2. Customer v2 skeleton — was session `local_4e0ed25b…` (started by the POS v2 session)

- **T-437** Customer v2 minimum skeleton: 8 diner screens on sample data, no live data path.
- Branch `claude/customer-v2-mvp-3920d6` at **`6e6040e`** — **already merged into main** (17 Oct, Ian's
  "yes merge it") and **live** with PR #35 (not used by anyone yet).
- Dev server for `apps/customer`: port **9010** (`.claude/launch.json` "customer").
- Paused clean: no agents, tree clean, dev server stopped.

## 3. POS v1 safe void + birthday song — was session `local_c7884b55…` (works in `C:\Users\ianla\webapps\POS`)

POS v1 is a reference repo for shareat-system, but this session worked in it directly on Ian's instruction
(his own live POS, branch `sev5_advanced`). Everything is pushed to GitHub; last commit **`a0e5a7d3`**.

- **Safe receipt void:** the receipts page now routes to the safe (transactional) void — the 27 Jun
  double-void bug. Shipped in tablet app builds from #239 on.
- **Birthday song:** cake button on the cashier screen (SharEat song then Happy Birthday until Stop);
  on/off badge; weather badge hiding. Suno prompt + lyrics delivered to Ian.
- **PIN crash fix:** the PIN cleanup tried to update a table record already deleted when a bill is paid.
  Live on the POS web server (`shareat-build-2026-10-17-006`, 07:07 UTC); not yet confirmed the errors stopped.
- **Fonts:** stored inside the project, so builds no longer depend on Google's font site.
- **Data cleanup (live Firestore):** 7,668 old customer "joins" on 5,464 closed tables marked "ended"
  (nothing deleted, each stamped by the cleanup); 11 active joins left = 7 tables open at the time.
- **Tablet builds:** #239..#244 green. **Install #244** (safe void + birthday switch + weather badge +
  PIN fix + fonts) on ONE tablet first: void a test receipt and check the day's totals drop once; test the
  pink cake (play, stop, restart).
- Unsaved: only its local `.claude/launch.json`.
