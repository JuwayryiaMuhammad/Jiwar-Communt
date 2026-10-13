import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inSchedule, passState, zonedClock, type PassView } from './pass-status.ts';

const pass = (over: Partial<PassView> = {}): PassView => ({
  compoundName: 'Nile Gardens',
  unitCode: 'A-101',
  kind: 'one_time',
  partySize: 2,
  validFrom: '2026-10-13T08:00:00.000Z',
  validUntil: '2026-10-13T20:00:00.000Z',
  timeZone: 'Africa/Cairo',
  schedule: null,
  status: 'active',
  statusReason: null,
  code: '123456',
  qrPayload: 'JWR1.x',
  visitorDirections: null,
  emergencyPhone: null,
  ...over,
});

test('the API status wins, with the reason of a cancellation', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  assert.equal(passState(pass({ status: 'used' }), now), 'used');
  assert.equal(passState(pass({ status: 'expired' }), now), 'expired');
  assert.equal(passState(pass({ status: 'cancelled', statusReason: 'host_cancelled' }), now), 'cancelled_host');
  assert.equal(passState(pass({ status: 'cancelled', statusReason: 'wrong_recipient' }), now), 'cancelled_wrong');
  assert.equal(passState(pass({ status: 'cancelled' }), now), 'cancelled');
});

test('an active pass before its window has not started', () => {
  assert.equal(passState(pass(), new Date('2026-10-13T07:59:59Z')), 'not_yet');
  assert.equal(passState(pass(), new Date('2026-10-13T08:00:00Z')), 'active');
});

test('the clock is read in the compound zone, not the browser one', () => {
  // Tuesday 22:30 UTC is already Wednesday in Cairo (UTC+2 or +3).
  const clock = zonedClock(new Date('2026-10-13T22:30:00Z'), 'Africa/Cairo');
  assert.ok(clock);
  assert.equal(clock.day, 3);
  assert.equal(zonedClock(new Date('2026-01-06T10:15:00Z'), 'UTC')?.minutes, 615);
  assert.equal(zonedClock(new Date(), 'Not/AZone'), null);
});

test('a day window is from inclusive, to exclusive, on listed days', () => {
  const schedule = { days: [2], windows: [{ from: '09:00', to: '17:00' }] };
  // Tuesday 2026-01-06 in UTC.
  assert.equal(inSchedule(schedule, new Date('2026-01-06T09:00:00Z'), 'UTC'), true);
  assert.equal(inSchedule(schedule, new Date('2026-01-06T16:59:00Z'), 'UTC'), true);
  assert.equal(inSchedule(schedule, new Date('2026-01-06T17:00:00Z'), 'UTC'), false);
  assert.equal(inSchedule(schedule, new Date('2026-01-06T08:59:00Z'), 'UTC'), false);
  assert.equal(inSchedule(schedule, new Date('2026-01-07T10:00:00Z'), 'UTC'), false);
});

test('an overnight window belongs to the day it starts', () => {
  const schedule = { days: [2], windows: [{ from: '22:00', to: '02:00' }] };
  assert.equal(inSchedule(schedule, new Date('2026-01-06T23:00:00Z'), 'UTC'), true);
  assert.equal(inSchedule(schedule, new Date('2026-01-07T01:59:00Z'), 'UTC'), true);
  assert.equal(inSchedule(schedule, new Date('2026-01-07T02:00:00Z'), 'UTC'), false);
  // Tuesday 01:00 is Monday's night, and Monday is not listed.
  assert.equal(inSchedule(schedule, new Date('2026-01-06T01:00:00Z'), 'UTC'), false);
  assert.equal(inSchedule(schedule, new Date('2026-01-07T23:00:00Z'), 'UTC'), false);
});

test('an active recurring pass outside its hours says so', () => {
  const recurring = pass({
    kind: 'recurring',
    timeZone: 'UTC',
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2026-03-01T00:00:00Z',
    schedule: { days: [2], windows: [{ from: '09:00', to: '17:00' }] },
  });
  assert.equal(passState(recurring, new Date('2026-01-06T10:00:00Z')), 'active');
  assert.equal(passState(recurring, new Date('2026-01-06T18:00:00Z')), 'outside_schedule');
  assert.equal(passState({ ...recurring, timeZone: 'Not/AZone' }, new Date('2026-01-06T18:00:00Z')), 'active');
});
