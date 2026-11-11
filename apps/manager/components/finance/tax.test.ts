import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountOk,
  monthEnd,
  quarterEnd,
  quarterOf,
  quarterStart,
  rateOk,
  thresholdOk,
  toggled,
} from './tax.ts';

test('taxes: a rate is a percent of two decimals; a VAT rate is above zero, a withholding rate may be zero', () => {
  assert.equal(rateOk('14', { allowZero: false }), true);
  assert.equal(rateOk('14.50', { allowZero: false }), true);
  assert.equal(rateOk('0', { allowZero: false }), false);
  assert.equal(rateOk('0.00', { allowZero: true }), true);
  assert.equal(rateOk('100.01', { allowZero: true }), false);
  assert.equal(rateOk('1.234', { allowZero: true }), false);
  assert.equal(rateOk('', { allowZero: true }), false);
});

test('taxes: the threshold is an amount from zero', () => {
  assert.equal(thresholdOk('0'), true);
  assert.equal(thresholdOk('300.00'), true);
  assert.equal(thresholdOk('-1'), false);
  assert.equal(thresholdOk('1.234'), false);
});

test('taxes: a list is toggled and kept in its first order', () => {
  const all = ['a', 'b', 'c'] as const;
  assert.deepEqual(toggled(['c'], all, 'a'), ['a', 'c']);
  assert.deepEqual(toggled(['a', 'c'], all, 'a'), ['c']);
});

test('taxes: the quarter of a day, in words', () => {
  assert.equal(quarterOf('2026-01-01'), '2026-Q1');
  assert.equal(quarterOf('2026-09-30'), '2026-Q3');
  assert.equal(quarterOf('2026-12-31'), '2026-Q4');
});

test('taxes: the days a month and a quarter span', () => {
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(monthEnd('2028-02'), '2028-02-29');
  assert.equal(monthEnd('2026-12'), '2026-12-31');
  assert.equal(quarterStart('2026-Q3'), '2026-07-01');
  assert.equal(quarterEnd('2026-Q3'), '2026-09-30');
  assert.equal(quarterEnd('2026-Q4'), '2026-12-31');
});

test('taxes: a payment is a whole-piastre amount above zero', () => {
  assert.equal(amountOk('140'), true);
  assert.equal(amountOk('0.50'), true);
  assert.equal(amountOk('0'), false);
  assert.equal(amountOk('0.00'), false);
  assert.equal(amountOk('1.234'), false);
});
