import { dateOf, instructionState, validOn } from './instruction-validity';

describe('an instruction’s validity (ADR 0056)', () => {
  const season = {
    validFrom: dateOf('2026-12-20'),
    validUntil: dateOf('2027-01-05'),
  };

  it('holds from and until, both days included; either end may be open', () => {
    expect(validOn(season, '2026-12-19')).toBe(false);
    expect(validOn(season, '2026-12-20')).toBe(true);
    expect(validOn(season, '2027-01-05')).toBe(true);
    expect(validOn(season, '2027-01-06')).toBe(false);
    expect(validOn({ validFrom: null, validUntil: null }, '2026-01-01')).toBe(
      true,
    );
    expect(
      validOn(
        { validFrom: dateOf('2026-12-20'), validUntil: null },
        '2030-01-01',
      ),
    ).toBe(true);
  });

  it('reads scheduled, live, expired or archived on a day', () => {
    const live = { ...season, archivedAt: null };
    expect(instructionState(live, '2026-12-01')).toBe('scheduled');
    expect(instructionState(live, '2026-12-25')).toBe('live');
    expect(instructionState(live, '2027-02-01')).toBe('expired');
    expect(
      instructionState({ ...live, archivedAt: new Date(0) }, '2026-12-25'),
    ).toBe('archived');
  });
});
