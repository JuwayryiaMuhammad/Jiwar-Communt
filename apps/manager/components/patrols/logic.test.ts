import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moved, patrolScheduleText, positionFrom, progressText, timesFrom } from './logic.ts';

test('a schedule in words; none is unscheduled', () => {
  assert.equal(patrolScheduleText({ days: [3, 1], times: ['22:00', '08:00'] }), 'Mon, Wed at 08:00, 22:00');
  assert.equal(patrolScheduleText({ days: [0, 1, 2, 3, 4, 5, 6], times: ['03:00'] }), 'Every day at 03:00');
  assert.equal(patrolScheduleText(null), 'Unscheduled');
});

test('start times from the form, sorted, once each; anything else is refused', () => {
  assert.deepEqual(timesFrom('22:00, 08:00 08:00'), ['08:00', '22:00']);
  assert.equal(timesFrom('8:00'), null);
  assert.equal(timesFrom(''), null);
  assert.equal(timesFrom('24:00'), null);
});

test('a position from the form: both or none, in range', () => {
  assert.equal(positionFrom('', '', ''), null);
  assert.deepEqual(positionFrom('30.04', '31.23', ''), { lat: 30.04, lng: 31.23 });
  assert.deepEqual(positionFrom('30', '31', '80'), { lat: 30, lng: 31, radiusM: 80 });
  assert.equal(positionFrom('30', '', ''), 'invalid');
  assert.equal(positionFrom('91', '31', ''), 'invalid');
  assert.equal(positionFrom('30', '31', '4'), 'invalid');
});

test('a run’s progress', () => {
  assert.equal(progressText({ scannedCount: 3, checkpointsTotal: 5 }), '3 / 5');
});

test('a checkpoint moved up or down the walk, never off it', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moved(['a', 'b'], 0, -1), ['a', 'b']);
});
