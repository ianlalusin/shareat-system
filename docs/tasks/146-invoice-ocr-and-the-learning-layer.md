# T-146 — Invoice OCR and the learning layer

> **Status:** ⏸️ **PARKED — captured, not scheduled.** Ian, 2026-08-28: *"plan on adding this soon
> but for now stick with the roadmap."* Written down immediately so it does not live only in a
> transcript (bible §3.5 — the wrap-up rule that a decision or requirement in chat is a lost one).
> **Depends on:** ⭐ **T-145 (item master + supplier invoice lines) — hard prerequisite, see below.**
> Also T-130 (the verify gate this plugs into) and T-141 (the photo it reads).
> **Not yet specced.** This is a captured requirement, not a design.

## What Ian asked for, in his own words

> *"can we use ocr to pre ready the expense items based on invoice picture so we set up a brain
> that continuosly learn tags supplier to expenses then it also monitors the price change can be
> ussed to compare multiple suppliers of same product. it remembers the category of the expesne so
> when an invoice gone verified it has preloaded expense that can be confimed manually"*

Five distinct capabilities, worth separating because they have different difficulty and different
prerequisites:

| # | Capability | Notes |
|---|---|---|
| 1 | **OCR the receipt photo into draft invoice lines** | The photo already exists and is brokered (T-141). Output is a *proposal*, never a posting |
| 2 | **Learn supplier → expense category** | So a verified invoice arrives with its expense pre-filled |
| 3 | **Pre-load the expense for manual confirmation** | ⭐ Confirmation stays human. This is a typing saver, not an approver |
| 4 | **Monitor price change** | Already delivered by T-145's `priceMovement` — this task only adds the *alerting* on top |
| 5 | **Compare multiple suppliers of the same product** | Needs one item identity shared across suppliers — T-145's `items` table |

## ⭐ Why T-145 is a hard prerequisite, not a nicety

Every one of the five collapses without org-level item identity:

- **OCR output has nothing to match against.** "PORK BELLY 45KG @290" is a string until there is an
  `items` row to resolve it to. Matching to free text would recreate v1's 187-duplicate-names
  problem at machine speed.
- **Supplier comparison is meaningless without a shared key.** "Who sells pork belly cheapest" is
  only answerable if all three suppliers' lines point at the same `item_id`.
- **Price alerting needs a normalised base price.** T-145's snapshotted `conversion_factor` is what
  makes ₱/kg comparable when one supplier bills by the case and another by the kilo.

So the sequencing is already right: T-145 first, this second. Nothing here is wasted by waiting.

## Design notes worth keeping (not decisions)

- ⛔ **OCR proposes; a human disposes.** T-130's four attestations (`attested_supplier`,
  `attested_invoice`, `attested_items`, `attested_price`) are the natural confirmation surface —
  the machine fills the lines in, and the manager still ticks the four boxes against the photo.
  An OCR'd invoice that self-verifies would undo the entire gate built on 2026-08-28.
- ⚠️ **A "brain that continuously learns" needs a correction signal.** The useful one is free:
  every time a human edits an OCR-proposed line or re-categorises a pre-filled expense, that edit
  is a labelled training example. Capture it deliberately from day one; retrofitting it is much
  harder.
- ⚠️ **Confidence must be visible per field**, not per document. A line where the quantity is
  certain and the price is a guess should say so, or people will trust the whole thing or none
  of it.
- ⚠️ **Philippine supplier receipts are frequently handwritten**, and thermal print fades. Expect
  a real floor on accuracy and design the flow so a failed read costs nothing more than typing it
  the way it is typed today.
- 🔸 **Provider is open.** The project already runs Groq for AI (`project_ai_provider_groq_switch`)
  and has a cost history worth consulting before assuming a vision model is cheap at this volume —
  August alone was 361 receipts.
- 🔸 **Category learning is a per-org model, never cross-org.** Franchise isolation is a settled
  rule here (bible §12); a model trained across orgs leaks purchasing patterns between owners.

## Out of scope when it is specced

Auto-posting anything · auto-approving anything · replacing the photo requirement · any change to
who may verify.

## ⭐ Scaffold — Ian has a repo in mind

Ian, 2026-08-28: *"there is an open source ocr repo on github we can take as scaffold."*

⚠️ **Which one is not recorded yet — get the URL from Ian before this is specced**, because it
changes the shape of the task substantially (a self-hosted model is an infrastructure decision;
a client library around a hosted API is not).

Questions to settle against whichever repo it is, before adopting it:

- **Licence.** Anything copyleft that would attach to this codebase is a decision for Ian, not an
  implementation detail. Check before the first `npm install`, not after.
- **Self-hosted or API?** Self-hosted means the invoice photos never leave — genuinely relevant,
  since these are the org's own purchasing records and DEF-070 already showed how loosely v1
  treated receipt images. A hosted API means a per-page cost against 361 receipts a month.
- **Does it do layout/table extraction, or plain text?** Plain OCR returns a wall of text; getting
  *lines* out of it (description, qty, unit, price, per row) is the actual hard part and is where
  most of the value sits.
- **Vendor or depend?** ⛔ The bible's rule against a second source of truth applies to code too —
  a vendored copy that drifts from upstream is a maintenance burden nobody signed up for. Prefer a
  dependency unless the licence or the offline requirement forces a fork.

## Open questions for Ian, when this comes off the shelf

- Should a high-confidence OCR result skip the **items** attestation, or is the human tick
  required regardless? (Recommendation: required regardless — the tick is the control.)
- Is supplier comparison a report, or an alert at the moment of recording ("Malvar pays ₱30/kg
  less for this")?
- Does price-change alerting go to the manager who records, or to whoever owns purchasing?
