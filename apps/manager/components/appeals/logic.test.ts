import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decisionLine,
  EFFECT_REASON_TEXT,
  KIND_TEXT,
  needsSticker,
  subjectHref,
} from './logic.ts';

test('the four kinds and the thirteen reasons of ADR 0059', () => {
  assert.deepEqual(Object.keys(KIND_TEXT), [
    'permit_rejection',
    'vehicle_rejection',
    'worker_rejection',
    'neighbour_notice',
  ]);
  assert.equal(Object.keys(EFFECT_REASON_TEXT).length, 13);
});

test('only a vehicle overturned asks for a sticker', () => {
  assert.equal(needsSticker('vehicle_rejection', 'overturned'), true);
  assert.equal(needsSticker('vehicle_rejection', 'upheld'), false);
  assert.equal(needsSticker('permit_rejection', 'overturned'), false);
});

test('an overturn left to follow up says which check refused it', () => {
  assert.equal(
    decisionLine({ outcome: 'overturned', effect: 'follow_up', effectReason: 'unit_limit' }),
    'Overturned · For the management to follow up: the unit is at its limit',
  );
  assert.equal(
    decisionLine({ outcome: 'upheld', effect: 'none', effectReason: null }),
    'Upheld: the decision stands',
  );
});

test('a permit opens on its page, a vehicle in the list; the rest nowhere', () => {
  assert.equal(subjectHref('permit_rejection', 'p1'), '/permits/p1');
  assert.equal(subjectHref('vehicle_rejection', 'v1'), '/vehicles');
  assert.equal(subjectHref('worker_rejection', 'w1'), null);
});
