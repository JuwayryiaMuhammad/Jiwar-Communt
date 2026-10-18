import { atPost, validNow, validToday, withinDays } from './child-rules';

const ALWAYS = {
  validFrom: '2026-11-01',
  validUntil: null,
  schedule: null,
  gateId: null,
  placeId: null,
};
const POST = { gateId: 'g1', placeId: null };

describe('child exit rules (ADR 0054)', () => {
  it('days: both ends included; open-ended', () => {
    expect(withinDays(ALWAYS, '2026-10-31')).toBe(false);
    expect(withinDays(ALWAYS, '2026-11-01')).toBe(true);
    expect(withinDays(ALWAYS, '2030-01-01')).toBe(true);
    const until = { ...ALWAYS, validUntil: '2026-11-03' };
    expect(withinDays(until, '2026-11-03')).toBe(true);
    expect(withinDays(until, '2026-11-04')).toBe(false);
  });

  it('post: anywhere, or exactly the gate or the zone of the shift', () => {
    expect(atPost(ALWAYS, POST)).toBe(true);
    expect(atPost({ ...ALWAYS, gateId: 'g1' }, POST)).toBe(true);
    expect(atPost({ ...ALWAYS, gateId: 'g2' }, POST)).toBe(false);
    expect(atPost({ ...ALWAYS, placeId: 'p1' }, POST)).toBe(false);
    expect(
      atPost({ ...ALWAYS, placeId: 'p1' }, { gateId: null, placeId: 'p1' }),
    ).toBe(true);
  });

  it('now: days, then hours in the compound zone, then the post', () => {
    // Monday 2 November 2026, 14:30 in Cairo (UTC+2): 12:30Z.
    const at = {
      today: '2026-11-02',
      instant: new Date(Date.UTC(2026, 10, 2, 12, 30)),
      timeZone: 'Africa/Cairo',
      post: POST,
    };
    const afternoons = {
      ...ALWAYS,
      schedule: { days: [1], windows: [{ from: '13:00', to: '16:00' }] },
    };
    expect(validNow(afternoons, at)).toBe('ok');
    expect(
      validNow(afternoons, {
        ...at,
        instant: new Date(Date.UTC(2026, 10, 2, 15, 0)),
      }),
    ).toBe('outside_validity');
    expect(validNow({ ...afternoons, validFrom: '2026-11-03' }, at)).toBe(
      'outside_validity',
    );
    expect(validNow({ ...afternoons, gateId: 'g2' }, at)).toBe('wrong_post');
  });

  it('today: its days, or a window from yesterday that runs past midnight', () => {
    const mondays = {
      ...ALWAYS,
      schedule: { days: [1], windows: [{ from: '13:00', to: '16:00' }] },
    };
    expect(validToday(mondays, '2026-11-02', 1)).toBe(true);
    expect(validToday(mondays, '2026-11-03', 2)).toBe(false);
    const overnight = {
      ...ALWAYS,
      schedule: { days: [1], windows: [{ from: '22:00', to: '02:00' }] },
    };
    expect(validToday(overnight, '2026-11-03', 2)).toBe(true);
    expect(validToday(ALWAYS, '2026-10-31', 6)).toBe(false);
  });
});
