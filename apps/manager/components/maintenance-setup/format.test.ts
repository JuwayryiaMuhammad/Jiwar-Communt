import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/ms-common.ts';
import en from '../../messages/en/ms-common.ts';
import { formatClock, formatMinutes, KEY_PATTERN, suggestKey } from './format.ts';

const t = translator('en', en, ar);
const tAr = translator('ar', en, ar);

test('minutes read as days, hours and minutes', () => {
  assert.equal(formatMinutes(5, t), '5 min');
  assert.equal(formatMinutes(90, t), '1 h 30 min');
  assert.equal(formatMinutes(1440, t), '1 d');
  assert.equal(formatMinutes(10080, t), '7 d');
  assert.equal(formatMinutes(1500, t), '1 d 1 h');
  assert.equal(formatMinutes(0, t), '0 min');
  assert.equal(formatMinutes(Number.NaN, t), '—');
  assert.equal(formatMinutes(90, tAr), '1 ساعة 30 دقيقة');
});

test('minutes after midnight read as a clock, the end of the day as 24:00', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(540), '09:00');
  assert.equal(formatClock(1050), '17:30');
  assert.equal(formatClock(1440), '24:00');
});

test('a suggested key matches the API pattern, or is empty', () => {
  for (const name of ['Water heater', 'A/C units', '  Pool  ', 'HVAC 2', 'x'.repeat(80)]) {
    assert.match(suggestKey(name), KEY_PATTERN, name);
  }
  assert.equal(suggestKey('Water heater'), 'water_heater');
  assert.equal(suggestKey('2 pumps'), 'pumps');
  // Arabic only: nothing to suggest, the manager types the code.
  assert.equal(suggestKey('سباكة'), '');
});
