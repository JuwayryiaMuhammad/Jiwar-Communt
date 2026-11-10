import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/fin-codes.ts';
import en from '../../messages/en/fin-codes.ts';
import { draftTotals, endedMonths, piastres, reconciliationLabel, reconciliationText } from './gl.ts';

test('general ledger: amounts in piastres, nothing else', () => {
  assert.equal(piastres('10.5'), 1050);
  assert.equal(piastres('0.07'), 7);
  assert.equal(piastres('1.234'), null);
  assert.equal(piastres('-3'), null);
});

test('general ledger: a draft is ready when its sides agree, every line whole', () => {
  assert.deepEqual(
    draftTotals([
      { accountId: 'a', side: 'debit', amount: '100.10' },
      { accountId: 'b', side: 'credit', amount: '100.1' },
    ]),
    { debit: '100.10', credit: '100.10', ready: true },
  );
  assert.equal(
    draftTotals([
      { accountId: 'a', side: 'debit', amount: '100' },
      { accountId: 'b', side: 'credit', amount: '90' },
    ]).ready,
    false,
  );
  assert.equal(draftTotals([{ accountId: 'a', side: 'debit', amount: '1' }]).ready, false);
  assert.equal(
    draftTotals([
      { accountId: '', side: 'debit', amount: '1' },
      { accountId: 'b', side: 'credit', amount: '1' },
    ]).ready,
    false,
  );
});

test('general ledger: the months that have ended, newest first', () => {
  assert.deepEqual(endedMonths('2027-02-14', 3), ['2027-01', '2026-12', '2026-11']);
});

test('general ledger: a reconciliation line’s name', () => {
  assert.equal(reconciliationLabel('unit_credit'), 'Unit credit');
  assert.equal(reconciliationLabel('other'), 'other');
});

test('general ledger: a reconciliation line’s name in the page’s language', () => {
  assert.equal(reconciliationText(translator('en', en, ar), 'unit_credit'), 'Unit credit');
  assert.equal(reconciliationText(translator('ar', en, ar), 'receivables'), 'المستحقات');
  assert.equal(reconciliationText(translator('ar', en, ar), 'other'), 'other');
});
