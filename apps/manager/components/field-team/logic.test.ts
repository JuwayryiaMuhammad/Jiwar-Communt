import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ringStep } from './logic.ts';

test('the plot’s rings grow with the point’s accuracy and stay inside the known steps', () => {
  assert.equal(ringStep(null), 10);
  assert.equal(ringStep(0), 10);
  assert.equal(ringStep(30), 10);
  assert.equal(ringStep(31), 25);
  assert.equal(ringStep(65), 25);
  assert.equal(ringStep(300), 100);
  assert.equal(ringStep(3000), 1000);
  assert.equal(ringStep(10_000_000), 50000);
});
