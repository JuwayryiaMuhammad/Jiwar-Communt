import {
  addDays,
  localDate,
  overlaps,
  slotsOfDay,
  weekdayOf,
  zonedInstant,
} from './day-slots';

const CAIRO = 'Africa/Cairo';
const iso = (d: Date) => d.toISOString();

describe('slots of a local day', () => {
  it('cuts a window into slots on the local clock', () => {
    // Winter in Cairo is UTC+2: 09:00 local is 07:00Z.
    const slots = slotsOfDay(
      '2031-01-15',
      { startMinute: 540, endMinute: 660, slotMinutes: 30 },
      CAIRO,
    );
    expect(slots.map((s) => [iso(s.startsAt), iso(s.endsAt)])).toEqual([
      ['2031-01-15T07:00:00.000Z', '2031-01-15T07:30:00.000Z'],
      ['2031-01-15T07:30:00.000Z', '2031-01-15T08:00:00.000Z'],
      ['2031-01-15T08:00:00.000Z', '2031-01-15T08:30:00.000Z'],
      ['2031-01-15T08:30:00.000Z', '2031-01-15T09:00:00.000Z'],
    ]);
  });

  it('a last piece shorter than a slot is not a slot; a window shorter than one has none', () => {
    expect(
      slotsOfDay(
        '2031-01-15',
        { startMinute: 540, endMinute: 640, slotMinutes: 45 },
        'UTC',
      ),
    ).toHaveLength(2);
    expect(
      slotsOfDay(
        '2031-01-15',
        { startMinute: 540, endMinute: 560, slotMinutes: 30 },
        'UTC',
      ),
    ).toEqual([]);
  });

  it('a window may run to midnight', () => {
    const slots = slotsOfDay(
      '2031-01-15',
      { startMinute: 1380, endMinute: 1440, slotMinutes: 30 },
      'UTC',
    );
    expect(iso(slots.at(-1)!.endsAt)).toBe('2031-01-16T00:00:00.000Z');
  });

  it('a start in a daylight-saving gap is no slot', () => {
    // Europe/Berlin, 2031-03-30: 02:00 to 03:00 local does not exist.
    const slots = slotsOfDay(
      '2031-03-30',
      { startMinute: 60, endMinute: 240, slotMinutes: 60 },
      'Europe/Berlin',
    );
    expect(slots.map((s) => iso(s.startsAt))).toEqual([
      '2031-03-30T00:00:00.000Z',
      '2031-03-30T01:00:00.000Z',
    ]);
    expect(zonedInstant('2031-03-30', 150, 'Europe/Berlin')).toBeNull();
  });

  it('weekdays count from Sunday, and days add across months', () => {
    expect(weekdayOf('2031-01-12')).toBe(0);
    expect(weekdayOf('2031-01-17')).toBe(5);
    expect(weekdayOf('2031-01-18')).toBe(6);
    expect(addDays('2031-01-31', 1)).toBe('2031-02-01');
    expect(localDate(new Date('2031-01-15T23:30:00Z'), CAIRO)).toBe(
      '2031-01-16',
    );
  });

  it('touching windows do not overlap; sharing an instant does', () => {
    const w = (a: string, b: string) => ({
      startsAt: new Date(`2031-01-15T${a}:00Z`),
      endsAt: new Date(`2031-01-15T${b}:00Z`),
    });
    expect(overlaps(w('09:00', '09:30'), w('09:30', '10:00'))).toBe(false);
    expect(overlaps(w('09:00', '09:30'), w('09:29', '10:00'))).toBe(true);
    expect(overlaps(w('09:00', '10:00'), w('09:15', '09:45'))).toBe(true);
  });
});
