import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnLabel, subjectParts, tallyText } from './matters.ts';

test('a tally reads as the votes cast against the seats that count', () => {
  assert.equal(tallyText({ seats: 5, quorum: 3, for: 2, against: 1 }), '2 for · 1 against · 3 of 5 seats voted, quorum 3');
});

test('a subject’s scalars are rows, nested objects flattened, lists of objects tables, ids left out', () => {
  const parts = subjectParts({
    budgetId: 'b-1',
    fiscalYear: 2027,
    appealDecision: null,
    totals: { allowance: '10.00', spent: '4.00' },
    lines: [
      { id: 'l-1', category: 'security', amount: '6.00' },
      { id: 'l-2', category: 'cleaning', amount: '4.00', note: 'weekly' },
    ],
    codes: ['a', 'b'],
  });
  assert.deepEqual(parts.rows, [
    { label: 'Fiscal year', value: 2027 },
    { label: 'Appeal decision', value: null },
    { label: 'Totals · allowance', value: '10.00' },
    { label: 'Totals · spent', value: '4.00' },
    { label: 'Codes', value: 'a, b' },
  ]);
  assert.deepEqual(parts.tables, [
    {
      label: 'Lines',
      columns: ['category', 'amount', 'note'],
      rows: [
        { category: 'security', amount: '6.00', note: null },
        { category: 'cleaning', amount: '4.00', note: 'weekly' },
      ],
    },
  ]);
  assert.equal(columnLabel('reserve_fund'), 'Reserve fund');
});

test('no subject is nothing to show', () => {
  assert.deepEqual(subjectParts(null), { rows: [], tables: [] });
});
