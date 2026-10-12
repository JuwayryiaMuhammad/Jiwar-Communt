import {
  bookable,
  MAX_AHEAD_MS,
  MIN_LEAD_MS,
  officeSlotsOfDay,
  openSlots,
  slotAt,
  takenIn,
  type OfficeCalendar,
} from './appointment-slots';
import { DEFAULT_OFFICE_HOURS } from '../settings/defaults';

const CAIRO = 'Africa/Cairo';
const calendar: OfficeCalendar = {
  windows: DEFAULT_OFFICE_HOURS,
  slotMinutes: 30,
  timeZone: CAIRO,
};
const at = (iso: string) => new Date(iso);
const slot = (iso: string, minutes = 30) => ({
  startsAt: at(iso),
  endsAt: new Date(at(iso).getTime() + minutes * 60_000),
});

describe('appointment slots', () => {
  it('a working day is its window cut by the slot length: 09:00 to 17:00 is sixteen half hours', () => {
    // 2031-01-13 is a Monday; Cairo is UTC+2 in winter.
    const slots = officeSlotsOfDay('2031-01-13', calendar);
    expect(slots).toHaveLength(16);
    expect(slots[0].startsAt.toISOString()).toBe('2031-01-13T07:00:00.000Z');
    expect(slots.at(-1)!.endsAt.toISOString()).toBe('2031-01-13T15:00:00.000Z');
  });

  it('Friday is off, Saturday is not', () => {
    expect(officeSlotsOfDay('2031-01-17', calendar)).toEqual([]);
    expect(officeSlotsOfDay('2031-01-18', calendar)).toHaveLength(16);
  });

  it('a day with two windows has both, in order, and no slot across the break', () => {
    const split: OfficeCalendar = {
      ...calendar,
      slotMinutes: 60,
      windows: [
        { weekday: 1, startMinute: 840, endMinute: 960 },
        { weekday: 1, startMinute: 540, endMinute: 690 },
      ],
    };
    expect(
      officeSlotsOfDay('2031-01-13', split).map((s) =>
        s.startsAt.toISOString().slice(11, 16),
      ),
    ).toEqual(['07:00', '08:00', '12:00', '13:00']);
  });

  it('at least an hour and at most thirty days ahead, to the millisecond', () => {
    const now = at('2031-01-13T06:00:00.000Z');
    const starting = (ms: number) => ({
      startsAt: new Date(now.getTime() + ms),
      endsAt: new Date(now.getTime() + ms + 1),
    });
    expect(bookable(starting(MIN_LEAD_MS - 1), now)).toBe(false);
    expect(bookable(starting(MIN_LEAD_MS), now)).toBe(true);
    expect(bookable(starting(MAX_AHEAD_MS), now)).toBe(true);
    expect(bookable(starting(MAX_AHEAD_MS + 1), now)).toBe(false);
  });

  it('open slots skip what is too soon and what is full, and say what is left', () => {
    // 08:30 local now: 09:00 is too soon, 09:30 is the first.
    const now = at('2031-01-13T06:30:00.000Z');
    const open = openSlots({
      from: '2031-01-13',
      days: 1,
      calendar,
      capacity: 2,
      now,
      booked: [
        slot('2031-01-13T08:00:00.000Z'),
        slot('2031-01-13T08:00:00.000Z'),
        slot('2031-01-13T08:30:00.000Z'),
      ],
    });
    const byStart = new Map(
      open.map((s) => [s.startsAt.toISOString().slice(11, 16), s.remaining]),
    );
    expect(byStart.has('07:00')).toBe(false);
    expect(open[0].startsAt.toISOString()).toBe('2031-01-13T07:30:00.000Z');
    expect(byStart.get('07:30')).toBe(2);
    // Full: both places taken.
    expect(byStart.has('08:00')).toBe(false);
    expect(byStart.get('08:30')).toBe(1);
    expect(open).toHaveLength(14);
  });

  it('an appointment booked on another slot length takes every slot it overlaps', () => {
    // An hour booked when slots were an hour long: 10:00 to 11:00 local.
    const old = slot('2031-01-13T08:00:00.000Z', 60);
    expect(takenIn(slot('2031-01-13T08:00:00.000Z'), [old])).toBe(1);
    expect(takenIn(slot('2031-01-13T08:30:00.000Z'), [old])).toBe(1);
    expect(takenIn(slot('2031-01-13T09:00:00.000Z'), [old])).toBe(0);
    expect(takenIn(slot('2031-01-13T07:30:00.000Z'), [old])).toBe(0);
  });

  it('several days: the days asked for, in order, without the day off', () => {
    const open = openSlots({
      from: '2031-01-16',
      days: 3,
      calendar,
      capacity: 1,
      now: at('2031-01-15T00:00:00.000Z'),
      booked: [],
    });
    const days = [
      ...new Set(open.map((s) => s.startsAt.toISOString().slice(0, 10))),
    ];
    expect(days).toEqual(['2031-01-16', '2031-01-18']);
    expect(open).toHaveLength(32);
  });

  it('a booking names a slot exactly: not a time between two, outside the hours or on the day off', () => {
    expect(slotAt(at('2031-01-13T07:30:00.000Z'), calendar)).toEqual(
      slot('2031-01-13T07:30:00.000Z'),
    );
    for (const iso of [
      '2031-01-13T07:15:00.000Z',
      '2031-01-13T07:30:00.001Z',
      '2031-01-13T15:00:00.000Z',
      '2031-01-13T06:30:00.000Z',
      '2031-01-17T08:00:00.000Z',
    ])
      expect(slotAt(at(iso), calendar)).toBeNull();
  });

  it('follows the local clock across a change to summer time', () => {
    // Cairo springs forward on the last Friday of April: UTC+3 after it.
    const winter = officeSlotsOfDay('2031-04-21', calendar)[0].startsAt;
    const summer = officeSlotsOfDay('2031-04-28', calendar)[0].startsAt;
    expect(winter.toISOString()).toBe('2031-04-21T07:00:00.000Z');
    expect(summer.toISOString()).toBe('2031-04-28T06:00:00.000Z');
  });
});
