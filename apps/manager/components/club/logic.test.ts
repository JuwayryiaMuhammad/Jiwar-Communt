import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/money-club.ts';
import en from '../../messages/en/money-club.ts';
import { coverageBody, durationText, paidOnProblem, sameSelection } from './logic.ts';

const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);

test('a plan reads as its duration, in either language', () => {
  assert.equal(durationText({ durationKind: 'monthly', durationDays: null }, tEn), 'Monthly');
  assert.equal(durationText({ durationKind: 'custom', durationDays: 45 }, tEn), '45 days');
  assert.equal(durationText({ durationKind: 'custom', durationDays: 1 }, tEn), '1 day');
  assert.equal(durationText({ durationKind: 'annual', durationDays: null }, tAr), 'سنوي');
  assert.equal(durationText({ durationKind: 'custom', durationDays: 45 }, tAr), '45 يومًا');
});

test('coverage is sent by kind and id; a selection compares whatever its order', () => {
  assert.deepEqual(coverageBody([{ kind: 'occupancy', id: 'a' }, { kind: 'member', id: 'b' }]), [{ occupancyId: 'a' }, { memberId: 'b' }]);
  assert.equal(sameSelection([{ kind: 'member', id: 'b' }, { kind: 'occupancy', id: 'a' }], [{ kind: 'occupancy', id: 'a' }, { kind: 'member', id: 'b' }]), true);
  assert.equal(sameSelection([{ kind: 'member', id: 'b' }], []), false);
});

test('a payment was made in the last 90 days, not ahead', () => {
  assert.equal(paidOnProblem('2031-01-13', '2031-01-13'), undefined);
  assert.equal(paidOnProblem('2031-01-14', '2031-01-13'), 'future');
  assert.equal(paidOnProblem('2030-10-15', '2031-01-13'), undefined);
  assert.equal(paidOnProblem('2030-10-14', '2031-01-13'), 'tooOld');
  assert.equal(paidOnProblem('', '2031-01-13'), 'pickDay');
  assert.equal(tEn(`paidOn.${paidOnProblem('2031-01-14', '2031-01-13')!}`), 'Not in the future.');
  assert.equal(tAr(`paidOn.${paidOnProblem('2030-10-14', '2031-01-13')!}`), 'خلال 90 يومًا على الأكثر.');
});
