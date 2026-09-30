import {
  adultCutoff,
  ageOn,
  egyptToday,
  localToday,
  isAdult,
  normalizeNationalId,
  parseEgyptianNationalId,
} from './egyptian-national-id';

const TODAY = new Date(Date.UTC(2026, 8, 29)); // 2026-09-29
const d = (y: number, m: number, day: number) =>
  new Date(Date.UTC(y, m - 1, day));

describe('Egyptian national ID', () => {
  it.each([
    ['29001010100011', d(1990, 1, 1), '01'], // 1900s, Cairo
    ['30802291234567', d(2008, 2, 29), '12'], // leap day, Dakahlia
    ['31001018812345', d(2010, 1, 1), '88'], // born abroad
    ['29912313512345', d(1999, 12, 31), '35'], // South Sinai
  ])('%s is valid', (id, birthDate, governorate) => {
    expect(parseEgyptianNationalId(id, TODAY)).toEqual({
      value: id,
      birthDate,
      governorate,
    });
  });

  it.each([
    ['2900101010001', 'too short'],
    ['290010101000111', 'too long'],
    ['2900101010001a', 'not digits'],
    ['19001010100011', 'century 1'],
    ['49001010100011', 'century 4'],
    ['29002300100011', '30 February'],
    ['29013010100011', 'month 13'],
    ['29000010100011', 'month 0'],
    ['29001000100011', 'day 0'],
    ['30702290100011', '29 February in a common year (2007)'],
    ['32701010100011', 'born in 2027: in the future'],
    ['29001010000011', 'governorate 00'],
    ['29001010500011', 'governorate 05'],
    ['29001012000011', 'governorate 20'],
    ['29001013600011', 'governorate 36'],
    ['29001018700011', 'governorate 87'],
  ])('%s is rejected (%s)', (id) => {
    expect(parseEgyptianNationalId(id, TODAY)).toBeNull();
  });

  it('normalizes spaces, dashes and Arabic-Indic digits', () => {
    expect(normalizeNationalId(' ٢٩٠٠١٠١٠١٠٠٠١١ ')).toBe('29001010100011');
    expect(normalizeNationalId('2 900101-01-0001 1')).toBe('29001010100011');
    expect(parseEgyptianNationalId('۲۹۰۰۱۰۱۰۱۰۰۰۱۱', TODAY)?.value).toBe(
      '29001010100011',
    );
  });

  describe('age around the 18th birthday', () => {
    const born = d(2008, 9, 29);
    it.each([
      [d(2026, 9, 28), 17, false],
      [d(2026, 9, 29), 18, true],
      [d(2026, 9, 30), 18, true],
      [d(2027, 9, 28), 18, true],
    ])('on %s: age %i, adult %s', (on, age, adult) => {
      expect(ageOn(born, on)).toBe(age);
      expect(isAdult(born, on)).toBe(adult);
    });

    it('a 29 February birth turns 18 on 1 March in a common year', () => {
      const leap = d(2008, 2, 29);
      expect(ageOn(leap, d(2026, 2, 28))).toBe(17);
      expect(ageOn(leap, d(2026, 3, 1))).toBe(18);
      expect(ageOn(leap, d(2028, 2, 29))).toBe(20);
    });
  });

  it("today is Egypt's calendar date, not UTC's", () => {
    // 22:30 UTC on 28 Sep is already 29 Sep in Cairo (UTC+3 in summer).
    expect(egyptToday(new Date('2026-09-28T22:30:00Z'))).toEqual(
      d(2026, 9, 29),
    );
  });
});

describe('localToday and adultCutoff (a compound time zone)', () => {
  it('reads the calendar date in the given zone', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(localToday('Pacific/Kiritimati', now)).toEqual(d(2026, 10, 2));
    expect(localToday('Pacific/Pago_Pago', now)).toEqual(d(2026, 9, 30));
    expect(localToday('Africa/Cairo', now)).toEqual(d(2026, 10, 1));
  });

  it('the cutoff agrees with isAdult, 29 February included', () => {
    for (const today of [d(2026, 2, 28), d(2026, 3, 1), d(2028, 2, 29)]) {
      const cutoff = adultCutoff(today);
      expect(isAdult(cutoff, today)).toBe(true);
      const dayAfter = new Date(cutoff.getTime() + 86_400_000);
      expect(isAdult(dayAfter, today)).toBe(false);
    }
    // Born 29 Feb 2008: still 17 on 28 Feb 2026, 18 on 1 March.
    expect(d(2008, 2, 29) <= adultCutoff(d(2026, 2, 28))).toBe(false);
    expect(d(2008, 2, 29) <= adultCutoff(d(2026, 3, 1))).toBe(true);
  });
});
