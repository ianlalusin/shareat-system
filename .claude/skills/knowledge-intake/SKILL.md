---
name: knowledge-intake
description: >
  Use when Ian feeds plain-language (English or Taglish) information about how Shareat operates —
  customer journey, staff SOPs, store rules, policies, roles — to be stored in the knowledge/
  folder, the central knowledge base a future staff/customer AI will read. Also use when he says a
  rule changed, asks "where is X documented", or asks to update the knowledge base. Clarifies,
  chunks, labels, maps to the index, updates every affected page, and never writes before his OK.
---

# Knowledge intake

`knowledge/` is the single source of truth about how Shareat **operates** (not how the code works —
that is `docs/`). A future AI will answer staff and customers from it, so a wrong or vague page
becomes a wrong answer to a real person. Ian, 2026-10-23.

**Read `knowledge/INDEX.md` before anything else.** It is the map; never search the folder blind.

## The five steps — in order, every time

### 1. Digest and clarify
- Ian writes in English or Taglish, plain language. Restate what you understood in clean English,
  in a few short lines, so he can see you got it.
- **Ask until nothing is vague.** One question per message, plain words. Check the usual gaps:
  who does it (position), which stores (all, or one), when (always, peak, opening/closing), what
  triggers it, exceptions, "what if" cases, and what happens if it is not done.
- A guess he can correct beats an open question: *"I'm guessing this applies to all four stores?"*
- ⛔ Never fill a gap yourself. An unconfirmed detail does not go on a page.
- ⛔ **Must-be-exact topics** — allergens, refunds, voids, cash and money handling, discounts,
  anything legal or statutory: every number and condition must come from Ian, word for word in
  meaning. If he does not know, the page says "Ask a manager" for that point.

### 2. Chunk (skip if small)
- If the input covers more than one topic, split it: one page per topic. A page answers one
  question a staff member or customer would actually ask.
- Small input that fits one topic stays one chunk. Do not split for the sake of it.

### 3. Label
Each chunk gets the label block below (exact keys; lowercase values):

```yaml
---
title: Customer journey — arrival to ordering
topic: customer-experience/arrival     # path in the index tree
about: [customer, cashier]             # who the page is about
readers: public                        # public | staff | managers
must_be_exact: false                   # true for allergens, refunds, cash, discounts, legal
related: [staff/cashier-duties]        # other pages this one must agree with
updated: 2026-10-23
---
```

- `readers` decides who the future AI may show it to. When unsure, pick the **narrower** audience
  (managers over staff over public) and say so to Ian.
- New `about` values or a new top-level topic: propose it to Ian, do not invent silently.

### 4. Map and find everything it touches
- Place each chunk in the index tree (`topic`). Reuse an existing page if one already covers it.
- **Find every affected page**: search INDEX.md by `about` label and topic, then follow `related`
  links both ways. One change usually ripples — e.g. "customers now order through the app" changes
  the customer journey AND the cashier SOP AND the server SOP.
- **Conflict check**: read each affected page. If the new info contradicts it, the new info wins
  (Ian's latest word supersedes) — but name the conflict to him explicitly in step 5.
- ⛔ Never type facts the system already holds — prices, the menu, store hours, promos, staff
  names. Write "see the current menu in the system" instead. Those change too often to copy.

### 5. Show, wait, then write
Show Ian, in one short message:
- each page that will be **created / changed / deleted**, with its path;
- for a change: the old point → the new point, in a line or two (not the whole page);
- any conflict found and how it is resolved;
- the labels you chose, especially `readers`.

**Wait for his explicit OK.** Then:
1. Write the pages — **overwrite** old content; git keeps history. No "replaced on" notes.
2. Update `related` on every page touched, in both directions.
3. Update `knowledge/INDEX.md` (rules below).
4. Commit only the knowledge files: `knowledge: <short summary>`. Push follows the project's
   normal rule (at wrap-up).

## INDEX.md rules
- One row per page: path · title · topic · about · readers · one-line summary · updated.
- Rows grouped under the topic tree headings, in tree order.
- The labels table at the top lists every `about` value and every topic in use. Keep it exact —
  a future AI filters by it.
- The index and the pages must agree. If you find a page missing from the index (or the reverse),
  fix it and tell Ian.

## Page rules
- Plain English, short sentences, numbered steps for procedures.
- One page = one topic. If a page passes ~80 lines, propose splitting it.
- File name = kebab-case of the title, inside the topic folder: `knowledge/<topic path>.md`.

## Red flags — stop
- You are about to write a page and Ian has not said OK to this exact change.
- A detail on the page came from you, not from Ian.
- You changed one page and did not check its `related` pages and its `about` label siblings.
- A price, hour, or menu item is typed into a page.

## Later (not now)
This folder moves into the database (edited inside ERP) after the 1 January 2027 cutover; a
one-time import reads these label blocks. Until then, git is the home. Ian, 2026-10-23.
