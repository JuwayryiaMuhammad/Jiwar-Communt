import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appointmentProblems,
  optionText,
  seatsLeft,
  share,
  tieChoiceComplete,
  turnoutText,
} from './logic.ts';

test('an option is named by its key on a yes/no poll, by its label otherwise', () => {
  assert.equal(optionText({ key: 'abstain', labelEn: null, labelAr: null }), 'Abstain');
  assert.equal(optionText({ key: null, labelEn: null, labelAr: 'أخضر' }), 'أخضر');
});

test('the turnout against the electorate, nothing before it opens', () => {
  assert.equal(turnoutText(null, null), 'Not open yet');
  assert.equal(turnoutText(12, 40), '12 of 40 units (30 %)');
  assert.equal(share(1, 3), '33.3 %');
  assert.equal(share(0, 0), '0 %');
});

test('an appointment: 3 to `seats` owners, each once, one of each office', () => {
  const m = (accountId: string, role = 'member') => ({ accountId, role });
  assert.deepEqual(appointmentProblems(5, [m('a', 'chair'), m('b'), m('c')]), []);
  assert.deepEqual(appointmentProblems(3, [m('a'), m('b')]), ['Appoint at least 3 owners.']);
  assert.deepEqual(appointmentProblems(3, [m('a', 'chair'), m('b', 'chair'), m('a')]), [
    'An owner is listed twice.',
    'One chair at most.',
  ]);
});

test('a tie is resolved with exactly the seats left, from the tied', () => {
  const tied = ['x', 'y', 'z'];
  assert.equal(seatsLeft(3, [{ outcome: 'elected' }, { outcome: 'tied' }, { outcome: 'tied' }]), 2);
  assert.equal(tieChoiceComplete(['x', 'y'], tied, 2), true);
  assert.equal(tieChoiceComplete(['x'], tied, 2), false);
  assert.equal(tieChoiceComplete(['x', 'w'], tied, 2), false);
  assert.equal(tieChoiceComplete(['x', 'x'], tied, 2), false);
});
