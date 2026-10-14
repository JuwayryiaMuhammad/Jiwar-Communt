import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookingActions,
  dayGrid,
  fromLocalInput,
  inRange,
  minutesText,
  numberChanges,
  peakProblem,
  RULE_RANGES,
  shiftDay,
  validMoney,
  validReceipt,
} from './logic.ts';

test('a rule is a whole number inside its range', () => {
  assert.equal(inRange(RULE_RANGES.slotMinutes, '60'), true);
  assert.equal(inRange(RULE_RANGES.slotMinutes, '10'), false);
  assert.equal(inRange(RULE_RANGES.slotMinutes, '60.5'), false);
  assert.equal(inRange(RULE_RANGES.maxGuests, '0'), true);
  assert.equal(inRange(RULE_RANGES.maxGuests, ''), false);
});

test('the peak quota is at most the weekly one', () => {
  assert.equal(peakProblem('2', '3'), 'At most the weekly quota.');
  assert.equal(peakProblem('2', '2'), undefined);
  assert.equal(peakProblem('x', '3'), undefined);
});

test('only what changed is sent', () => {
  assert.deepEqual(
    numberChanges({ a: '1', b: ' 5 ' }, { a: 1, b: 4 }, ['a', 'b']),
    { b: 5 },
  );
});

test('minutes read as people say them', () => {
  assert.equal(minutesText(0), 'no notice');
  assert.equal(minutesText(90), '1 h 30 min');
  assert.equal(minutesText(1440), '1 day');
  assert.equal(minutesText(10080), '7 days');
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
