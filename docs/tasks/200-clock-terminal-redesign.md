# T-200 — The clock terminal, redesigned around what the staffer actually does

> **Status:** ✅ **BUILT AND COMMITTED 2026-08-31** (`4242f1f`). Hot-set item 4 rendered at last; the in/out toggle removed and the intent derived. Verified live against the Firebase emulator. ⚠️ Breaks parked at Ian’s instruction.
> Specced 2026-08-31 · Ian, 2026-08-31: *"3. plan well and build a better one then.
> your call. park the break dont build yet."*
> **Depends on:** T-198 (the day feed is now scoped — ⛔ and §6 depends on that being true)
> **Closes:** the on-shift-roster and punch-feed halves of **DEF-116**
> **Reference read at source:** `ERP-rebuild/src/app/operation/attendance/time-clock/page.tsx`
> (1,070 lines, in daily use)

---

## 1. Design intent

| | |
|---|---|
| **Goal** | Record a punch in under three seconds, and show the floor who is on it — **with the network down** |
| **User** | A cook or server at shift change. Tablet mounted by the door, wet hands, a queue behind them |
| **Primary action** | ⭐ **One: present a badge.** Everything else on the screen is subordinate to it |
| **Direction** | An **operator** surface, not a consumer one. Dense but calm, high contrast, large targets. ⛔ **No glass, no glow, no gradient** — a wet finger under kitchen lights needs contrast, not effects. Monospace for times |

---

## 2. What is wrong with the current screen

| | |
|---|---|
| ⛔ **The in/out toggle** | You must declare intent **before** identifying yourself. The system already knows which you are. Two costs: an extra tap on the critical path, and a whole class of wrong-intent punches that then need a manager |
| ⛔ **No on-shift roster** | Nobody — staffer or manager — can see who is on the floor. This is hot-set item 4, mirrored and *never rendered* |
| ⛔ **No punch feed** | The staffer has no evidence their tap landed beyond a sentence that vanishes. **This is what produces the anxious double-tap** that DEF-088 and `MINIMUM_CREDITABLE_MINUTES` exist to clean up afterwards |
| ⚠️ **Confirmation does not show WHO, largely enough** | A small line of text. At a glance you cannot tell whether it read your badge or the one behind you |
| ⚠️ **Flat hierarchy** | Status line, toggle, input, message and counts all read at roughly one weight. No focal point |
| ⚠️ **Sync state is the smallest text on the page** | It is the single most reassuring fact the screen holds when the network is down |

---

## 3. ⛔ The one place I am NOT copying v1 — and why

v1's on-shift roster is **tappable**: you clock out by touching your own row (`pendingRow`, intents
`break-start | break-end | out`).

**v2's roster is read-only. A punch always requires the credential.**

⭐ The reasoning: in v1 the fingerprint reader is the primary path and the row-tap is its fallback,
so the tap earns its risk. In v2 the badge *is* the primary path — so a tappable row adds **no
speed** (you still need to be there) while adding a real fraud vector: **clocking a colleague out
early costs them money**, silently, and the audit trail would record it as their own punch.

⚠️ Bible §7 rule 6 is *"no one approves, pays, adjusts, or scores their own record"* — this is the
neighbouring principle: **no one punches anybody else's.** The roster's value is *visibility*, and
visibility does not require a tap target.

⛔ If the row-tap is ever wanted, it needs the badge to confirm — at which point it saves nothing.

---

## 4. Layout — phone portrait is the canvas

```
┌──────────────────────────────────┐
│ ● Online          3 waiting ⟳    │  status strip — always visible, never scrolls away
├──────────────────────────────────┤
│                                  │
│    ╔══════════════════════════╗  │
│    ║   Scan or tap your badge ║  │  ⭐ THE focal point: ~30% of the viewport,
│    ╚══════════════════════════╝  │     autofocused, refocused after every action
│                                  │
├──────────────────────────────────┤
│ ON SHIFT NOW                 (4) │
│  Maria Santos        since 14:00 │  read-only (§3)
│  Ana Cruz            since 15:00 │
├──────────────────────────────────┤
│ TODAY                            │
│  14:02  Maria Santos          in │  the evidence that stops the double-tap
│  13:58  Jose Reyes           out │
└──────────────────────────────────┘
```

Tablet (`md:`) puts *on shift* and *today* side by side under a full-width scan panel. **Not a
squished desktop** and not a stretched phone — the scan panel stays dominant at both sizes.

**Type scale** 12 / 14 / 16 / 20 / 32 · **spacing** 4 / 8 / 12 / 16 / 24 / 32 · touch targets
**≥ 44px** · tabular numerals for every time.

---

## 5. The punch flow

1. **Badge presented** (a USB reader and a QR scanner both *type* — the text box is the real
   interface, not a placeholder for one).
2. ⭐ **Intent is DERIVED, not chosen.** The terminal knows from the mirrored day feed whether this
   person has an open day: open ⇒ `out`, otherwise ⇒ `in`. ⚠️ The field is called
   `assertedIntent` precisely because it is a claim the server re-adjudicates — deriving it is
   using the field as designed, not bypassing a check.
3. **Confirmation takes over the scan panel** for ~4 seconds: the person's **name at 32px**, `IN`
   or `OUT`, the time. Then it returns to the scan prompt. ⚠️ Feedback within 100ms, from the
   mirror — never waiting on a server round trip (the existing `void acknowledged.catch` contract
   is preserved exactly).
4. ⛔ **Post-punch cooldown, per person, 30 seconds.**

### 5.1 The cooldown, and why it is per-person

v1's comment records a **measured** incident: *"a ~25s gap between the clock-out and the stray
clock-in it triggered"*, and its fix is precise — exclude **that one person's** credential briefly
rather than freezing the reader:

> *long enough that a blanket re-arm delay can't cover it without stalling the whole terminal for
> everyone else queued behind them.*

⭐ Copy the shape, not just the number. A global lock punishes the queue; a per-person one closes
the gap for nothing. The person's row shows the countdown so the behaviour is **visible rather than
mysterious** — a badge silently ignored is indistinguishable from a broken reader.

⚠️ This prevents the *cause* that `MINIMUM_CREDITABLE_MINUTES` currently cleans up after.

---

## 6. ⛔ Reading the feed — the constraint T-198 left behind

T-198 scoped the *trigger*, so nothing new is published for old days. **It could not retract what
was already pushed**, and those documents are still in Firestore.

⛔ **So this screen must QUERY by `shiftDay`, never subscribe to the whole collection:**

```ts
query(collection(db, `mirror/${storeId}/dayFeed`), where('shiftDay', '>=', yesterday))
```

A collection subscription reads what *is* there, not what we meant to put there — it would pull the
entire historical backlog onto the tablet on first load, which is the exact cost T-198 just removed.

⚠️ `onSnapshot`, not `getDocs` — the existing lane's reasoning holds: *"a listener is fed from the
cache immediately and then updated when the server has something newer."* Offline is a normal
state here, not an error.

---

## 7. States — all of them designed

| State | Treatment |
|---|---|
| Offline | ⭐ **Normal, not an error.** Amber chip, *"punches are saved here"*. The design assumes it |
| Punches waiting | Count in the status strip, promoted from footnote to the strip |
| No config mirrored yet | Explicit — the terminal cannot judge a shift it has no policy for |
| No badges known | Explicit and actionable, not an empty box |
| Nobody on shift | *"The floor is empty."* Not a blank panel |
| No punches today | *"No punches yet today."* |
| Punch refused later | The existing late-arriving refusal path is preserved verbatim |
| Cooldown | The person's row shows a countdown |

---

## 8. Scope

**In:** `apps/erp/src/app/clock/page.tsx` (rebuilt), `apps/erp/src/lib/terminal/lane.ts`
(a scoped `dayFeed` watcher + its type), small presentational components co-located with the page.

⛔ **Out, each with a reason:**

| Not built | Why |
|---|---|
| ⛔ **Breaks** | ⭐ **Ian, explicitly: *"park the break dont build yet."*** The schema has `break_start`/`break_end` and `computeDay` deducts break excess over the allowance, so the rules exist and are unreachable — **that is a live gap and it stays logged, not fixed here** |
| ⛔ Tappable roster rows | §3 |
| ⛔ Fingerprint / face capture | T-185's credential lane owns those; this task changes no credential path |
| ⛔ Any change to `writePunch` or the outbox | The offline contract is correct and load-bearing. This is a presentation task |
| ⛔ Deleting the stale `dayFeed` docs | T-198 §5 — a destructive one-off against live storage, and §6 makes it unnecessary for correctness |

---

## 9. Done when

- [ ] typecheck · unit · integration · build.
- [ ] ⭐ **Smoketested on 9008 in a browser at BOTH phone width and tablet width.** ⚠️ The last two
      tasks could not confirm phone width because the harness would not resize the viewport — if it
      still will not, say so plainly rather than claiming it.
- [ ] The derived-intent path verified live: same badge twice ⇒ `in` then `out`, no toggle touched.
- [ ] The cooldown verified live: the same badge inside 30s is ignored **and says so**.
- [ ] Offline verified: the roster and feed still render from cache with the network cut.
- [ ] `docs/ROADMAP.html` updated; DEF-116's remaining halves closed.
