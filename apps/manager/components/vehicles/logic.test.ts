import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, fineActions, matchesText, peakUse, permitDateProblem, validFineAmount, validSticker } from './logic.ts';

test('a sticker is letters, digits and dashes, 1–20', () => {
  assert.equal(validSticker(' ab-12 '), true);
  assert.equal(validSticker('A'.repeat(20)), true);
  assert.equal(validSticker('A'.repeat(21)), false);
  assert.equal(validSticker('AB 12'), false);
  assert.equal(validSticker(''), false);
});

test('a permit’s last day is after today, at most 731 days ahead, not before the current one', () => {
  const today = '2026-10-15';
  assert.equal(permitDateProblem('2026-10-15', today), 'After today.');
  assert.equal(permitDateProblem('2026-10-16', today), undefined);
  assert.equal(permitDateProblem(addDays(today, 731), today), undefined);
  assert.equal(permitDateProblem(addDays(today, 732), today), 'At most two years ahead.');
  assert.equal(permitDateProblem('2026-11-01', today, '2026-12-01'), 'Not before the current last day.');
  assert.equal(permitDateProblem('', today), 'Pick a day.');
});

test('an area’s peak use counts what holds one instant, windows half-open', () => {
  const w = (a: string, b: string) => ({ startsAt: `2026-10-20T${a}:00.000Z`, endsAt: `2026-10-20T${b}:00.000Z` });
  const day = ['2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'] as const;
  assert.equal(peakUse([w('10:00', '11:00'), w('11:00', '12:00')], ...day), 1);
  assert.equal(peakUse([w('10:00', '12:00'), w('11:00', '13:00'), w('11:30', '11:45')], ...day), 3);
  assert.equal(peakUse([], ...day), 0);
});

test('a fine’s amount is EGP above zero, at most 100,000, two decimals', () => {
  assert.equal(validFineAmount('500'), true);
  assert.equal(validFineAmount('500.5'), true);
  assert.equal(validFineAmount('0'), false);
  assert.equal(validFineAmount('100001'), false);
  assert.equal(validFineAmount('1.234'), false);
});

test('what the staff may do on a fine', () => {
  const all = { issue: true, billing: true };
  assert.deepEqual(fineActions('unpaid', all), ['cancel', 'pay']);
  assert.deepEqual(fineActions('under_appeal', all), ['decide']);
  assert.deepEqual(fineActions('paid', all), []);
  assert.deepEqual(fineActions('unpaid', { issue: false, billing: true }), ['pay']);
  assert.deepEqual(fineActions('under_appeal', { issue: false, billing: true }), []);
});

test('a report’s matches as words', () => {
  assert.equal(matchesText([]), 'No registered vehicle');
  assert.equal(matchesText([{ unitCode: 'A-1', permitStatus: 'expires_soon' }]), 'A-1 (expires soon)');
});
