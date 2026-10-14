import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageBody, durationText, egp, paidOnProblem, sameSelection } from './logic.ts';

test('a plan reads as its duration', () => {
  assert.equal(durationText({ durationKind: 'monthly', durationDays: null }), 'Monthly');
  assert.equal(durationText({ durationKind: 'custom', durationDays: 45 }), '45 days');
});

test('amounts read in EGP', () => {
  assert.equal(egp('1500'), '1,500.00 EGP');
  assert.equal(egp(null), '—');
});

test('coverage is sent by kind and id; a selection compares whatever its order', () => {
  assert.deepEqual(coverageBody([{ kind: 'occupancy', id: 'a' }, { kind: 'member', id: 'b' }]), [{ occupancyId: 'a' }, { memberId: 'b' }]);
  assert.equal(sameSelection([{ kind: 'member', id: 'b' }, { kind: 'occupancy', id: 'a' }], [{ kind: 'occupancy', id: 'a' }, { kind: 'member', id: 'b' }]), true);
  assert.equal(sameSelection([{ kind: 'member', id: 'b' }], []), false);
});

test('a payment was made in the last 90 days, not ahead', () => {
  assert.equal(paidOnProblem('2031-01-13', '2031-01-13'), undefined);
  assert.equal(paidOnProblem('2031-01-14', '2031-01-13'), 'Not in the future.');
  assert.equal(paidOnProblem('2030-10-15', '2031-01-13'), undefined);
  assert.equal(paidOnProblem('2030-10-14', '2031-01-13'), 'At most 90 days ago.');
  assert.equal(paidOnProblem('', '2031-01-13'), 'Pick a day.');
});
