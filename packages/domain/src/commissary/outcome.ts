/**
 * ⭐ One definition, because two would be two.
 *
 * `transfer.ts` and `discrepancy.ts` each declared their own `Outcome<T>` with identical bodies,
 * which type-checks perfectly inside each file and collides the moment both are exported from the
 * package barrel. ⚠️ The collision is the useful part: it is the only thing that asks whether two
 * same-named types are the same idea. Here they were, so this file exists; `PostingResult` was
 * asked the same question on the same day and the answer was no (DEF-097).
 */
export type Outcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string };
