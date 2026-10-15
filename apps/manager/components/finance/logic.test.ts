import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstOfMonth, keyProblem, lineReady, linesTotal, masked, monthStarts, needsReference, validCode, validMoney, validReference } from './logic.ts';

test('money: positive, two decimals at most, up to a million', () => {
  assert.equal(validMoney('1500'), true);
  assert.equal(validMoney('1500.5'), true);
  assert.equal(validMoney('0.01'), true);
  assert.equal(validMoney('0'), false);
  assert.equal(validMoney('1.234'), false);
  assert.equal(validMoney('1000000.01'), false);
  assert.equal(validMoney('-5'), false);
});

test('lines add up exactly, in piastres', () => {
  assert.equal(linesTotal([{ amount: '0.10' }, { amount: '0.20' }]), '0.30');
  assert.equal(linesTotal([{ amount: '700' }, { amount: '300.50' }]), '1000.50');
  assert.equal(linesTotal([{ amount: '1' }, { amount: 'x' }]), null);
  assert.equal(linesTotal([]), null);
  assert.equal(lineReady({ descriptionEn: 'Fee', descriptionAr: 'رسم', amount: '10' }), true);
  assert.equal(lineReady({ descriptionEn: 'Fee', descriptionAr: '', amount: '10' }), false);
});

test('a reference for a transfer or a cheque only', () => {
  assert.equal(needsReference('cash'), false);
  assert.equal(needsReference('cheque'), true);
  assert.equal(needsReference('bank_transfer'), true);
  assert.equal(validReference('NBE/2026-551'), true);
  assert.equal(validReference('a b'), false);
});

test('plans start on the first of a month', () => {
  assert.equal(firstOfMonth('2026-10-15'), '2026-10-01');
  assert.deepEqual(monthStarts('2026-11-30', 3), ['2026-11-01', '2026-12-01', '2027-01-01']);
});

test('credentials: masked, keys fit the mode, codes are six digits', () => {
  assert.equal(masked('abcd'), '••••abcd');
  assert.equal(masked(null), '—');
  assert.equal(keyProblem('egy_sk_test_0123456789', 'sk', 'sandbox'), undefined);
  assert.equal(keyProblem('egy_sk_test_0123456789', 'sk', 'live'), 'Live mode takes a live key.');
  assert.equal(keyProblem('egy_pk_live_0123456789', 'pk', 'sandbox'), 'Sandbox takes a test key.');
  assert.match(keyProblem('sk_live_x', 'sk', 'live') ?? '', /Starts with/);
  assert.equal(validCode('123456'), true);
  assert.equal(validCode('12345'), false);
});
