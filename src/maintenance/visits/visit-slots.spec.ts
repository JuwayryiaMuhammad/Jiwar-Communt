import { addDays, freeSlots, localDate, zonedInstant } from './visit-slots';

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('visit slots', () => {
  describe('zonedInstant', () => {
    it('reads the local clock of the compound, winter and summer', () => {
      expect(iso(zonedInstant('2030-01-15', 8 * 60, 'UTC'))).toBe(
        '2030-01-15T08:00:00.000Z',
      );
      expect(iso(zonedInstant('2030-01-15', 8 * 60, 'America/New_York'))).toBe(
        '2030-01-15T13:00:00.000Z',
      );
      expect(iso(zonedInstant('2030-07-15', 8 * 60, 'America/New_York'))).toBe(
        '2030-07-15T12:00:00.000Z',
      );
      expect(iso(zonedInstant('2030-01-15', 9 * 60 + 30, 'Asia/Kolkata'))).toBe(
        '2030-01-15T04:00:00.000Z',
      );
    });

    it('a time in a daylight-saving gap does not exist', () => {
      // 10 March 2030: New York goes from 02:00 to 03:00.
      expect(zonedInstant('2030-03-10', 2 * 60 + 30, 'America/New_York')).toBe(
        null,
      );
      expect(iso(zonedInstant('2030-03-10', 3 * 60, 'America/New_York'))).toBe(
        '2030-03-10T07:00:00.000Z',
      );
    });

    it('an hour that repeats is its first occurrence', () => {
      // 3 November 2030: 01:30 happens twice in New York; first at UTC−4.
      expect(iso(zonedInstant('2030-11-03', 60 + 30, 'America/New_York'))).toBe(
        '2030-11-03T05:30:00.000Z',
      );
    });
  });

  it('calendar helpers', () => {
    expect(addDays('2030-12-31', 1)).toBe('2031-01-01');
    expect(addDays('2032-02-28', 1)).toBe('2032-02-29');
    expect(localDate(new Date('2030-01-15T23:30:00Z'), 'Asia/Kolkata')).toBe(
      '2030-01-16',
    );
  });

  describe('freeSlots', () => {
    const hours = { startMinute: 8 * 60, endMinute: 12 * 60, slotMinutes: 60 };
    const base = {
      from: '2030-01-15',
      days: 2,
      hours,
      timeZone: 'UTC',
      now: new Date('2030-01-14T12:00:00Z'),
      busy: [],
    };
    const starts = (slots: { startsAt: Date }[]) =>
      slots.map((s) => s.startsAt.toISOString().slice(0, 16));

    it('cuts each day’s visiting hours into slots of their length', () => {
      const slots = freeSlots(base);
      expect(starts(slots)).toEqual([
        '2030-01-15T08:00',
        '2030-01-15T09:00',
        '2030-01-15T10:00',
        '2030-01-15T11:00',
        '2030-01-16T08:00',
        '2030-01-16T09:00',
        '2030-01-16T10:00',
        '2030-01-16T11:00',
      ]);
      for (const s of slots)
        expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(3_600_000);
    });

    it('a slot that does not fit before the end is not offered', () => {
      expect(
        freeSlots({
          ...base,
          days: 1,
          hours: {
            startMinute: 8 * 60,
            endMinute: 10 * 60 + 30,
            slotMinutes: 60,
          },
        }).length,
      ).toBe(2);
    });

    it('drops what the visit rules refuse: less than 15 minutes ahead, more than 30 days', () => {
      expect(
        starts(
          freeSlots({
            ...base,
            days: 1,
            now: new Date('2030-01-15T08:50:00Z'),
          }),
        ),
      ).toEqual(['2030-01-15T10:00', '2030-01-15T11:00']);
      // 09:00 is exactly 15 minutes ahead: allowed.
      expect(
        starts(
          freeSlots({
            ...base,
            days: 1,
            now: new Date('2030-01-15T08:45:00Z'),
          }),
        )[0],
      ).toBe('2030-01-15T09:00');
      expect(freeSlots({ ...base, from: '2030-02-20', days: 1 })).toEqual([]);
    });

    it('drops every slot that overlaps a busy window, even by a minute', () => {
      const busy = [
        {
          startsAt: new Date('2030-01-15T08:30:00Z'),
          endsAt: new Date('2030-01-15T09:01:00Z'),
        },
        // Touching the end of a slot is not an overlap.
        {
          startsAt: new Date('2030-01-15T12:00:00Z'),
          endsAt: new Date('2030-01-15T13:00:00Z'),
        },
      ];
      expect(starts(freeSlots({ ...base, days: 1, busy }))).toEqual([
        '2030-01-15T10:00',
        '2030-01-15T11:00',
      ]);
    });

    it('follows the compound’s clock across a daylight-saving change', () => {
      const ny = freeSlots({
        ...base,
        from: '2030-03-09',
        days: 2,
        timeZone: 'America/New_York',
        hours: { startMinute: 8 * 60, endMinute: 9 * 60, slotMinutes: 60 },
        now: new Date('2030-03-01T00:00:00Z'),
      });
      // 08:00 local both days: 13:00Z before the change, 12:00Z after.
      expect(starts(ny)).toEqual(['2030-03-09T13:00', '2030-03-10T12:00']);
    });
  });
});
