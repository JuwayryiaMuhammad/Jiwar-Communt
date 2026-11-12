import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat } from '@jiwar/i18n/core';
import { wageText } from './wage-text.ts';

test('a wage shows in the compound’s currency, as the finance pages show money', () => {
  const en = createFormat('en');
  const ar = createFormat('ar');
  assert.equal(wageText(en, '3200.00', 'EGP'), '3,200.00 EGP');
  assert.equal(wageText(ar, '3200.5', 'EGP'), '3,200.50 ج.م');
  assert.equal(wageText(ar, '3200.00', 'EGP'), ar.money('3200.00'));
  assert.equal(wageText(en, '3200.00'), en.money('3200.00'));
  assert.equal(wageText(en, '3200.00', 'USD'), '3,200.00 USD');
  assert.equal(wageText(en, null, 'EGP'), '—');
  assert.equal(wageText(en, undefined), '—');
});
