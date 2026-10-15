// T-394 S1 fixture: freezes `new Date()` and `Date.now()` at T394_FAKE_NOW (an ISO instant) in a child process, so a test can run
// scripts/cutover-purge.ts "at 07:30 Manila on 1 January 2027" (DEF-641 / R8). Loaded with NODE_OPTIONS=--require <this file>.
const fixed = Date.parse(process.env.T394_FAKE_NOW || '');
if (!Number.isNaN(fixed)) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FakeDate;
}
