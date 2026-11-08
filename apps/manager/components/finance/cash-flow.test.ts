import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cashFlowBasis, cashFlowRate, liquidityText } from './cash-flow.ts';

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
