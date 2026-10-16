/**
 * T-423 S1 - exact fractions for bill math (Ruling 2). BigInt numerator/denominator, so a stage like
 * "net / 1.12" or "qty x price x 8.25%" is carried without float error and rounded half-up ONLY where v1 rounds.
 * This is stronger than the scaled-integer approach the spec names (the spec's own oracle uses the same fractions).
 * Amounts inside a calculation are in CENTAVOS.
 */

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};

export class Exact {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  /** An integer (centavos, a quantity). */
  static int(x: number): Exact {
    return new Exact(BigInt(Math.trunc(Number.isFinite(x) ? x : 0)));
  }
  /** A decimal number (a percent, a rate, a quantity) read digit for digit. Non-finite -> 0. */
  static of(x: number): Exact {
    if (!Number.isFinite(x)) return ZERO;
    let s = String(x);
    if (/e/i.test(s)) s = x.toFixed(12);
    const neg = s.startsWith('-');
    const [i = '0', f = ''] = s.replace('-', '').split('.');
    const v = new Exact(BigInt(i + f), 10n ** BigInt(f.length));
    return neg ? v.neg() : v;
  }
  add(o: Exact) { return new Exact(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Exact) { return new Exact(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Exact) { return new Exact(this.n * o.n, this.d * o.d); }
  div(o: Exact) { return new Exact(this.n * o.d, this.d * o.n); }
  neg() { return new Exact(-this.n, this.d); }
  cmp(o: Exact) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  gt(o: Exact) { return this.cmp(o) > 0; }
  lt(o: Exact) { return this.cmp(o) < 0; }
  min(o: Exact) { return this.lt(o) ? this : o; }
  max(o: Exact) { return this.gt(o) ? this : o; }
  isZero() { return this.n === 0n; }
  /** Rounds to a whole number, half goes up (away from zero for negatives). Returns a JS number (safe integer). */
  roundHalfUp(): number {
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const r = (2n * a + this.d) / (2n * this.d);
    return Number(neg ? -r : r);
  }
}

export const ZERO = new Exact(0n);
export const ONE = new Exact(1n);
export const HUNDRED = new Exact(100n);
