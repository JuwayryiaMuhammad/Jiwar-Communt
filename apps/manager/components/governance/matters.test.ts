import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripIsolates, translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/gov-codes.ts';
import en from '../../messages/en/gov-codes.ts';
import { columnLabel, matterOutcomeText, objectionState, subjectParts, tallyText } from './matters.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);

test('a tally reads as the votes cast against the seats that count', () => {
  const tally = { seats: 5, quorum: 3, for: 2, against: 1 };
  assert.equal(stripIsolates(tallyText(tEn, tally)), '2 for · 1 against · 3 of 5 seats voted, quorum 3');
  assert.equal(stripIsolates(tallyText(tAr, tally)), '2 موافق · 1 معارض · صوّت 3 من 5 مقاعد، والنصاب 3');
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

test('a subject’s keys are named by the page’s words when it hands them in', () => {
  const name = (code: string) => `[${code}]`;
  const parts = subjectParts({ fiscalYear: 2027, totals: { allowance: '10.00' } }, name);
  assert.deepEqual(parts.rows, [
    { label: '[fiscal_year]', value: 2027 },
    { label: '[totals] · [allowance]', value: '10.00' },
  ]);
  assert.equal(columnLabel('reserveFund', name), '[reserve_fund]');
});

test('no subject is nothing to show', () => {
  assert.deepEqual(subjectParts(null), { rows: [], tables: [] });
});

test('a representative matter decided reads as what it changed, or why an approval changed nothing (ADR 0059)', () => {
  assert.equal(matterOutcomeText(tEn, { decision: 'rejected', effect: null, effectReason: null }), 'Rejected: nothing changed');
  assert.equal(matterOutcomeText(tEn, { decision: 'approved', effect: 'applied', effectReason: null }), 'Approved and applied');
  assert.equal(
    matterOutcomeText(tEn, { decision: 'approved', effect: 'not_applied', effectReason: 'not_an_owner' }),
    'Approved, not applied: they no longer own a unit in the building',
  );
  assert.equal(
    matterOutcomeText(tAr, { decision: 'approved', effect: 'not_applied', effectReason: 'already_ended' }),
    'اعتُمد ولم يُطبق: كانت المدة قد انتهت بالفعل',
  );
});

test('a decision takes objections until its day, and none once answered (ADR 0059)', () => {
  const now = new Date('2026-11-10T10:00:00Z');
  assert.equal(objectionState(null, now), null);
  assert.equal(objectionState({ until: '2026-11-12T00:00:00Z', answered: false }, now), 'open');
  assert.equal(objectionState({ until: '2026-11-10T10:00:00Z', answered: false }, now), 'closed');
  assert.equal(objectionState({ until: '2026-11-12T00:00:00Z', answered: true }, now), 'answered');
});
