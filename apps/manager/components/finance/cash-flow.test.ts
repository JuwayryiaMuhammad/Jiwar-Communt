import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat, translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/fin-codes.ts';
import en from '../../messages/en/fin-codes.ts';
import { cashFlowBasis, cashFlowBasisText, cashFlowRate, cashFlowRateText, liquidityDays, liquidityText } from './cash-flow.ts';

test('cash flow: the rate as a percentage, a dash with no history', () => {
  assert.equal(cashFlowRate(0.874), '87.4%');
  assert.equal(cashFlowRate(null), '—');
});

test('cash flow: the basis says what the rate stands on', () => {
  assert.match(cashFlowBasis({ basis: 'no_history', from: 'a', to: 'b', due: '0.00', collected: '0.00' }), /no resident money/);
  assert.equal(
    cashFlowBasis({ basis: 'window', from: '2026-08-10', to: '2026-11-07', due: '1000.00', collected: '600.00' }),
    '600.00 of 1000.00 due 2026-08-10 – 2026-11-07',
  );
});

test('cash flow: liquidity in days, a dash when it cannot be computed', () => {
  assert.equal(liquidityText(1), '1 day');
  assert.equal(liquidityText(45), '45 days');
  assert.equal(liquidityText(null), '—');
});

test('cash flow in the page’s language: amounts, days and plurals formatted', () => {
  const t = translator('en', en, ar);
  const tAr = translator('ar', en, ar);
  const fmt = createFormat('en');
  assert.equal(cashFlowRateText(fmt, 0.874), '87.4%');
  assert.equal(cashFlowRateText(fmt, null), '—');
  assert.match(cashFlowBasisText(t, fmt, { basis: 'no_history', from: 'a', to: 'b', due: '0', collected: '0' }), /no resident money/);
  assert.match(
    cashFlowBasisText(t, fmt, { basis: 'window', from: '2026-08-10', to: '2026-11-07', due: '1000.00', collected: '600.00' }),
    /600\.00 EGP.* of .*1,000\.00 EGP.* due .*10 Aug 2026.* – .*07 Nov 2026/,
  );
  assert.equal(liquidityDays(t, 1), '1 day');
  assert.equal(liquidityDays(t, 45), '45 days');
  assert.equal(liquidityDays(tAr, 2), 'يومان');
  assert.equal(liquidityDays(tAr, 5), '5 أيام');
  assert.equal(liquidityDays(t, null), '—');
});
