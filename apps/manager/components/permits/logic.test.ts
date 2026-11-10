import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFormat, stripIsolates, translator } from '@jiwar/i18n/core';
import ar from '../../messages/ar/places-permits.ts';
import en from '../../messages/en/places-permits.ts';
import { addDayOff, describeDays, periodText, PERMIT_KINDS, toggleDay, validHours, validTime } from './logic.ts';

const fmtEn = createFormat('en');
const fmtAr = createFormat('ar');
const tEn = translator('en', en, ar);
const tAr = translator('ar', en, ar);

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
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6], fmtEn, tEn), 'Every day');
  assert.equal(describeDays([0, 4, 6], fmtEn, tEn), 'Sun, Thu, Sat');
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6], fmtAr, tAr), 'كل يوم');
  assert.equal(describeDays([4, 5], fmtAr, tAr), `${fmtAr.weekday(4, 'short')}، ${fmtAr.weekday(5, 'short')}`);
});

test('days off: well formed, once, in order', () => {
  assert.deepEqual(addDayOff(['2026-12-25'], '2026-11-01'), ['2026-11-01', '2026-12-25']);
  assert.deepEqual(addDayOff(['2026-12-25'], '2026-12-25'), ['2026-12-25']);
  assert.equal(addDayOff([], '2026-13-01'), null);
});

test('a permit’s period in one line', () => {
  const base = { startsAt: '2026-11-01T07:00:00.000Z', endsAt: '2026-11-01T10:00:00.000Z' };
  const works = {
    ...base,
    kind: 'works',
    works: { startsOn: '2026-11-01', endsOn: '2026-11-03', dailyHours: { from: '09:00', to: '17:00' } },
  };
  assert.equal(stripIsolates(periodText(works, fmtEn, tEn)), '01 Nov 2026 → 03 Nov 2026, 09:00–17:00');
  assert.match(stripIsolates(periodText(works, fmtAr, tAr)), /^من .+ إلى .+، 09:00–17:00$/);
  assert.equal(
    stripIsolates(periodText({ ...base, kind: 'move', move: { date: '2026-11-01', window: { from: '10:00', to: '12:00' } } }, fmtEn, tEn)),
    '01 Nov 2026, 10:00–12:00',
  );
  assert.equal(
    periodText({ ...base, kind: 'material_exit', materialExit: { validFrom: '2026-11-01', validUntil: '2026-11-01' } }, fmtEn, tEn),
    '01 Nov 2026',
  );
  assert.equal(
    stripIsolates(periodText({ ...base, kind: 'event' }, fmtEn, tEn)),
    `${fmtEn.dateTime(base.startsAt)} → ${fmtEn.dateTime(base.endsAt)}`,
  );
});

test('every kind has its words', () => {
  for (const k of PERMIT_KINDS) assert.ok(en[`kind.${k}`] && ar[`kind.${k}`], k);
});
