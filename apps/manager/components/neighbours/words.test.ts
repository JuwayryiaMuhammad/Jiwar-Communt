import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postProblems, threadState, toWelcomeForm, welcomeProblems } from './logic.ts';
import { postProblemCodes, threadWhy, welcomeProblemCodes } from './words.ts';

test('a thread says why it is shut exactly when logic.ts says it is', () => {
  for (const thread of ['complainant', 'target', 'internal'] as const) {
    for (const status of ['submitted', 'under_review', 'notice_sent', 'mediation', 'resolved', 'dismissed']) {
      for (const hasNotice of [false, true]) {
        assert.equal(threadWhy(thread, status, hasNotice) === null, threadState(thread, status, hasNotice).write);
      }
    }
  }
  assert.equal(threadWhy('complainant', 'resolved', false), 'complainantClosed');
  assert.equal(threadWhy('target', 'dismissed', false), 'noNotice');
  assert.equal(threadWhy('target', 'resolved', true), 'unitClosed');
});

test('the post and welcome problems are the same fields as in logic.ts', () => {
  const bad = { body: '', place: 'x'.repeat(121), occurredOn: '2026-10-15' };
  assert.deepEqual(Object.keys(postProblemCodes(bad, '2026-10-14')).sort(), Object.keys(postProblems(bad, '2026-10-14')).sort());
  assert.equal(postProblemCodes({ ...bad, body: 'x', place: '', occurredOn: '14/10/2026' }, '2026-10-14').occurredOn, 'dayFormat');
  const half = toWelcomeForm({ rulesEn: 'Rules' });
  assert.deepEqual(Object.keys(welcomeProblemCodes(half)).sort(), Object.keys(welcomeProblems(half)).sort());
  assert.equal(welcomeProblemCodes(toWelcomeForm({ rulesEn: 'x'.repeat(4001), officeHoursEn: 'a', emergencyEn: 'b' })).rulesEn, 'max');
});
