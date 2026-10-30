# Store roster — v1 ids → names

Confirmed by Ian 2026-08-24. **This is the mapping the `stores` table seeds from**, and the
`legacy_code` every ETL row joins on.

| v1 store id | Name | Status | Docs captured |
|---|---|---|---:|
| `b9DzsnPbr1BUnY88lyT4` | **SharEat Lipa** | operating | 9,468 |
| `dZUyvX4q824JBSVDAfE9` | **SharEat Malvar** | operating | 6,732 |
| `iGOW7q2pZbeHWV832UNh` | **SharEat Banay-Banay** | operating; **closes 31 Dec 2026**, bought back by Lipa; not in v2 (rows 377, 384) | 2,864 |
| `eVYKj6wABdakk8RgEotW` | **SharEat Davao** | operating, opened ~2026-08-16 | 294 |
| `y1DMgfisuTHBF57cNL6i` | **SharEat Padre Garcia** | ⚠️ **A FRANCHISE — separate owner.** 0 documents; not yet trading, and when it does it is a **separate company**, not a store of Ian's org. See ADR-008 | — |
| `XbkyEgZqunmj2wzhicNf` | TEST | test store — **exclude** | — |
| `TEST` | Test Commissary | test store — **exclude** | — |

**Four operating stores (three in v2). 19,358 documents** across `journal`, `expenses` and `salesDays`.

## ⚠️ Read this before listing stores anywhere

The first listing of this collection was capped at 5 documents and **treated as complete**. It
silently omitted **Banay-Banay — the third-largest store, 2,864 documents** — and Padre Garcia.
Every count and every total derived from it was wrong, and nothing about the output said so.

Ian caught it by naming a store that was not in the list.

**Never derive a store list from a capped query.** `stores` is tiny (7 documents); read all of it.
The same applies to any "list the things" step in the ETL — a cap that exists for safety becomes a
silent correctness bug the moment its output is treated as the whole set. If a listing is capped,
the cap must appear in the output next to the number.
