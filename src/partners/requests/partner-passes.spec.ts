import { DESK_PASS_FROM_MS, passOnDesk } from './partner-passes';

const HOUR = 3_600_000;
const start = new Date('2031-01-13T10:00:00.000Z');
const end = new Date('2031-01-13T12:00:00.000Z');
const r = { passId: 'p', agreedStartsAt: start, agreedEndsAt: end };
const at = (ms: number) => new Date(start.getTime() + ms);

describe('a service pass on the desk (ADR 0060)', () => {
  it('shows from two hours before the window starts until it ends', () => {
    expect(DESK_PASS_FROM_MS).toBe(2 * HOUR);
    expect(passOnDesk(r, true, at(-2 * HOUR - 1))).toBe(false);
    expect(passOnDesk(r, true, at(-2 * HOUR))).toBe(true);
    expect(passOnDesk(r, true, at(HOUR))).toBe(true);
    expect(passOnDesk(r, true, end)).toBe(false);
  });

  it('never without the consent, a pass or an agreed window', () => {
    expect(passOnDesk(r, false, at(0))).toBe(false);
    expect(passOnDesk({ ...r, passId: null }, true, at(0))).toBe(false);
    expect(
      passOnDesk(
        { passId: 'p', agreedStartsAt: null, agreedEndsAt: null },
        true,
        at(0),
      ),
    ).toBe(false);
  });
});
