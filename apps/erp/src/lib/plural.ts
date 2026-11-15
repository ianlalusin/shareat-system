/** The word for a count: `plural(1, 'field', 'fields')` is "field", every other count (0 included) is "fields". The number is the caller's: `${n} ${plural(n, 'row', 'rows')}`. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
