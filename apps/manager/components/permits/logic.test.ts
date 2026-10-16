import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDayOff, describeDays, periodText, toggleDay, validHours, validTime } from './logic.ts';

test('times of day and hours', () => {
  assert.equal(validTime('09:00'), true);
  assert.equal(validTime('24:00'), false);
  assert.equal(validTime('9:00'), false);
  assert.equal(validHours('09:00', '17:00'), true);
  assert.equal(validHours('17:00', '09:00'), false);
  assert.equal(validHours('09:00', '09:00'), false);
});

test('work days toggle, sorted, once each', () => {
  assert.deepEqual(toggleDay([0, 1, 2], 1), [0, 2]);
  assert.deepEqual(toggleDay([4, 0], 6), [0, 4, 6]);
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(describeDays([0, 4, 6]), 'Sun, Thu, Sat');
});

test('days off: well formed, once, in order', () => {
  assert.deepEqual(addDayOff(['2026-12-25'], '2026-11-01'), ['2026-11-01', '2026-12-25']);
  assert.deepEqual(addDayOff(['2026-12-25'], '2026-12-25'), ['2026-12-25']);
  assert.equal(addDayOff([], '2026-13-01'), null);
});

test('a permit’s period in one line', () => {
  const at = (iso: string) => iso;
  const base = { startsAt: '2026-11-01T07:00:00.000Z', endsAt: '2026-11-01T10:00:00.000Z' };
  assert.equal(
    periodText({ ...base, kind: 'works', works: { startsOn: '2026-11-01', endsOn: '2026-11-03', dailyHours: { from: '09:00', to: '17:00' } } }, at),
    '2026-11-01 → 2026-11-03, 09:00–17:00',
  );
  assert.equal(periodText({ ...base, kind: 'move', move: { date: '2026-11-01', window: { from: '10:00', to: '12:00' } } }, at), '2026-11-01, 10:00–12:00');
  assert.equal(
    periodText({ ...base, kind: 'material_exit', materialExit: { validFrom: '2026-11-01', validUntil: '2026-11-01' } }, at),
    '2026-11-01',
  );
  assert.equal(periodText({ ...base, kind: 'event' }, at), '2026-11-01T07:00:00.000Z → 2026-11-01T10:00:00.000Z');
});
