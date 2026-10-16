import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, minutesText, personName, postBody, postName, scheduleFrom, scheduleText } from './logic.ts';

test('a post is named by its gate, else its zone', () => {
  assert.equal(postName({ gateName: 'North', zone: null }), 'North');
  assert.equal(postName({ gateName: null, zone: { nameEn: 'Clubhouse' } }), 'Clubhouse');
  assert.equal(postName(null), '—');
});

test('a person, or the erased shape', () => {
  assert.equal(personName({ fullName: 'Omar Adel' }), 'Omar Adel');
  assert.equal(personName({ erased: true }), 'An erased account');
  assert.equal(personName(null), '—');
});

test('a schedule in words, an overnight window said so', () => {
  assert.equal(scheduleText({ days: [4, 0], windows: [{ from: '22:00', to: '06:00' }] }), 'Sun, Thu 22:00–06:00 (overnight)');
  assert.equal(scheduleText({ days: [1], windows: [{ from: '06:00', to: '14:00' }] }), 'Mon 06:00–14:00');
});

test('minutes in hours and minutes', () => {
  assert.equal(minutesText(90), '1 h 30 min');
  assert.equal(minutesText(45), '45 min');
  assert.equal(minutesText(120), '2 h');
  assert.equal(minutesText(null), '—');
});

test('days move across months', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
});

test('a schedule from the form: days and a window, or nothing', () => {
  assert.deepEqual(scheduleFrom([3, 1, 3], '06:00', '14:00'), { days: [1, 3], windows: [{ from: '06:00', to: '14:00' }] });
  assert.equal(scheduleFrom([], '06:00', '14:00'), null);
  assert.equal(scheduleFrom([1], '06:00', '06:00'), null);
  assert.equal(scheduleFrom([1], '6:00', '14:00'), null);
});

test('a post picker value becomes the body’s gate or zone', () => {
  assert.deepEqual(postBody('gate:abc'), { gateId: 'abc' });
  assert.deepEqual(postBody('zone:def'), { zoneId: 'def' });
  assert.equal(postBody(''), null);
  assert.equal(postBody('other:x'), null);
});
