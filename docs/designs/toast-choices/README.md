# Toast notification — five directions

One flat brand-yellow surface (`#F5D76E`), no background pattern, same confirmation anatomy
(title · what happens · one explicit action · cancel · close). Each direction changes the **button**
and the small structural cue, not the colour.

Full board: [choices.png](../../reviews/t568/s4-toast-design/choices/choices.png)

| # | Direction | Button idea | Best for |
|---|---|---|---|
| 01 | **Keycap** | Black keycap with a 3 px lip that presses down on click | Destructive confirms; makes the action feel physical |
| 02 | **Ticket** | One pill split into a cream label and a red arrow cell | Operational sequences; terminal/order actions |
| 03 | **Rule** | No box — a 3 px red rule draws itself under the words | Dense forms; quiet, editorial confirmations |
| 04 | **Inset** | Cream capsule set into the yellow, with a red status dot | General-purpose default; softer, product-like |
| 05 | **Tab** | Red file tab sitting on the bottom edge, with a folded corner | Ledger, record and document decisions |

## Individual cards

- [01 Keycap](../../reviews/t568/s4-toast-design/choices/choice-1.png)
- [02 Ticket](../../reviews/t568/s4-toast-design/choices/choice-2.png)
- [03 Rule](../../reviews/t568/s4-toast-design/choices/choice-3.png)
- [04 Inset](../../reviews/t568/s4-toast-design/choices/choice-4.png)
- [05 Tab](../../reviews/t568/s4-toast-design/choices/choice-5.png)

## Recommendation

**04 Inset** as the base toast for the whole app, with **01 Keycap** reserved for destructive
confirms (release terminal, re-issue PIN, delete). That gives one calm default and one deliberately
physical warning, without maintaining two visual languages.

The mockups are in [index.html](./index.html); colours are the app tokens:

| Token | Value |
|---|---|
| Flat brand yellow | `#F5D76E` |
| Ink | `#241F18` |
| Brand red | `#D40909` |
| Cream | `#FFF7DD` |

Pick a number and I will implement it in the ERP `Toaster` and the POS `use-toast` primitive.
