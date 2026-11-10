import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/places-facilities.ts';
import en from '../../messages/en/places-facilities.ts';
import {
  bookingActions,
  dayGrid,
  fromLocalInput,
  inRange,
  minutesText,
  numberChanges,
  peakAboveWeekly,
  RULE_RANGES,
  shiftDay,
  validMoney,
  validReceipt,
  windowIssues,
} from './logic.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);

test('a rule is a whole number inside its range', () => {
  assert.equal(inRange(RULE_RANGES.slotMinutes, '60'), true);
  assert.equal(inRange(RULE_RANGES.slotMinutes, '10'), false);
  assert.equal(inRange(RULE_RANGES.slotMinutes, '60.5'), false);
  assert.equal(inRange(RULE_RANGES.maxGuests, '0'), true);
  assert.equal(inRange(RULE_RANGES.maxGuests, ''), false);
});

test('the peak quota is at most the weekly one', () => {
  assert.equal(peakAboveWeekly('2', '3'), true);
  assert.equal(peakAboveWeekly('2', '2'), false);
  assert.equal(peakAboveWeekly('x', '3'), false);
});

test('a week of windows: each ends after it starts, none overlaps another of its day', () => {
  const w = (weekday: number, startMinute: number, endMinute: number) => ({ weekday, startMinute, endMinute });
  assert.deepEqual(windowIssues([w(1, 540, 720), w(1, 720, 900)]), {});
  assert.deepEqual(windowIssues([w(1, 600, 600)]), { 0: 'order' });
  assert.deepEqual(windowIssues([w(1, 540, 720), w(1, 600, 780), w(2, 600, 780)]), { 1: 'overlap' });
});

test('only what changed is sent', () => {
  assert.deepEqual(
    numberChanges({ a: '1', b: ' 5 ' }, { a: 1, b: 4 }, ['a', 'b']),
    { b: 5 },
  );
});

test('minutes read as people say them', () => {
  assert.equal(minutesText(0, tEn), 'no notice');
  assert.equal(minutesText(90, tEn), '1 h 30 min');
  assert.equal(minutesText(120, tEn), '2 h');
  assert.equal(minutesText(45, tEn), '45 min');
  assert.equal(minutesText(1440, tEn), '1 day');
  assert.equal(minutesText(10080, tEn), '7 days');
  assert.equal(minutesText(0, tAr), 'دون مهلة');
  assert.equal(minutesText(90, tAr), '1 س 30 د');
  assert.equal(minutesText(1440, tAr), 'يوم واحد');
  assert.equal(minutesText(2880, tAr), 'يومان');
  assert.equal(minutesText(10080, tAr), '7 أيام');
});

test('a day’s grid keeps every booking: in its slots, or apart when it fits none', () => {
  const s = (h: number) => ({
    startsAt: `2031-01-13T${String(h).padStart(2, '0')}:00:00Z`,
    endsAt: `2031-01-13T${String(h + 1).padStart(2, '0')}:00:00Z`,
    peak: false,
    taken: 0,
  });
  const b = (id: string, from: string, to: string) => ({ id, startsAt: from, endsAt: to, status: 'confirmed' });
  const grid = dayGrid(
    [s(10), s(11)],
    [
      b('in', '2031-01-13T10:00:00Z', '2031-01-13T11:00:00Z'),
      b('across', '2031-01-13T10:30:00Z', '2031-01-13T11:30:00Z'),
      b('out', '2031-01-13T20:00:00Z', '2031-01-13T21:00:00Z'),
    ],
  );
  assert.deepEqual(grid.rows.map((r) => r.bookings.map((x) => x.id)), [['in', 'across'], ['across']]);
  assert.deepEqual(grid.outside.map((x) => x.id), ['out']);
});

test('a handler acts on a booking by its status and its time', () => {
  const now = new Date('2031-01-13T12:00:00Z');
  const at = (status: string, from: string, to: string) => bookingActions({ status, startsAt: from, endsAt: to }, now);
  assert.deepEqual(at('pending', '2031-01-13T14:00:00Z', '2031-01-13T15:00:00Z'), ['approve', 'reject', 'cancel']);
  assert.deepEqual(at('pending', '2031-01-13T11:00:00Z', '2031-01-13T13:00:00Z'), []);
  assert.deepEqual(at('confirmed', '2031-01-13T11:00:00Z', '2031-01-13T13:00:00Z'), ['cancel']);
  assert.deepEqual(at('confirmed', '2031-01-13T10:00:00Z', '2031-01-13T11:00:00Z'), ['no_show']);
  assert.deepEqual(at('confirmed', '2031-01-09T10:00:00Z', '2031-01-09T11:00:00Z'), []);
  assert.deepEqual(at('cancelled', '2031-01-13T14:00:00Z', '2031-01-13T15:00:00Z'), []);
});

test('days shift across months; a local input becomes an instant', () => {
  assert.equal(shiftDay('2031-01-31', 1), '2031-02-01');
  assert.equal(shiftDay('2031-03-01', -1), '2031-02-28');
  assert.equal(fromLocalInput('nope'), null);
  assert.equal(typeof fromLocalInput('2031-01-13T10:00'), 'string');
});

test('money and receipts as the API takes them', () => {
  assert.equal(validMoney('500'), true);
  assert.equal(validMoney('500.50'), true);
  assert.equal(validMoney('0'), false);
  assert.equal(validMoney('1.234'), false);
  assert.equal(validMoney('1000001'), false);
  assert.equal(validReceipt('R-2031/01'), true);
  assert.equal(validReceipt('R 1'), false);
});
