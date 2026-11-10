import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripIsolates, translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/gov-codes.ts';
import en from '../../messages/en/gov-codes.ts';
import {
  appointmentProblems,
  codeText,
  inLocale,
  optionText,
  seatsLeft,
  share,
  tieChoiceComplete,
  turnoutText,
} from './logic.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);

test('an option is named by its key on a yes/no poll, by its label otherwise', () => {
  assert.equal(optionText(tEn, 'en', { key: 'abstain', labelEn: null, labelAr: null }), 'Abstain');
  assert.equal(optionText(tAr, 'ar', { key: 'abstain', labelEn: null, labelAr: null }), 'امتناع');
  assert.equal(optionText(tEn, 'en', { key: null, labelEn: null, labelAr: 'أخضر' }), 'أخضر');
  assert.equal(optionText(tAr, 'ar', { key: null, labelEn: 'Green', labelAr: 'أخضر' }), 'أخضر');
  assert.equal(optionText(tEn, 'en', { key: null, labelEn: 'Green', labelAr: 'أخضر' }), 'Green');
});

test('the words written in the page’s language first, the other else', () => {
  assert.equal(inLocale('ar', 'Budget', null), 'Budget');
  assert.equal(inLocale('ar', 'Budget', 'الميزانية'), 'الميزانية');
  assert.equal(inLocale('en', null, null), '—');
});

test('the turnout against the electorate, nothing before it opens', () => {
  const text = (t: typeof tEn, turnout: number | null, electorate: number | null) => stripIsolates(turnoutText(t, turnout, electorate));
  assert.equal(text(tEn, null, null), 'Not open yet');
  assert.equal(text(tEn, 12, 40), '12 of 40 units (30 %)');
  assert.equal(text(tEn, null, 1), '1 unit');
  assert.equal(text(tAr, 12, 40), '12 من 40 وحدة (30%)');
  assert.equal(text(tAr, 2, 5), '2 من 5 وحدات (40%)');
  assert.equal(share(1, 3), '33.3 %');
  assert.equal(share(0, 0), '0 %');
});

test('an appointment: 3 to `seats` owners, each once, one of each office', () => {
  const m = (accountId: string, role = 'member') => ({ accountId, role });
  assert.deepEqual(appointmentProblems(tEn, 5, [m('a', 'chair'), m('b'), m('c')]), []);
  assert.deepEqual(appointmentProblems(tEn, 3, [m('a'), m('b')]), ['Appoint at least 3 owners.']);
  assert.deepEqual(appointmentProblems(tEn, 3, [m('a', 'chair'), m('b', 'chair'), m('a')]), [
    'An owner is listed twice.',
    'One chair at most.',
  ]);
  assert.deepEqual(appointmentProblems(tAr, 3, [m('a', 'treasurer'), m('b', 'treasurer'), m('c')]), ['أمين صندوق واحد على الأكثر.']);
});

test('a code is named in its group, shown as itself when the catalog lacks it', () => {
  assert.equal(codeText(tEn, 'role', 'chair'), 'Chair');
  assert.equal(codeText(tAr, 'role', 'chair'), 'الرئيس');
  assert.equal(codeText(tEn, 'role', 'patron'), 'patron');
  assert.equal(codeText(tEn, 'role', null), '—');
});

test('a tie is resolved with exactly the seats left, from the tied', () => {
  const tied = ['x', 'y', 'z'];
  assert.equal(seatsLeft(3, [{ outcome: 'elected' }, { outcome: 'tied' }, { outcome: 'tied' }]), 2);
  assert.equal(tieChoiceComplete(['x', 'y'], tied, 2), true);
  assert.equal(tieChoiceComplete(['x'], tied, 2), false);
  assert.equal(tieChoiceComplete(['x', 'w'], tied, 2), false);
  assert.equal(tieChoiceComplete(['x', 'x'], tied, 2), false);
});
