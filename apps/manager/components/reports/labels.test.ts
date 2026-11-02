import assert from 'node:assert/strict';
import { test } from 'node:test';
import { change } from './labels.ts';

test('a change in percent, none from nothing (ADR 0086)', () => {
  assert.equal(change('150', '100'), '50.0%');
  assert.equal(change('50', '200'), '-75.0%');
  assert.equal(change('5', '0'), null);
  assert.equal(change(null, '1'), null);
});
